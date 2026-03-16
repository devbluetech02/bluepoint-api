import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { 
  extractFaceEncoding, 
  bufferToEncoding, 
  encodingToBuffer,
  findBestMatchGeneric, 
  calcularThresholdDinamico,
  verificarDiversidade,
  verificarCondicoesAutoAprendizado,
} from '@/lib/face-recognition';
import { generateToken, generateRefreshToken } from '@/lib/auth';
import { cacheGet, cacheSet, cacheDel, cacheDelPattern, checkRateLimit, invalidateMarcacaoCache, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { verificarEAplicarToleranciaHoraExtra, verificarEAplicarToleranciaHoraExtraEntrada } from '@/lib/hora-extra-tolerancia';
import {
  obterJornadaDoDia,
  obterParametrosTolerancia,
  analisarAtraso,
  registrarAtrasoTolerado,
} from '@/lib/tolerancia-atraso';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { z } from 'zod';

const verificarFaceSchema = z.object({
  imagem: z.string().min(100, 'Imagem inválida'),
  // Campos opcionais para dispositivo autorizado
  dispositivoCodigo: z.string().length(6).toUpperCase().optional(),
  registrarPonto: z.boolean().optional().default(false),
  tipoPonto: z.enum(['entrada', 'saida', 'almoco', 'retorno']).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

// Interface para encoding cacheado
interface CachedEncoding {
  colaboradorId: number | null;
  externalIds: Record<string, string>;
  encoding: number[];
  encodingsExtras: number[][];
  encodingsAprendidos: number[][];
  qualidadesAprendidos: number[];
  totalAprendidos: number;
}

// Interface para dispositivo
interface Dispositivo {
  id: number;
  nome: string;
  status: string;
  permite_entrada: boolean;
  permite_saida: boolean;
  requer_foto: boolean;
  requer_geolocalizacao: boolean;
  empresa_id: number | null;
  localizacao_id: number | null;
}


// Response helpers com headers padronizados
function jsonResponse(data: object, status: number = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

// Valida dispositivo
async function validarDispositivo(codigo: string): Promise<{ valido: boolean; dispositivo?: Dispositivo; erro?: string; code?: string }> {
  const result = await query(
    `SELECT id, nome, status, permite_entrada, permite_saida, 
            requer_foto, requer_geolocalizacao, empresa_id, localizacao_id
     FROM bluepoint.bt_dispositivos WHERE codigo = $1`,
    [codigo]
  );

  if (result.rows.length === 0) {
    return { valido: false, erro: 'Dispositivo não autorizado', code: 'DEVICE_NOT_FOUND' };
  }

  const dispositivo = result.rows[0] as Dispositivo;

  if (dispositivo.status === 'inativo') {
    return { valido: false, erro: 'Dispositivo inativo', code: 'DEVICE_INACTIVE' };
  }

  if (dispositivo.status === 'bloqueado') {
    return { valido: false, erro: 'Dispositivo bloqueado', code: 'DEVICE_BLOCKED' };
  }

  return { valido: true, dispositivo };
}

// Detecta automaticamente o tipo de ponto com suporte a almoço/retorno
// Sequência de um dia completo: entrada → almoco → retorno → saida
async function detectarTipoPonto(colaboradorId: number): Promise<'entrada' | 'saida' | 'almoco' | 'retorno'> {
  try {
    // Buscar todas as marcações do colaborador no dia atual
    const result = await query(
      `SELECT tipo FROM bluepoint.bt_marcacoes 
       WHERE colaborador_id = $1 
         AND DATE(data_hora) = CURRENT_DATE
       ORDER BY data_hora ASC`,
      [colaboradorId]
    );

    if (result.rows.length === 0) {
      // Sem marcação no dia → entrada
      return 'entrada';
    }

    const marcacoes = result.rows;
    const ultimoTipo = marcacoes[marcacoes.length - 1].tipo;
    const jaTeveAlmoco = marcacoes.some((m) => m.tipo === 'almoco');
    const jaTeveRetorno = marcacoes.some((m) => m.tipo === 'retorno');

    // Lógica de sequência automática:
    // entrada → almoco → retorno → saida
    if (ultimoTipo === 'entrada' && !jaTeveAlmoco) {
      return 'almoco';
    }
    if (ultimoTipo === 'almoco' && !jaTeveRetorno) {
      return 'retorno';
    }
    if (ultimoTipo === 'retorno') {
      return 'saida';
    }
    if (ultimoTipo === 'saida') {
      // Fluxo completo já finalizado com saída; não reiniciar com nova entrada automática
      return 'saida';
    }

    // Fallback: alterna entre entrada e saída, mas nunca reinicia como entrada
    // se já houve uma saída registrada no dia.
    const jaTeveSaida = marcacoes.some((m) => m.tipo === 'saida');
    if (jaTeveSaida) {
      return 'saida';
    }
    return (ultimoTipo === 'entrada' || ultimoTipo === 'retorno') ? 'saida' : 'entrada';
  } catch (error) {
    console.error('Erro ao detectar tipo de ponto:', error);
    // Em caso de erro, assume entrada
    return 'entrada';
  }
}

// Conta marcações do dia
async function contarMarcacoesDia(colaboradorId: number): Promise<number> {
  try {
    const result = await query(
      `SELECT COUNT(*) FROM bluepoint.bt_marcacoes 
       WHERE colaborador_id = $1 
         AND DATE(data_hora) = CURRENT_DATE`,
      [colaboradorId]
    );
    return parseInt(result.rows[0].count);
  } catch {
    return 0;
  }
}

// Registra ponto
async function registrarPonto(
  colaboradorId: number,
  tipo: 'entrada' | 'saida' | 'almoco' | 'retorno',
  dispositivo: Dispositivo,
  latitude?: number,
  longitude?: number,
  clientIp?: string
): Promise<{ sucesso: boolean; marcacaoId?: number; tipo?: 'entrada' | 'saida' | 'almoco' | 'retorno'; sequencia?: number; erro?: string }> {
  try {
    // Verificar permissão do dispositivo
    // entrada e retorno são tipos de "entrada"; almoco e saida são tipos de "saída"
    if ((tipo === 'entrada' || tipo === 'retorno') && !dispositivo.permite_entrada) {
      return { sucesso: false, erro: 'Dispositivo não permite registro de entrada' };
    }
    if ((tipo === 'saida' || tipo === 'almoco') && !dispositivo.permite_saida) {
      return { sucesso: false, erro: 'Dispositivo não permite registro de saída' };
    }

    // Contar sequência
    const sequencia = await contarMarcacoesDia(colaboradorId) + 1;

    // Inserir marcação
    const result = await query(
      `INSERT INTO bluepoint.bt_marcacoes (
        colaborador_id, data_hora, tipo, latitude, longitude,
        metodo, dispositivo_id, empresa_id, criado_em
      ) VALUES ($1, NOW(), $2, $3, $4, 'biometria', $5, $6, NOW())
      RETURNING id`,
      [
        colaboradorId,
        tipo,
        latitude || null,
        longitude || null,
        dispositivo.id,
        dispositivo.empresa_id,
      ]
    );

    // Atualizar contador do dispositivo
    await query(
      `UPDATE bluepoint.bt_dispositivos SET 
        total_registros = total_registros + 1,
        ultimo_acesso = NOW(),
        ip_ultimo_acesso = $1
      WHERE id = $2`,
      [clientIp || null, dispositivo.id]
    );

    const marcacaoId = result.rows[0].id;

    // Invalidar cache de marcações para que listagens reflitam o novo registro
    await invalidateMarcacaoCache(colaboradorId);
    await cacheDelPattern(`${CACHE_KEYS.ATRASOS_TOLERADOS}*`);

    embedTableRowAfterInsert('bt_marcacoes', marcacaoId).catch(() => {});

    return { sucesso: true, marcacaoId, tipo, sequencia };
  } catch (error) {
    console.error('Erro ao registrar ponto:', error);
    return { sucesso: false, erro: 'Erro ao registrar ponto' };
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const clientIp = getClientIp(request);
  
  try {
    // Rate limiting: 60 requisições por minuto por IP
    const rateLimit = await checkRateLimit(`biometria:verificar:${clientIp}`, 60, 60);
    
    const rateLimitHeaders = {
      'X-RateLimit-Limit': '60',
      'X-RateLimit-Remaining': rateLimit.remaining.toString(),
      'X-RateLimit-Reset': rateLimit.resetIn.toString(),
    };

    if (!rateLimit.allowed) {
      return jsonResponse({
        success: false,
        error: 'Limite de requisições excedido. Tente novamente em alguns segundos.',
        code: 'RATE_LIMIT_EXCEEDED',
      }, 429, rateLimitHeaders);
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({
        success: false,
        error: 'JSON inválido',
        code: 'INVALID_JSON',
      }, 400, rateLimitHeaders);
    }
    
    // Validar request
    const validation = verificarFaceSchema.safeParse(body);
    if (!validation.success) {
      return jsonResponse({
        success: false,
        error: 'Erro de validação',
        code: 'VALIDATION_ERROR',
        details: validation.error.issues.map(i => ({
          field: i.path.join('.') || 'imagem',
          message: i.message,
        })),
      }, 422, rateLimitHeaders);
    }

    const { imagem, dispositivoCodigo, registrarPonto: deveRegistrarPonto, tipoPonto, latitude, longitude } = validation.data;

    // Se for registrar ponto, validar dispositivo primeiro
    let dispositivo: Dispositivo | undefined;
    if (dispositivoCodigo) {
      const validacao = await validarDispositivo(dispositivoCodigo);
      if (!validacao.valido) {
        return jsonResponse({
          success: false,
          error: validacao.erro,
          code: validacao.code,
        }, 403, rateLimitHeaders);
      }
      dispositivo = validacao.dispositivo;

      // Se requer geolocalização, verificar
      if (dispositivo?.requer_geolocalizacao && (!latitude || !longitude)) {
        return jsonResponse({
          success: false,
          error: 'Este dispositivo requer geolocalização',
          code: 'GEOLOCATION_REQUIRED',
        }, 400, rateLimitHeaders);
      }
    }

    // Extrair encoding da imagem enviada via InsightFace/ArcFace
    const extractStart = Date.now();
    const { 
      encoding, 
      qualidade, 
      qualidadeDetalhada,
      error 
    } = await extractFaceEncoding(imagem);
    console.log(`[Verificar Face] Extração: ${Date.now() - extractStart}ms`);

    if (!encoding || error) {
      return jsonResponse({
        success: false,
        error: error || 'Não foi possível detectar a face na imagem',
        code: 'FACE_NOT_DETECTED',
        dica: 'Certifique-se de que o rosto está bem iluminado, centralizado e visível na câmera.',
      }, 400, rateLimitHeaders);
    }

    // Threshold mínimo de qualidade - aceita qualidade mais baixa para câmeras inferiores
    if (qualidade < 0.15) {
      return jsonResponse({
        success: false,
        error: 'Qualidade da imagem muito baixa para identificação segura',
        code: 'LOW_QUALITY',
        qualidade,
        qualidadeDetalhada,
        dica: 'Melhore a iluminação, aproxime o rosto da câmera e mantenha-o centralizado.',
      }, 400, rateLimitHeaders);
    }

    // Usar threshold dinâmico baseado na qualidade (ArcFace é muito mais estável)
    const thresholdEfetivo = calcularThresholdDinamico(qualidade);
    
    console.log(`[Verificar Face] Qualidade: ${qualidade}, Threshold: ${thresholdEfetivo.toFixed(3)}`);

    // Buscar encodings do cache ou banco
    const cacheStart = Date.now();
    let encodings: CachedEncoding[] | null = await cacheGet<CachedEncoding[]>(CACHE_KEYS.BIOMETRIA_ENCODINGS);
    
    if (!encodings) {
      console.log('[Verificar Face] Cache MISS - buscando do banco...');
      const encodingsResult = await query(
        `SELECT bf.colaborador_id, bf.external_id, bf.encoding, bf.encodings_extras,
                bf.encodings_aprendidos, bf.qualidades_aprendidos, bf.total_aprendidos
         FROM bluepoint.bt_biometria_facial bf
         LEFT JOIN bluepoint.bt_colaboradores c ON bf.colaborador_id = c.id
         WHERE bf.encoding IS NOT NULL
           AND (
             bf.external_id IS NOT NULL 
             OR (bf.colaborador_id IS NOT NULL AND c.status = 'ativo')
           )`
      );

      if (encodingsResult.rows.length === 0) {
        return jsonResponse({
          success: true,
          data: {
            identificado: false,
            tipo: null,
            colaboradorId: null,
            externalId: null,
            colaborador: null,
            confianca: 0,
            token: null,
            refreshToken: null,
            pontoRegistrado: null,
            mensagem: 'Nenhuma face cadastrada no sistema',
            code: 'NO_FACES_REGISTERED',
            processedIn: Date.now() - startTime,
          },
        }, 200, rateLimitHeaders);
      }

      encodings = encodingsResult.rows.map(row => {
        // Converter encodings extras de BYTEA[] para number[][]
        const extras: number[][] = [];
        if (row.encodings_extras && Array.isArray(row.encodings_extras)) {
          for (const extraBuf of row.encodings_extras) {
            try {
              const buf = Buffer.isBuffer(extraBuf) ? extraBuf : Buffer.from(extraBuf);
              extras.push(Array.from(bufferToEncoding(buf)));
            } catch (e) {
              console.warn('[Verificar Face] Erro ao converter encoding extra:', e);
            }
          }
        }
        // Converter encodings aprendidos de BYTEA[] para number[][]
        const aprendidos: number[][] = [];
        if (row.encodings_aprendidos && Array.isArray(row.encodings_aprendidos)) {
          for (const aprendidoBuf of row.encodings_aprendidos) {
            try {
              const buf = Buffer.isBuffer(aprendidoBuf) ? aprendidoBuf : Buffer.from(aprendidoBuf);
              aprendidos.push(Array.from(bufferToEncoding(buf)));
            } catch (e) {
              console.warn('[Verificar Face] Erro ao converter encoding aprendido:', e);
            }
          }
        }
        // Converter qualidades aprendidos
        const qualidadesAprendidos: number[] = [];
        if (row.qualidades_aprendidos && Array.isArray(row.qualidades_aprendidos)) {
          for (const q of row.qualidades_aprendidos) {
            qualidadesAprendidos.push(parseFloat(q) || 0);
          }
        }
        return {
          colaboradorId: row.colaborador_id as number | null,
          externalIds: row.external_id as Record<string, string> || {},
          encoding: Array.from(bufferToEncoding(row.encoding)),
          encodingsExtras: extras,
          encodingsAprendidos: aprendidos,
          qualidadesAprendidos: qualidadesAprendidos,
          totalAprendidos: row.total_aprendidos || 0,
        };
      });

      // Cache por 1 hora - encodings não mudam frequentemente
      await cacheSet(CACHE_KEYS.BIOMETRIA_ENCODINGS, encodings, CACHE_TTL.LONG);
      console.log(`[Verificar Face] Banco: ${Date.now() - cacheStart}ms, ${encodings.length} encodings`);
    } else {
      console.log(`[Verificar Face] Cache HIT: ${Date.now() - cacheStart}ms, ${encodings.length} encodings`);
    }

    // Converter encodings de volta para Float32Array
    // Inclui encoding principal + extras + aprendidos como entradas separadas (mesmo colaborador)
    const encodingsFloat: Array<{
      colaboradorId: number | null;
      externalIds: Record<string, string>;
      encoding: Float32Array;
    }> = [];
    
    let totalAprendidosUsados = 0;
    
    for (const e of encodings) {
      // Encoding principal
      encodingsFloat.push({
        colaboradorId: e.colaboradorId,
        externalIds: e.externalIds,
        encoding: new Float32Array(e.encoding),
      });
      // Encodings extras (câmeras diferentes, condições diferentes)
      if (e.encodingsExtras && Array.isArray(e.encodingsExtras)) {
        for (const extra of e.encodingsExtras) {
          if (extra && Array.isArray(extra) && extra.length > 0) {
            encodingsFloat.push({
              colaboradorId: e.colaboradorId,
              externalIds: e.externalIds,
              encoding: new Float32Array(extra),
            });
          }
        }
      }
      // Encodings aprendidos (auto-aprendizado de reconhecimentos anteriores)
      if (e.encodingsAprendidos && Array.isArray(e.encodingsAprendidos)) {
        for (const aprendido of e.encodingsAprendidos) {
          if (aprendido && Array.isArray(aprendido) && aprendido.length > 0) {
            encodingsFloat.push({
              colaboradorId: e.colaboradorId,
              externalIds: e.externalIds,
              encoding: new Float32Array(aprendido),
            });
            totalAprendidosUsados++;
          }
        }
      }
    }
    
    console.log(`[Verificar Face] Total encodings para comparação: ${encodingsFloat.length} (de ${encodings.length} registros, ${totalAprendidosUsados} aprendidos)`);

    // Encontrar melhor match usando threshold dinâmico
    const matchStart = Date.now();
    const matchResult = await findBestMatchGeneric(encoding, encodingsFloat, thresholdEfetivo);
    
    console.log(`[Verificar Face] Comparação: ${Date.now() - matchStart}ms`);

    if (!matchResult) {
      return jsonResponse({
        success: true,
        data: {
          identificado: false,
          tipo: null,
          colaboradorId: null,
          externalId: null,
          colaborador: null,
          confianca: 0,
          token: null,
          refreshToken: null,
          pontoRegistrado: null,
          mensagem: 'Nenhum usuário identificado. Tente melhorar a iluminação ou aproximar o rosto.',
          code: 'NOT_IDENTIFIED',
          qualidadeCaptura: qualidade,
          thresholdUtilizado: thresholdEfetivo,
          dica: qualidade < 0.5 
            ? 'A qualidade da imagem está muito baixa. Melhore a iluminação e centralize o rosto.'
            : 'Certifique-se de que o rosto está bem visível e centralizado.',
          processedIn: Date.now() - startTime,
        },
      }, 200, rateLimitHeaders);
    }

    const matchedRecord = matchResult.match;
    // Calcular confiança baseada no threshold utilizado
    const confianca = Math.round((1 - matchResult.distance / thresholdEfetivo) * 100) / 100;

    // ===============================================================
    // AUTO-APRENDIZADO: Salvar encoding do reconhecimento bem-sucedido
    // Isso melhora progressivamente a precisão ao capturar diferentes
    // ângulos, condições de iluminação e câmeras.
    // Roda em background (não bloqueia a resposta).
    // ===============================================================
    (async () => {
      try {
        // Encontrar o registro original no cache para verificar dados de aprendizado
        const registroOriginal = encodings?.find(e => 
          e.colaboradorId === matchedRecord.colaboradorId &&
          JSON.stringify(e.externalIds) === JSON.stringify(matchedRecord.externalIds)
        );

        if (!registroOriginal) {
          console.log('[Auto-Aprendizado] Registro original não encontrado no cache, pulando.');
          return;
        }

        // Verificar condições para auto-aprendizado
        const condicoes = verificarCondicoesAutoAprendizado(
          matchResult.distance,
          qualidade,
          registroOriginal.totalAprendidos
        );

        if (!condicoes.deveAprender) {
          console.log(`[Auto-Aprendizado] Não aprendendo: ${condicoes.motivo}`);
          return;
        }

        // Coletar TODOS os encodings existentes desta pessoa para verificar diversidade
        const todosEncodings: Float32Array[] = [
          new Float32Array(registroOriginal.encoding),
        ];
        for (const extra of registroOriginal.encodingsExtras) {
          if (extra && extra.length > 0) {
            todosEncodings.push(new Float32Array(extra));
          }
        }
        for (const aprendido of registroOriginal.encodingsAprendidos) {
          if (aprendido && aprendido.length > 0) {
            todosEncodings.push(new Float32Array(aprendido));
          }
        }

        // Verificar diversidade: o encoding atual traz informação nova?
        const diversidade = await verificarDiversidade(encoding, todosEncodings);
        
        if (!diversidade.diverso) {
          console.log(`[Auto-Aprendizado] Encoding muito similar ao existente (dist: ${diversidade.menorDistancia.toFixed(4)}), pulando.`);
          return;
        }

        // Encoding é diverso! Salvar como aprendido.
        const encodingBuffer = encodingToBuffer(encoding);

        // Buscar o ID do registro no banco para o UPDATE
        let bioId: number | null = null;
        if (matchedRecord.colaboradorId) {
          const bioResult = await query(
            `SELECT id, total_aprendidos FROM bluepoint.bt_biometria_facial WHERE colaborador_id = $1`,
            [matchedRecord.colaboradorId]
          );
          if (bioResult.rows.length > 0) {
            bioId = bioResult.rows[0].id;
          }
        } else if (Object.keys(matchedRecord.externalIds || {}).length > 0) {
          const primeiroPrefixo = Object.keys(matchedRecord.externalIds)[0];
          const bioResult = await query(
            `SELECT id, total_aprendidos FROM bluepoint.bt_biometria_facial WHERE external_id ? $1`,
            [primeiroPrefixo]
          );
          if (bioResult.rows.length > 0) {
            bioId = bioResult.rows[0].id;
          }
        }

        if (!bioId) {
          console.log('[Auto-Aprendizado] ID do registro não encontrado no banco.');
          return;
        }

        // Adicionar encoding aprendido
        await query(
          `UPDATE bluepoint.bt_biometria_facial 
           SET encodings_aprendidos = array_append(encodings_aprendidos, $1),
               qualidades_aprendidos = array_append(qualidades_aprendidos, $2),
               total_aprendidos = total_aprendidos + 1,
               atualizado_em = NOW()
           WHERE id = $3`,
          [encodingBuffer, qualidade, bioId]
        );

        // Invalidar cache para que o novo encoding seja usado na próxima verificação
        await cacheDel(CACHE_KEYS.BIOMETRIA_ENCODINGS);

        console.log(`[Auto-Aprendizado] ✓ Encoding salvo! Pessoa: colab=${matchedRecord.colaboradorId || 'N/A'}, ` +
          `distância: ${matchResult.distance.toFixed(4)}, qualidade: ${qualidade.toFixed(2)}, ` +
          `diversidade: ${diversidade.menorDistancia.toFixed(4)}, total: ${registroOriginal.totalAprendidos + 1}`);
      } catch (autoLearnError) {
        // Erro no auto-aprendizado não deve afetar a resposta
        console.error('[Auto-Aprendizado] Erro (não crítico):', autoLearnError);
      }
    })();

    // Buscar dados completos da biometria (colaborador_id E external_ids)
    let biometriaCompleta: { colaborador_id: number | null; external_ids: Record<string, string> } | null = null;
    
    if (matchedRecord?.colaboradorId) {
      const bioResult = await query(
        `SELECT colaborador_id, external_id FROM bluepoint.bt_biometria_facial WHERE colaborador_id = $1`,
        [matchedRecord.colaboradorId]
      );
      if (bioResult.rows.length > 0) {
        biometriaCompleta = {
          colaborador_id: bioResult.rows[0].colaborador_id as number | null,
          external_ids: bioResult.rows[0].external_id as Record<string, string> || {},
        };
      }
    } else if (Object.keys(matchedRecord?.externalIds || {}).length > 0) {
      // Buscar pelo primeiro external_id encontrado
      const primeiroPrefixo = Object.keys(matchedRecord.externalIds)[0];
      const bioResult = await query(
        `SELECT colaborador_id, external_id FROM bluepoint.bt_biometria_facial WHERE external_id ? $1`,
        [primeiroPrefixo]
      );
      if (bioResult.rows.length > 0) {
        biometriaCompleta = {
          colaborador_id: bioResult.rows[0].colaborador_id as number | null,
          external_ids: bioResult.rows[0].external_id as Record<string, string> || {},
        };
      }
    }

    // IDs finais
    const colaboradorIdFinal = biometriaCompleta?.colaborador_id || matchedRecord?.colaboradorId || null;
    const externalIdsFinal = biometriaCompleta?.external_ids || matchedRecord?.externalIds || {};

    // Se não tem colaborador_id, é um registro puramente externo
    if (!colaboradorIdFinal) {
      // Para registros externos, usar o primeiro ID como identificador no token
      const primeiroPrefixo = Object.keys(externalIdsFinal)[0];
      const primeiroId = primeiroPrefixo ? `${primeiroPrefixo}_${externalIdsFinal[primeiroPrefixo]}` : 'unknown';

      // Gerar token genérico para registro externo
      const tokenPayload = {
        userId: 0, // ID 0 indica usuário externo
        email: `external-${primeiroId}@biometria`,
        tipo: 'externo',
        nome: `Externo: ${primeiroId}`,
      };

      const token = generateToken(tokenPayload);
      const refreshToken = generateRefreshToken();

      // Garantir que token foi gerado
      if (!token || !refreshToken) {
        return jsonResponse({
          success: false,
          error: 'Erro ao gerar token de autenticação',
          code: 'TOKEN_GENERATION_ERROR',
        }, 500, rateLimitHeaders);
      }

      return jsonResponse({
        success: true,
        data: {
          identificado: true,
          tipo: 'externo',
          colaboradorId: null,
          externalIds: externalIdsFinal,
          colaborador: null,
          confianca: Math.max(0, Math.min(1, confianca)),
          token,
          refreshToken,
          pontoRegistrado: null,
          processedIn: Date.now() - startTime,
        },
      }, 200, rateLimitHeaders);
    }

    // Se tem colaborador_id, busca dados do colaborador BluePoint
    const colaboradorResult = await query(
      `SELECT 
        c.id, c.nome, c.email, c.tipo, c.foto_url, c.cargo_id,
        cg.nome as cargo_nome,
        d.nome as departamento_nome
       FROM bluepoint.bt_colaboradores c
       LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
       LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
       WHERE c.id = $1`,
      [colaboradorIdFinal]
    );

    if (colaboradorResult.rows.length === 0) {
      return jsonResponse({
        success: false,
        error: 'Colaborador não encontrado',
        code: 'COLLABORATOR_NOT_FOUND',
      }, 404, rateLimitHeaders);
    }

    const colaborador = colaboradorResult.rows[0];

    // Gerar tokens JWT
    const tokenPayload = {
      userId: colaborador.id,
      email: colaborador.email,
      tipo: colaborador.tipo,
      nome: colaborador.nome,
    };

    const token = generateToken(tokenPayload);
    const refreshToken = generateRefreshToken();

    // Garantir que token foi gerado
    if (!token || !refreshToken) {
      return jsonResponse({
        success: false,
        error: 'Erro ao gerar token de autenticação',
        code: 'TOKEN_GENERATION_ERROR',
      }, 500, rateLimitHeaders);
    }

    // Se deve registrar ponto e tem dispositivo válido
    let pontoRegistrado = null;
    let atrasoInfo: {
      requerAprovacao: boolean;
      tipoMarcacao: string;
      atraso: Record<string, unknown>;
      mensagem: string;
    } | null = null;

    if (deveRegistrarPonto && dispositivo) {
      let tipoFinal: 'entrada' | 'saida' | 'almoco' | 'retorno';
      let tipoDetectado = false;

      if (tipoPonto) {
        tipoFinal = tipoPonto;
      } else {
        tipoFinal = await detectarTipoPonto(colaborador.id);
        tipoDetectado = true;
      }

      // Verificar tolerância de atraso (somente para ENTRADA)
      let analiseAtrasoResult: Awaited<ReturnType<typeof analisarAtraso>> | null = null;

      if (tipoFinal === 'entrada') {
        try {
          const jornada = await obterJornadaDoDia(colaborador.id);
          const parametros = await obterParametrosTolerancia();

          if (jornada && !jornada.folga && parametros.ativo) {
            const horarioPrevisto = jornada.periodos[0]?.entrada || null;
            const periodoIndex = 0;

            if (horarioPrevisto) {
              analiseAtrasoResult = await analisarAtraso(
                colaborador.id,
                parametros,
                tipoFinal,
                horarioPrevisto,
                periodoIndex
              );

              if (analiseAtrasoResult.atrasado && !analiseAtrasoResult.registrarNormalmente) {
                atrasoInfo = {
                  requerAprovacao: true,
                  tipoMarcacao: tipoFinal,
                  atraso: {
                    minutos: analiseAtrasoResult.atrasoMinutos,
                    horarioPrevisto: analiseAtrasoResult.horarioPrevisto,
                    horarioTentativa: analiseAtrasoResult.horarioTentativa,
                    toleranciaPeriodoMin: analiseAtrasoResult.toleranciaPeriodoMin,
                    toleranciaDiariaMaxMin: analiseAtrasoResult.toleranciaDiariaMaxMin,
                    toleranciaDiariaJaUsada: analiseAtrasoResult.toleranciaDiariaJaUsada,
                    toleranciaDiariaRestante: analiseAtrasoResult.toleranciaDiariaRestante,
                    dentroToleranciaPeriodo: analiseAtrasoResult.dentroToleranciaPeriodo,
                    dentroToleranciaDiaria: analiseAtrasoResult.dentroToleranciaDiaria,
                  },
                  mensagem:
                    'Você está atrasado e está fora da tolerância permitida. ' +
                    'Deseja notificar o seu gestor para autorizar o registro de ponto?',
                };
                console.log(`[Biometria/Tolerância] ${colaborador.nome} - atraso de ${analiseAtrasoResult.atrasoMinutos}min FORA da tolerância (previsto: ${analiseAtrasoResult.horarioPrevisto}, atual: ${analiseAtrasoResult.horarioTentativa})`);
                await registrarAuditoria({
                  usuarioId: null,
                  acao: 'criar',
                  modulo: 'registro_ponto',
                  descricao: `Verificação por face: ${colaborador.nome} chegou atrasado (${analiseAtrasoResult.atrasoMinutos} min) - requer aprovação do gestor para registrar ponto`,
                  ip: getClientIp(request),
                  userAgent: getUserAgent(request),
                  colaboradorId: colaborador.id,
                  colaboradorNome: colaborador.nome,
                  entidadeTipo: 'marcacao',
                  dadosNovos: {
                    tipoMarcacao: tipoFinal,
                    atrasoMinutos: analiseAtrasoResult.atrasoMinutos,
                    horarioPrevisto: analiseAtrasoResult.horarioPrevisto,
                    horarioTentativa: analiseAtrasoResult.horarioTentativa,
                    requerAprovacao: true,
                    metodo: 'biometria',
                  },
                });
              }
            }
          }
        } catch (toleranciaError) {
          console.error('[Biometria/Tolerância] Erro na verificação (não bloqueante):', toleranciaError);
        }
      }

      // Se NÃO precisa aprovação, registra ponto normalmente
      if (!atrasoInfo) {
        const resultadoPonto = await registrarPonto(
          colaborador.id,
          tipoFinal,
          dispositivo,
          latitude,
          longitude,
          clientIp
        );

        if (resultadoPonto.sucesso) {
          pontoRegistrado = {
            marcacaoId: resultadoPonto.marcacaoId,
            tipo: resultadoPonto.tipo,
            tipoDetectadoAutomaticamente: tipoDetectado,
            sequencia: resultadoPonto.sequencia,
            dispositivoId: dispositivo.id,
            dispositivoNome: dispositivo.nome,
            dataHora: new Date().toISOString(),
            toleranciaHoraExtra: null as { consumiuTolerancia: boolean; solicitacaoId?: number; mensagem: string } | null,
            atrasoTolerado: null as { minutos: number; horarioPrevisto: string; horarioTentativa: string; toleranciaDiariaRestante: number } | null,
          };

          // Se houve atraso mas dentro da tolerância, registrar no controle interno
          if (
            analiseAtrasoResult?.atrasado &&
            analiseAtrasoResult.registrarNormalmente &&
            analiseAtrasoResult.atrasoMinutos > 0 &&
            resultadoPonto.marcacaoId
          ) {
            try {
              await registrarAtrasoTolerado(
                colaborador.id,
                tipoFinal,
                analiseAtrasoResult.horarioPrevisto,
                new Date(),
                analiseAtrasoResult.atrasoMinutos,
                resultadoPonto.marcacaoId
              );
              await cacheDelPattern(`${CACHE_KEYS.ATRASOS_TOLERADOS}*`);

              pontoRegistrado.atrasoTolerado = {
                minutos: analiseAtrasoResult.atrasoMinutos,
                horarioPrevisto: analiseAtrasoResult.horarioPrevisto,
                horarioTentativa: analiseAtrasoResult.horarioTentativa,
                toleranciaDiariaRestante: Math.max(
                  0,
                  analiseAtrasoResult.toleranciaDiariaMaxMin -
                    analiseAtrasoResult.toleranciaDiariaJaUsada -
                    analiseAtrasoResult.atrasoMinutos
                ),
              };

              console.log(`[Biometria/Tolerância] ${colaborador.nome} - atraso de ${analiseAtrasoResult.atrasoMinutos}min TOLERADO`);
            } catch (err) {
              console.error('[Biometria/Tolerância] Erro ao registrar atraso tolerado (não bloqueante):', err);
            }
          }

          // Lógica automática de tolerância de hora extra (entrada antecipada)
          if (resultadoPonto.tipo === 'entrada') {
            try {
              const toleranciaResult = await verificarEAplicarToleranciaHoraExtraEntrada(
                colaborador.id,
                colaborador.nome,
                colaborador.id,
                clientIp,
                'biometria'
              );

              if (toleranciaResult) {
                pontoRegistrado.toleranciaHoraExtra = {
                  consumiuTolerancia: toleranciaResult.consumiuTolerancia,
                  solicitacaoId: toleranciaResult.solicitacaoId,
                  mensagem: toleranciaResult.mensagem,
                };
              }
            } catch (toleranciaError) {
              console.error('Erro ao processar tolerância de hora extra entrada (não crítico):', toleranciaError);
            }
          }

          // Lógica automática de tolerância de hora extra (saída tardia)
          if (resultadoPonto.tipo === 'saida') {
            try {
              const toleranciaResult = await verificarEAplicarToleranciaHoraExtra(
                colaborador.id,
                colaborador.nome,
                colaborador.id,
                clientIp,
                'biometria'
              );

              if (toleranciaResult) {
                pontoRegistrado.toleranciaHoraExtra = {
                  consumiuTolerancia: toleranciaResult.consumiuTolerancia,
                  solicitacaoId: toleranciaResult.solicitacaoId,
                  mensagem: toleranciaResult.mensagem,
                };
              }
            } catch (toleranciaError) {
              console.error('Erro ao processar tolerância de hora extra (não crítico):', toleranciaError);
            }
          }

          const tipoLabel: Record<string, string> = {
            entrada: 'Entrada',
            almoco: 'Saída para almoço',
            retorno: 'Retorno do almoço',
            saida: 'Saída',
          };
          let descricaoLog = `Verificação por face: ${colaborador.nome} registrou ponto (${tipoLabel[resultadoPonto.tipo!]}) no dispositivo ${dispositivo.nome}`;
          if (pontoRegistrado.atrasoTolerado) {
            descricaoLog += ` - atraso tolerado: ${pontoRegistrado.atrasoTolerado.minutos} min`;
          }
          if (pontoRegistrado.toleranciaHoraExtra?.consumiuTolerancia) {
            descricaoLog += ' - tolerância de hora extra aplicada';
          }
          await registrarAuditoria({
            usuarioId: null,
            acao: 'criar',
            modulo: 'registro_ponto',
            descricao: descricaoLog,
            ip: getClientIp(request),
            userAgent: getUserAgent(request),
            colaboradorId: colaborador.id,
            colaboradorNome: colaborador.nome,
            entidadeId: resultadoPonto.marcacaoId ?? undefined,
            entidadeTipo: 'marcacao',
            dadosNovos: {
              marcacaoId: resultadoPonto.marcacaoId,
              tipo: resultadoPonto.tipo,
              dispositivoId: dispositivo.id,
              dispositivoNome: dispositivo.nome,
              metodo: 'biometria',
              ...(pontoRegistrado.atrasoTolerado && {
                atrasoTolerado: pontoRegistrado.atrasoTolerado.minutos,
                horarioPrevisto: pontoRegistrado.atrasoTolerado.horarioPrevisto,
              }),
              ...(pontoRegistrado.toleranciaHoraExtra?.consumiuTolerancia && {
                toleranciaHoraExtra: true,
                solicitacaoId: pontoRegistrado.toleranciaHoraExtra.solicitacaoId,
              }),
            },
          });
        } else {
          return jsonResponse({
            success: false,
            error: resultadoPonto.erro,
            code: 'CLOCK_IN_ERROR',
            colaborador: {
              id: colaborador.id,
              nome: colaborador.nome,
            },
          }, 400, rateLimitHeaders);
        }
      }
    }

    return jsonResponse({
      success: true,
      data: {
        identificado: true,
        tipo: 'bluepoint',
        colaboradorId: colaborador.id,
        externalIds: externalIdsFinal,
        colaborador: {
          id: colaborador.id,
          nome: colaborador.nome,
          email: colaborador.email,
          cargo: colaborador.cargo_id ? { id: colaborador.cargo_id, nome: colaborador.cargo_nome } : null,
          departamento: colaborador.departamento_nome || null,
          perfil: colaborador.tipo,
          foto: colaborador.foto_url || null,
        },
        confianca: Math.max(0, Math.min(1, confianca)),
        token,
        refreshToken,
        pontoRegistrado,
        ...(atrasoInfo && {
          requerAprovacao: atrasoInfo.requerAprovacao,
          tipoMarcacao: atrasoInfo.tipoMarcacao,
          atraso: atrasoInfo.atraso,
          mensagemAtraso: atrasoInfo.mensagem,
        }),
        processedIn: Date.now() - startTime,
      },
    }, 200, rateLimitHeaders);

  } catch (error) {
    console.error('Erro ao verificar face:', error);
    return jsonResponse({
      success: false,
      error: 'Erro interno ao processar verificação facial',
      code: 'INTERNAL_ERROR',
    }, 500);
  }
}

// Suporte a OPTIONS para CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
