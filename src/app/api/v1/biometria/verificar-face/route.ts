import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import {
  extractFaceEncoding,
  bufferToEncoding,
  encodingToBuffer,
  findTopMatchesByPerson,
  calcularThresholdDinamico,
  verificarDiversidade,
  verificarCondicoesAutoAprendizado,
} from '@/lib/face-recognition';
import {
  verificarFacesComLLM,
  escolherCandidatoComLLM,
  type TiebreakCandidate,
} from '@/lib/face-llm-verify';
import { logFaceEventAsync } from '@/lib/face-log';
import { generateToken, generateRefreshToken } from '@/lib/auth';
import { obterPermissoesEfetivasDoCargo } from '@/lib/permissoes-efetivas';
import { cacheGet, cacheSet, cacheDelPattern, checkRateLimit, invalidateMarcacaoCache, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { verificarEAplicarToleranciaHoraExtra, verificarEAplicarToleranciaHoraExtraEntrada } from '@/lib/hora-extra-tolerancia';
import {
  obterJornadaDoDia,
  obterParametrosTolerancia,
  analisarAtraso,
  registrarAtrasoTolerado,
} from '@/lib/tolerancia-atraso';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { tipoPontoBiometriaSchema } from '@/lib/validation';
import { uploadArquivo } from '@/lib/storage';
import { z } from 'zod';

const verificarFaceSchema = z.object({
  imagem: z.string().min(100, 'Imagem inválida'),
  // Campos opcionais para dispositivo autorizado
  dispositivoCodigo: z.string().length(6).toUpperCase().optional(),
  registrarPonto: z.boolean().optional().default(false),
  tipoPonto: tipoPontoBiometriaSchema,
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  origem: z.string().optional(),
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
     FROM people.dispositivos WHERE codigo = $1`,
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
      `SELECT tipo FROM people.marcacoes 
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
      `SELECT COUNT(*) FROM people.marcacoes 
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
  clientIp?: string,
  fotoUrl?: string | null
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
      `INSERT INTO people.marcacoes (
        colaborador_id, data_hora, tipo, latitude, longitude,
        metodo, dispositivo_id, empresa_id, foto_url, criado_em
      ) VALUES ($1, NOW(), $2, $3, $4, 'biometria', $5, $6, $7, NOW())
      RETURNING id`,
      [
        colaboradorId,
        tipo,
        latitude || null,
        longitude || null,
        dispositivo.id,
        dispositivo.empresa_id,
        fotoUrl || null,
      ]
    );

    // Atualizar contador do dispositivo
    await query(
      `UPDATE people.dispositivos SET 
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

    embedTableRowAfterInsert('marcacoes', marcacaoId).catch(() => {});

    return { sucesso: true, marcacaoId, tipo, sequencia };
  } catch (error) {
    console.error('Erro ao registrar ponto:', error);
    return { sucesso: false, erro: 'Erro ao registrar ponto' };
  }
}

/** Marcação por face quando o código de totem não está cadastrado (DEVICE_NOT_FOUND). Ocorrência será integrada depois. */
async function registrarPontoBiometriaDispositivoNaoAutorizado(
  colaboradorId: number,
  empresaId: number | null,
  tipo: 'entrada' | 'saida' | 'almoco' | 'retorno',
  latitude?: number,
  longitude?: number,
  fotoUrl?: string | null
): Promise<{ sucesso: boolean; marcacaoId?: number; tipo?: 'entrada' | 'saida' | 'almoco' | 'retorno'; sequencia?: number; erro?: string }> {
  try {
    const sequencia = await contarMarcacoesDia(colaboradorId) + 1;
    const result = await query(
      `INSERT INTO people.marcacoes (
        colaborador_id, data_hora, tipo, latitude, longitude,
        metodo, dispositivo_id, empresa_id, foto_url, criado_em
      ) VALUES ($1, NOW(), $2, $3, $4, 'biometria', NULL, $5, $6, NOW())
      RETURNING id`,
      [colaboradorId, tipo, latitude ?? null, longitude ?? null, empresaId, fotoUrl || null]
    );

    const marcacaoId = result.rows[0].id;
    await invalidateMarcacaoCache(colaboradorId);
    await cacheDelPattern(`${CACHE_KEYS.ATRASOS_TOLERADOS}*`);
    embedTableRowAfterInsert('marcacoes', marcacaoId).catch(() => {});

    return { sucesso: true, marcacaoId, tipo, sequencia };
  } catch (error) {
    console.error('Erro ao registrar ponto (dispositivo não cadastrado):', error);
    return { sucesso: false, erro: 'Erro ao registrar ponto' };
  }
}

/**
 * Salva a frame que falhou no detector de face (FACE_NOT_DETECTED ou
 * LOW_QUALITY) no MinIO + registra entrada de auditoria com metadados.
 * Usado pra investigar relatos do tipo "estava na frente do tablet
 * mas o sistema não reconheceu" — gestor consulta a auditoria e
 * confere visualmente o que o tablet realmente capturou.
 *
 * Best-effort: erros aqui só logam, não bloqueiam a resposta.
 */
async function auditarFrameSemFace(args: {
  imagem: string;
  codigo: 'FACE_NOT_DETECTED' | 'LOW_QUALITY';
  motivo: string;
  clientIp?: string | null;
  userAgent?: string | null;
  dispositivoCodigo?: string;
  latitude?: number;
  longitude?: number;
  origem?: string;
  qualidade?: number;
  qualidadeDetalhada?: {
    scoreDeteccao: number;
    tamanhoFace: number;
    centralizacao: number;
  };
}): Promise<void> {
  try {
    const base64 = args.imagem.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) return;

    const isPng = args.imagem.startsWith('data:image/png');
    const ext = isPng ? 'png' : 'jpg';
    const ct = isPng ? 'image/png' : 'image/jpeg';
    const dataDir = new Date().toISOString().split('T')[0];
    const ts = Date.now();
    const deviceTag = (args.dispositivoCodigo || 'sem-codigo').replace(
      /[^a-zA-Z0-9_-]/g,
      '_',
    );
    const path = `auditoria-face/${dataDir}/${deviceTag}/${ts}_${args.codigo.toLowerCase()}.${ext}`;

    const url = await uploadArquivo(path, buffer, ct);

    await registrarAuditoria({
      usuarioId: null,
      acao: 'criar',
      modulo: 'biometria',
      descricao: `Face não detectada (${args.codigo}): ${args.motivo}. Frame salvo em ${path}`,
      ip: args.clientIp ?? undefined,
      userAgent: args.userAgent ?? undefined,
      entidadeTipo: 'biometria',
      metadados: {
        code: args.codigo,
        motivo: args.motivo,
        dispositivoCodigo: args.dispositivoCodigo ?? null,
        origem: args.origem ?? null,
        latitude: args.latitude ?? null,
        longitude: args.longitude ?? null,
        qualidade: args.qualidade ?? null,
        qualidadeDetalhada: args.qualidadeDetalhada ?? null,
        framePath: path,
        frameUrl: url,
      },
    });

    console.log(`[Auditoria ${args.codigo}] frame salvo em ${path}`);
  } catch (e) {
    console.error('[Auditoria face frame] erro ao salvar/registrar:', e);
  }
}

/**
 * Sobe a imagem capturada pra MinIO em pasta dedicada de logs e
 * devolve a URL pública. Usado pra anexar foto a eventos de
 * face_recognition_logs (NOT_IDENTIFIED, AMBIGUOUS_MATCH,
 * LLM_REJECTED, INACTIVE_COLLABORATOR, MATCH_PROPOSED) sem precisar
 * gravar em auditoria. Best-effort — falha → null.
 */
async function uploadFotoLog(
  imagem: string,
  evento: string,
  dispositivoCodigo?: string,
): Promise<string | null> {
  try {
    const base64 = imagem.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) return null;
    const isPng = imagem.startsWith('data:image/png');
    const ext = isPng ? 'png' : 'jpg';
    const ct = isPng ? 'image/png' : 'image/jpeg';
    const dataDir = new Date().toISOString().split('T')[0];
    const ts = Date.now();
    const deviceTag = (dispositivoCodigo || 'sem-codigo').replace(
      /[^a-zA-Z0-9_-]/g,
      '_',
    );
    const path = `face-logs/${dataDir}/${deviceTag}/${ts}_${evento.toLowerCase()}.${ext}`;
    return await uploadArquivo(path, buffer, ct);
  } catch (e) {
    console.warn('[uploadFotoLog] falha:', e);
    return null;
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

    const { imagem, dispositivoCodigo, registrarPonto: deveRegistrarPonto, tipoPonto, latitude, longitude, origem } = validation.data;

    // Código de dispositivo inexistente (DEVICE_NOT_FOUND) não bloqueia: registra ponto após face + colaborador válido.
    // Dispositivo inativo/bloqueado continua sendo rejeitado aqui.
    let dispositivo: Dispositivo | undefined;
    let dispositivoCodigoNaoCadastrado = false;
    if (dispositivoCodigo) {
      const validacaoDisp = await validarDispositivo(dispositivoCodigo);
      if (!validacaoDisp.valido && validacaoDisp.code !== 'DEVICE_NOT_FOUND') {
        return jsonResponse({
          success: false,
          error: validacaoDisp.erro,
          code: validacaoDisp.code,
        }, 403, rateLimitHeaders);
      }
      if (validacaoDisp.valido) {
        const disp = validacaoDisp.dispositivo;
        if (!disp) {
          return jsonResponse({
            success: false,
            error: 'Estado inconsistente do dispositivo',
            code: 'DEVICE_INVALID',
          }, 500, rateLimitHeaders);
        }
        dispositivo = disp;
        if (disp.requer_geolocalizacao && (!latitude || !longitude)) {
          return jsonResponse({
            success: false,
            error: 'Este dispositivo requer geolocalização',
            code: 'GEOLOCATION_REQUIRED',
          }, 400, rateLimitHeaders);
        }
      } else {
        dispositivoCodigoNaoCadastrado = true;
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
      // Sobe a frame que falhou pra MinIO + registra auditoria. Permite
      // gestor revisar o que o tablet realmente capturou (cobertura
      // de "colaborador disse que estava na frente mas o sistema não
      // achou rosto"). Best-effort — não bloqueia a resposta.
      auditarFrameSemFace({
        imagem,
        codigo: 'FACE_NOT_DETECTED',
        motivo: error || 'Nenhuma face detectada na imagem',
        clientIp,
        userAgent: getUserAgent(request),
        dispositivoCodigo,
        latitude,
        longitude,
        origem,
      }).catch((e) => console.error('[Auditoria FACE_NOT_DETECTED] erro:', e));
      (async () => {
        const fotoUrl = await uploadFotoLog(imagem, 'FACE_NOT_DETECTED', dispositivoCodigo);
        logFaceEventAsync({
          evento: 'FACE_NOT_DETECTED',
          endpoint: 'verificar-face',
          origem,
          ip: clientIp,
          userAgent: getUserAgent(request),
          dispositivoCodigo,
          latitude,
          longitude,
          fotoUrl,
          duracaoMs: Date.now() - startTime,
          metadados: { motivo: error || 'sem_face' },
        });
      })().catch((e) => console.error('[FACE_NOT_DETECTED log] falha:', e));
      return jsonResponse({
        success: false,
        error: error || 'Não foi possível detectar a face na imagem',
        code: 'FACE_NOT_DETECTED',
        dica: 'Certifique-se de que o rosto está bem iluminado, centralizado e visível na câmera.',
      }, 400, rateLimitHeaders);
    }

    // Threshold mínimo de qualidade - apenas rejeita se o detector não encontrou face alguma
    if (qualidade < 0.05) {
      auditarFrameSemFace({
        imagem,
        codigo: 'LOW_QUALITY',
        motivo: `qualidade=${qualidade}`,
        clientIp,
        userAgent: getUserAgent(request),
        dispositivoCodigo,
        latitude,
        longitude,
        origem,
        qualidade,
        qualidadeDetalhada,
      }).catch((e) => console.error('[Auditoria LOW_QUALITY] erro:', e));
      (async () => {
        const fotoUrl = await uploadFotoLog(imagem, 'LOW_QUALITY', dispositivoCodigo);
        logFaceEventAsync({
          evento: 'LOW_QUALITY',
          endpoint: 'verificar-face',
          origem,
          ip: clientIp,
          userAgent: getUserAgent(request),
          dispositivoCodigo,
          latitude,
          longitude,
          qualidade,
          qualidadeDetalhada: qualidadeDetalhada
            ? (qualidadeDetalhada as unknown as Record<string, unknown>)
            : null,
          fotoUrl,
          duracaoMs: Date.now() - startTime,
        });
      })().catch((e) => console.error('[LOW_QUALITY log] falha:', e));
      return jsonResponse({
        success: false,
        error: 'Nenhuma face detectada na imagem',
        code: 'LOW_QUALITY',
        qualidade,
        qualidadeDetalhada,
        dica: 'Certifique-se de que há um rosto visível na imagem.',
      }, 400, rateLimitHeaders);
    }

    // Usar threshold dinâmico baseado na qualidade
    const thresholdEfetivo = calcularThresholdDinamico(qualidade);
    
    console.log(`[Verificar Face] Qualidade: ${qualidade}, Threshold: ${thresholdEfetivo.toFixed(3)}`);

    // Buscar encodings do cache ou banco
    const cacheStart = Date.now();
    let encodings: CachedEncoding[] | null = await cacheGet<CachedEncoding[]>(CACHE_KEYS.BIOMETRIA_ENCODINGS);
    
    if (!encodings) {
      console.log('[Verificar Face] Cache MISS - buscando do banco...');
      // Trava: colaborador INATIVO não entra no banco de encodings.
      // Antes, registros com external_id passavam mesmo se o
      // colaborador estivesse inativo, abrindo brecha pra match em
      // ex-funcionário ou conta desativada.
      const encodingsResult = await query(
        `SELECT bf.colaborador_id, bf.external_id, bf.encoding, bf.encodings_extras,
                bf.encodings_aprendidos, bf.qualidades_aprendidos, bf.total_aprendidos
         FROM people.biometria_facial bf
         LEFT JOIN people.colaboradores c ON bf.colaborador_id = c.id
         WHERE bf.encoding IS NOT NULL
           AND (
             bf.colaborador_id IS NULL
             OR c.status = 'ativo'
           )`
      );

      if (encodingsResult.rows.length === 0) {
        (async () => {
          const fotoUrl = await uploadFotoLog(imagem, 'NO_FACES_REGISTERED', dispositivoCodigo);
          logFaceEventAsync({
            evento: 'NO_FACES_REGISTERED',
            endpoint: 'verificar-face',
            origem,
            ip: clientIp,
            userAgent: getUserAgent(request),
            dispositivoCodigo,
            latitude,
            longitude,
            qualidade,
            fotoUrl,
            duracaoMs: Date.now() - startTime,
          });
        })().catch((e) => console.error('[NO_FACES_REGISTERED log] falha:', e));
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

    // Encontrar melhor match agrupando por pessoa — assim conseguimos
    // ver não só o melhor match mas também o SEGUNDO mais próximo (de
    // outra pessoa) e detectar matches ambíguos (gap pequeno = duas
    // pessoas com distâncias parecidas → rejeita por segurança).
    const personKey = (item: typeof encodingsFloat[number]) =>
      item.colaboradorId !== null
        ? `c:${item.colaboradorId}`
        : `e:${JSON.stringify(item.externalIds)}`;
    const matchStart = Date.now();
    const topMatches = await findTopMatchesByPerson(
      encoding,
      encodingsFloat,
      personKey,
      3,
    );
    console.log(`[Verificar Face] Comparação: ${Date.now() - matchStart}ms`);

    let best = topMatches[0] ?? null;
    const second = topMatches[1] ?? null;

    if (best) {
      console.log(
        `[Verificar Face] Top1: ${best.key} dist=${best.distance.toFixed(4)}` +
          (second
            ? ` | Top2: ${second.key} dist=${second.distance.toFixed(4)} (gap=${(second.distance - best.distance).toFixed(4)})`
            : ''),
      );
    }

    // (1) Sem candidato dentro do threshold = NOT_IDENTIFIED.
    //
    // Antes de devolver NOT_IDENTIFIED, dá uma 2ª chance via LLM para
    // "near-misses" (best.distance entre threshold e 0.55). Modelo de
    // visão olha as fotos dos top-N candidatos próximos e decide se
    // algum bate. Se sim, "promove" o best e segue como match normal.
    // Se não, mantém NOT_IDENTIFIED. Scans realmente vazios (>0.55)
    // não pagam LLM.
    const NEAR_MISS_LIMIT = 0.55;
    let llmRecoveryUsed = false;
    let llmRecoveryConfidence: number | null = null;
    let llmRecoveryModel: string | null = null;
    let llmRecoveryReason: string | null = null;

    if (
      best &&
      best.distance >= thresholdEfetivo &&
      best.distance < NEAR_MISS_LIMIT
    ) {
      // Pega top-N pessoas com dist < NEAR_MISS_LIMIT e que tenham
      // colaborador associado (registros 100% externos não geram match
      // de ponto direto).
      const near = topMatches
        .filter(
          (m) =>
            m.distance < NEAR_MISS_LIMIT && m.match.colaboradorId !== null,
        )
        .slice(0, 5);

      if (near.length > 0) {
        try {
          const colabIds = near.map((m) => m.match.colaboradorId!);
          const r = await query<{
            colaborador_id: number;
            nome: string;
            foto: string | null;
          }>(
            `SELECT bf.colaborador_id,
                    c.nome,
                    COALESCE(bf.foto_referencia_url, c.foto_url) AS foto
               FROM people.biometria_facial bf
               JOIN people.colaboradores c ON c.id = bf.colaborador_id
              WHERE bf.colaborador_id = ANY($1::int[])
                AND c.status = 'ativo'`,
            [colabIds],
          );
          const fotosMap = new Map(
            r.rows.map((x) => [
              x.colaborador_id,
              { nome: x.nome, foto: x.foto },
            ]),
          );

          const candidates: TiebreakCandidate[] = near.map((m, idx) => {
            const info = fotosMap.get(m.match.colaboradorId!);
            return {
              index: idx,
              colaboradorId: m.match.colaboradorId,
              externalIds: m.match.externalIds,
              nome: info?.nome ?? `#${m.match.colaboradorId}`,
              distancia: m.distance,
              fotoReferenciaUrl: info?.foto ?? null,
            };
          });

          const llm = await escolherCandidatoComLLM({
            capturedDataUri: imagem,
            candidates,
          });

          if (
            llm &&
            llm.matchedIndex !== null &&
            llm.matchedIndex >= 0 &&
            llm.matchedIndex < near.length
          ) {
            // Promove o candidato escolhido pelo LLM. Substitui best
            // pra que o restante do fluxo (busca colaborador, registra
            // ponto, auditoria, auto-aprendizado) trate como match.
            best = near[llm.matchedIndex];
            llmRecoveryUsed = true;
            llmRecoveryConfidence = llm.confidence;
            llmRecoveryModel = llm.model;
            llmRecoveryReason = llm.reason;
            console.log(
              `[Verificar Face] NEAR_MISS_RECOVERED: LLM (${llm.model}) escolheu c:${best.match.colaboradorId} ` +
                `entre ${near.length} candidatos (dist original=${best.distance.toFixed(4)}, conf=${llm.confidence})`,
            );
            (async () => {
              const fotoUrl = await uploadFotoLog(
                imagem,
                'NEAR_MISS_RECOVERED',
                dispositivoCodigo,
              );
              logFaceEventAsync({
                evento: 'NEAR_MISS_RECOVERED',
                endpoint: 'verificar-face',
                origem,
                ip: clientIp,
                userAgent: getUserAgent(request),
                dispositivoCodigo,
                latitude,
                longitude,
                qualidade,
                thresholdEfetivo,
                colaboradorIdProposto: best!.match.colaboradorId ?? null,
                distanciaTop1: best!.distance,
                distanciaTop2: second?.distance ?? null,
                gapTop12: second
                  ? second.distance - best!.distance
                  : null,
                llmModelo: llm.model,
                llmConfirmou: true,
                llmConfidence: llm.confidence,
                llmRazao: llm.reason,
                llmLatencyMs: llm.latencyMs,
                fotoUrl,
                duracaoMs: Date.now() - startTime,
                metadados: {
                  candidatosConsiderados: candidates.length,
                  candidatos: candidates.map((c) => ({
                    colaboradorId: c.colaboradorId,
                    distancia: c.distancia,
                  })),
                },
              });
            })().catch((e) =>
              console.error('[NEAR_MISS_RECOVERED log] falha:', e),
            );
          } else if (llm) {
            // LLM analisou mas decidiu null — registra evento separado
            // pra que possamos analisar acertos/erros do recovery.
            (async () => {
              const fotoUrl = await uploadFotoLog(
                imagem,
                'NEAR_MISS_NOT_RECOVERED',
                dispositivoCodigo,
              );
              logFaceEventAsync({
                evento: 'NEAR_MISS_NOT_RECOVERED',
                endpoint: 'verificar-face',
                origem,
                ip: clientIp,
                userAgent: getUserAgent(request),
                dispositivoCodigo,
                latitude,
                longitude,
                qualidade,
                thresholdEfetivo,
                distanciaTop1: best!.distance,
                distanciaTop2: second?.distance ?? null,
                llmModelo: llm.model,
                llmConfirmou: false,
                llmConfidence: llm.confidence,
                llmRazao: llm.reason,
                llmLatencyMs: llm.latencyMs,
                fotoUrl,
                duracaoMs: Date.now() - startTime,
                metadados: {
                  candidatosConsiderados: candidates.length,
                },
              });
            })().catch((e) =>
              console.error('[NEAR_MISS_NOT_RECOVERED log] falha:', e),
            );
          }
        } catch (e) {
          console.error('[Verificar Face] near-miss LLM falhou:', e);
        }
      }
    }

    // Se a recuperação por LLM não promoveu best, segue o NOT_IDENTIFIED
    // clássico.
    if (!llmRecoveryUsed && (!best || best.distance >= thresholdEfetivo)) {
      (async () => {
        const fotoUrl = await uploadFotoLog(imagem, 'NOT_IDENTIFIED', dispositivoCodigo);
        logFaceEventAsync({
          evento: 'NOT_IDENTIFIED',
          endpoint: 'verificar-face',
          origem,
          ip: clientIp,
          userAgent: getUserAgent(request),
          dispositivoCodigo,
          latitude,
          longitude,
          qualidade,
          thresholdEfetivo,
          distanciaTop1: best?.distance ?? null,
          distanciaTop2: second?.distance ?? null,
          gapTop12:
            best && second ? second.distance - best.distance : null,
          fotoUrl,
          duracaoMs: Date.now() - startTime,
        });
      })().catch((e) => console.error('[NOT_IDENTIFIED log] falha:', e));
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
          menorDistancia: best ? Math.round(best.distance * 1e4) / 1e4 : null,
          dica: qualidade < 0.5
            ? 'A qualidade da imagem está muito baixa. Melhore a iluminação e centralize o rosto.'
            : 'Certifique-se de que o rosto está bem visível e centralizado.',
          processedIn: Date.now() - startTime,
        },
      }, 200, rateLimitHeaders);
    }

    // (2) Antes rejeitávamos quando o gap top-1 vs top-2 era muito
    // pequeno (AMBIGUOUS_MATCH). A trava virou ruído em campo —
    // gente legitimamente parecida (clusters próximos) era barrada
    // toda hora. Agora seguimos com o menor (best) e deixamos a
    // segurança extra a cargo da camada LLM (verifyFacesComLLM
    // dispara quando dist > 0.30). Mantemos warning em log pra
    // continuar observando o fenômeno.
    if (second && second.distance - best.distance < 0.05) {
      console.warn(
        `[Verificar Face] gap pequeno top1↔top2: ${best.key}=${best.distance.toFixed(4)} vs ` +
          `${second.key}=${second.distance.toFixed(4)} (gap=${(second.distance - best.distance).toFixed(4)}) — seguindo com top-1`,
      );
    }

    const matchedRecord = best.match;
    // Calcular confiança baseada no threshold utilizado
    const confianca = Math.round((1 - best.distance / thresholdEfetivo) * 100) / 100;

    // (3) Borderline: distância acima de LLM_VERIFY_THRESHOLD entra na
    // segunda camada — modelo de visão confirma se as fotos são da
    // mesma pessoa. Matches "fáceis" (dist < 0.30) pulam a chamada
    // pra economizar latência. Se a LLM rejeitar, reportamos como
    // NOT_IDENTIFIED com motivo `LLM_REJECTED`.
    //
    // Pula esta etapa se o best veio do near-miss recovery — o LLM
    // já analisou e escolheu este candidato, redundante chamar de novo.
    const LLM_VERIFY_THRESHOLD = 0.30;
    if (!llmRecoveryUsed && best.distance > LLM_VERIFY_THRESHOLD) {
      try {
        // Buscar foto_referencia_url + nome do candidato para alimentar a LLM
        let refUrl: string | null = null;
        let candidatoNome = 'Colaborador';
        if (matchedRecord.colaboradorId) {
          const r = await query<{
            foto_referencia_url: string | null;
            nome: string;
          }>(
            `SELECT bf.foto_referencia_url, c.nome
             FROM people.biometria_facial bf
             JOIN people.colaboradores c ON c.id = bf.colaborador_id
             WHERE bf.colaborador_id = $1
             LIMIT 1`,
            [matchedRecord.colaboradorId],
          );
          if (r.rows[0]) {
            refUrl = r.rows[0].foto_referencia_url;
            candidatoNome = r.rows[0].nome;
          }
        } else if (Object.keys(matchedRecord.externalIds || {}).length > 0) {
          const primeiroPrefixo = Object.keys(matchedRecord.externalIds)[0];
          const r = await query<{ foto_referencia_url: string | null }>(
            `SELECT foto_referencia_url FROM people.biometria_facial
             WHERE external_id ? $1 LIMIT 1`,
            [primeiroPrefixo],
          );
          if (r.rows[0]) refUrl = r.rows[0].foto_referencia_url;
        }

        const llm = await verificarFacesComLLM({
          capturedDataUri: imagem,
          referenceUrl: refUrl,
          candidatoNome,
        });

        if (llm && !llm.confirmed) {
          console.warn(
            `[Verificar Face] LLM_REJECTED: ${candidatoNome} — dist=${best.distance.toFixed(4)} ` +
              `conf=${llm.confidence} reason="${llm.reason}"`,
          );
          await registrarAuditoria({
            usuarioId: null,
            acao: 'criar',
            modulo: 'registro_ponto',
            descricao: `Verificação por face: LLM rejeitou match para ${candidatoNome} (dist=${best.distance.toFixed(4)}, conf LLM=${llm.confidence}). Razão: ${llm.reason}`,
            ip: getClientIp(request),
            userAgent: getUserAgent(request),
            colaboradorId: matchedRecord.colaboradorId ?? undefined,
            colaboradorNome: candidatoNome,
            entidadeTipo: 'biometria',
            metadados: {
              distance: best.distance,
              llmModel: llm.model,
              llmConfidence: llm.confidence,
              llmReason: llm.reason,
              reject: 'LLM',
            },
          });
          (async () => {
            const fotoUrl = await uploadFotoLog(imagem, 'LLM_REJECTED', dispositivoCodigo);
            logFaceEventAsync({
              evento: 'LLM_REJECTED',
              endpoint: 'verificar-face',
              origem,
              ip: clientIp,
              userAgent: getUserAgent(request),
              dispositivoCodigo,
              latitude,
              longitude,
              qualidade,
              thresholdEfetivo,
              colaboradorIdProposto: matchedRecord.colaboradorId ?? null,
              externalIdProposto: matchedRecord.externalIds ?? null,
              distanciaTop1: best.distance,
              distanciaTop2: second?.distance ?? null,
              gapTop12: second ? second.distance - best.distance : null,
              llmModelo: llm.model,
              llmConfirmou: false,
              llmConfidence: llm.confidence,
              llmRazao: llm.reason,
              llmLatencyMs: llm.latencyMs,
              fotoUrl,
              duracaoMs: Date.now() - startTime,
            });
          })().catch((e) => console.error('[LLM_REJECTED log] falha:', e));
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
              mensagem:
                'Não foi possível confirmar sua identidade. Tente novamente com melhor iluminação.',
              code: 'LLM_REJECTED',
              qualidadeCaptura: qualidade,
              thresholdUtilizado: thresholdEfetivo,
              processedIn: Date.now() - startTime,
            },
          }, 200, rateLimitHeaders);
        }
        // LLM confirmou OU LLM offline/sem ref — segue com match do ArcFace.
      } catch (llmErr) {
        console.error('[Verificar Face] Erro ao consultar LLM (não bloqueante):', llmErr);
      }
    }

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
          best.distance,
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
            `SELECT id, total_aprendidos FROM people.biometria_facial WHERE colaborador_id = $1`,
            [matchedRecord.colaboradorId]
          );
          if (bioResult.rows.length > 0) {
            bioId = bioResult.rows[0].id;
          }
        } else if (Object.keys(matchedRecord.externalIds || {}).length > 0) {
          const primeiroPrefixo = Object.keys(matchedRecord.externalIds)[0];
          const bioResult = await query(
            `SELECT id, total_aprendidos FROM people.biometria_facial WHERE external_id ? $1`,
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
          `UPDATE people.biometria_facial 
           SET encodings_aprendidos = array_append(encodings_aprendidos, $1),
               qualidades_aprendidos = array_append(qualidades_aprendidos, $2),
               total_aprendidos = total_aprendidos + 1,
               atualizado_em = NOW()
           WHERE id = $3`,
          [encodingBuffer, qualidade, bioId]
        );

        // Não invalidar o cache aqui: em horário de pico cada acerto dispararia
        // cache MISS no request seguinte, forçando reload completo dos encodings
        // do Aurora e saturando a CPU do banco. O novo encoding aprendido entra
        // em uso no próximo refresh natural do cache (TTL LONG).

        console.log(`[Auto-Aprendizado] ✓ Encoding salvo! Pessoa: colab=${matchedRecord.colaboradorId || 'N/A'}, ` +
          `distância: ${best.distance.toFixed(4)}, qualidade: ${qualidade.toFixed(2)}, ` +
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
        `SELECT colaborador_id, external_id FROM people.biometria_facial WHERE colaborador_id = $1`,
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
        `SELECT colaborador_id, external_id FROM people.biometria_facial WHERE external_id ? $1`,
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

    // Se tem colaborador_id, busca dados do colaborador BluePoint.
    // Inclui cg.nivel_acesso_id pra montar payload coerente com /autenticar
    // (login facial precisa do nivel pra mobile/web reconhecerem liderança).
    const colaboradorResult = await query(
      `SELECT
        c.id, c.nome, c.email, c.cpf, c.tipo, c.foto_url, c.cargo_id, c.empresa_id,
        c.permite_ponto_mobile,
        cg.nome as cargo_nome,
        cg.nivel_acesso_id,
        d.nome as departamento_nome
       FROM people.colaboradores c
       LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
       LEFT JOIN people.departamentos d ON c.departamento_id = d.id
       WHERE c.id = $1 AND c.status = 'ativo'`,
      [colaboradorIdFinal]
    );

    if (colaboradorResult.rows.length === 0) {
      // Defesa em profundidade: a query do cache já filtra inativos,
      // mas se algum encoding stale escapou (cache antigo de antes do
      // colaborador virar inativo), capturamos aqui — invalidamos o
      // cache pra forçar reload limpo no próximo request, e
      // registramos a tentativa em auditoria pra rastrear.
      console.warn(
        `[Verificar Face] Match de colaborador NÃO ATIVO (id=${colaboradorIdFinal}) — rejeitando + invalidando cache de encodings`,
      );
      try {
        await cacheDelPattern(`${CACHE_KEYS.BIOMETRIA_ENCODINGS}*`);
      } catch (e) {
        console.warn('[Verificar Face] Falha ao invalidar cache:', e);
      }
      await registrarAuditoria({
        usuarioId: null,
        acao: 'criar',
        modulo: 'biometria',
        descricao: `Tentativa de reconhecimento bloqueada: colaborador alvo inativo ou não cadastrado (id=${colaboradorIdFinal}, dist=${best.distance.toFixed(4)})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        colaboradorId: colaboradorIdFinal ?? undefined,
        entidadeTipo: 'biometria',
        metadados: {
          colaboradorId: colaboradorIdFinal,
          distance: best.distance,
          motivo: 'colaborador_inativo_ou_inexistente',
        },
      });
      (async () => {
        const fotoUrl = await uploadFotoLog(imagem, 'INACTIVE_COLLABORATOR', dispositivoCodigo);
        logFaceEventAsync({
          evento: 'INACTIVE_COLLABORATOR',
          endpoint: 'verificar-face',
          origem,
          ip: clientIp,
          userAgent: getUserAgent(request),
          dispositivoCodigo,
          latitude,
          longitude,
          qualidade,
          thresholdEfetivo,
          colaboradorIdProposto: colaboradorIdFinal ?? null,
          distanciaTop1: best.distance,
          fotoUrl,
          duracaoMs: Date.now() - startTime,
        });
      })().catch((e) => console.error('[INACTIVE log] falha:', e));
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
          mensagem:
            'Colaborador inativo ou sem cadastro válido. Procure o RH.',
          code: 'INACTIVE_COLLABORATOR',
          processedIn: Date.now() - startTime,
        },
      }, 200, rateLimitHeaders);
    }

    const colaborador = colaboradorResult.rows[0];

    // Verificar permissão de ponto pelo celular quando registrarPonto=true (totem sempre permitido)
    if (deveRegistrarPonto && origem !== 'totem' && !colaborador.permite_ponto_mobile) {
      return jsonResponse({
        success: false,
        error: 'Este colaborador não tem permissão para marcar ponto pelo celular',
        code: 'MOBILE_PUNCH_NOT_ALLOWED',
      }, 403, rateLimitHeaders);
    }

    // Gerar tokens JWT — inclui nivelId/cargoId pra que middleware
    // resolva permissoes/liderança sem consulta extra (mesmo padrão
    // do /autenticar). Sem isso, login facial gera token "raso" e
    // mobile/web nao reconhecem o usuario como gestor.
    const tokenPayload = {
      userId: colaborador.id,
      email: colaborador.email,
      tipo: colaborador.tipo,
      nome: colaborador.nome,
      nivelId: colaborador.nivel_acesso_id ?? null,
      cargoId: colaborador.cargo_id ?? null,
    };

    const token = generateToken(tokenPayload);
    const refreshToken = generateRefreshToken();

    // Buscar nivel + permissoes efetivas (igual /autenticar). Sem isso, o
    // payload retornado nao tem nivel nem permissoes -> mobile cai em
    // tipo='colaborador' e perde acesso a telas de gestao.
    let nivel: { id: number; nome: string; descricao: string | null } | null = null;
    if (colaborador.nivel_acesso_id) {
      const nivelResult = await query(
        `SELECT id, nome, descricao FROM people.niveis_acesso WHERE id = $1`,
        [colaborador.nivel_acesso_id]
      );
      if (nivelResult.rows.length > 0) {
        const r = nivelResult.rows[0];
        nivel = { id: r.id, nome: r.nome, descricao: r.descricao };
      }
    }
    let permissoes: string[];
    if (colaborador.id === 1) {
      const todas = await query<{ codigo: string }>(
        `SELECT codigo FROM people.permissoes ORDER BY codigo`
      );
      permissoes = todas.rows.map((r) => r.codigo);
    } else {
      const efetivas = await obterPermissoesEfetivasDoCargo({
        cargoId: colaborador.cargo_id ?? null,
        nivelId: colaborador.nivel_acesso_id ?? null,
        tipoLegado: colaborador.tipo,
      });
      permissoes = efetivas.codigos;
    }

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

    const podeRegistrarPontoBiometria = deveRegistrarPonto && (dispositivo || dispositivoCodigoNaoCadastrado || !dispositivoCodigo);

    if (deveRegistrarPonto && !podeRegistrarPontoBiometria) {
      console.warn(
        `[Verificar Face] colaborador=${colaborador.id} (${colaborador.nome}) deveRegistrarPonto=true mas NAO entrou no fluxo de registro. ` +
        `dispositivoCodigo=${dispositivoCodigo ?? 'null'} dispositivoEncontrado=${dispositivo ? dispositivo.id : 'null'} dispositivoCodigoNaoCadastrado=${dispositivoCodigoNaoCadastrado}`
      );
    }

    if (podeRegistrarPontoBiometria) {
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
        // Upload da foto capturada na biometria (best-effort, não bloqueia)
        let fotoUrl: string | null = null;
        try {
          const base64Data = imagem.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');

          let extensao = 'jpg';
          let contentType = 'image/jpeg';
          if (imagem.startsWith('data:image/png')) {
            extensao = 'png';
            contentType = 'image/png';
          }

          const agora = new Date();
          const dataFormatada = agora.toISOString().split('T')[0];
          const timestamp = agora.getTime();
          const caminho = `marcacoes/${colaborador.id}/${dataFormatada}/${timestamp}_${tipoFinal}_biometria.${extensao}`;

          fotoUrl = await uploadArquivo(caminho, buffer, contentType);
        } catch (uploadError) {
          console.warn('[Verificar Face] Erro ao fazer upload da foto (não bloqueante):', uploadError);
        }

        const resultadoPonto = dispositivo
          ? await registrarPonto(
              colaborador.id,
              tipoFinal,
              dispositivo,
              latitude,
              longitude,
              clientIp,
              fotoUrl
            )
          : await registrarPontoBiometriaDispositivoNaoAutorizado(
              colaborador.id,
              colaborador.empresa_id ?? null,
              tipoFinal,
              latitude,
              longitude,
              fotoUrl
            );

        if (resultadoPonto.sucesso) {
          pontoRegistrado = {
            marcacaoId: resultadoPonto.marcacaoId,
            tipo: resultadoPonto.tipo,
            tipoDetectadoAutomaticamente: tipoDetectado,
            sequencia: resultadoPonto.sequencia,
            ...(dispositivo
              ? { dispositivoId: dispositivo.id, dispositivoNome: dispositivo.nome }
              : { dispositivoNaoAutorizado: true as const }),
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
          let descricaoLog = dispositivo
            ? `Verificação por face: ${colaborador.nome} registrou ponto (${tipoLabel[resultadoPonto.tipo!]}) no dispositivo ${dispositivo.nome}`
            : `Verificação por face: ${colaborador.nome} registrou ponto (${tipoLabel[resultadoPonto.tipo!]}) — código de dispositivo não cadastrado (ponto registrado; ocorrência pendente de integração)`;
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
              ...(dispositivo
                ? { dispositivoId: dispositivo.id, dispositivoNome: dispositivo.nome }
                : { dispositivoNaoAutorizado: true }),
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

    if (deveRegistrarPonto && !pontoRegistrado && !atrasoInfo) {
      console.error(
        `[Verificar Face] FALHA SILENCIOSA: colaborador=${colaborador.id} (${colaborador.nome}) deveRegistrarPonto=true porém ponto NAO foi registrado e sem atrasoInfo. ` +
        `dispositivoCodigo=${dispositivoCodigo ?? 'null'} dispositivoCodigoNaoCadastrado=${dispositivoCodigoNaoCadastrado}`
      );
      return jsonResponse({
        success: false,
        error: 'Face identificada mas o ponto não foi registrado. Tente novamente.',
        code: 'CLOCK_IN_NOT_PROCESSED',
        colaborador: { id: colaborador.id, nome: colaborador.nome },
      }, 422, rateLimitHeaders);
    }

    // Log de sucesso. MATCH_CONFIRMED quando ponto foi registrado;
    // MATCH_PROPOSED quando só identificou (deveRegistrarPonto=false).
    // Pra ambos os casos sobe a foto capturada — em MATCH_CONFIRMED a
    // marcação também tem foto_url, mas mantemos cópia dedicada nos
    // logs pra não acoplar storage de marcação ao histórico de eventos.
    const eventoSucesso = pontoRegistrado ? 'MATCH_CONFIRMED' : 'MATCH_PROPOSED';
    (async () => {
      const fotoUrl = await uploadFotoLog(imagem, eventoSucesso, dispositivoCodigo);
      logFaceEventAsync({
        evento: eventoSucesso,
        endpoint: 'verificar-face',
        origem,
        ip: clientIp,
        userAgent: getUserAgent(request),
        dispositivoCodigo,
        latitude,
        longitude,
        qualidade,
        thresholdEfetivo,
        colaboradorIdProposto: colaborador.id,
        colaboradorIdConfirmado: pontoRegistrado ? colaborador.id : null,
        distanciaTop1: best.distance,
        distanciaTop2: second?.distance ?? null,
        gapTop12: second ? second.distance - best.distance : null,
        marcacaoId: pontoRegistrado?.marcacaoId ?? null,
        llmModelo: llmRecoveryUsed ? llmRecoveryModel : null,
        llmConfirmou: llmRecoveryUsed ? true : null,
        llmConfidence: llmRecoveryUsed ? llmRecoveryConfidence : null,
        llmRazao: llmRecoveryUsed ? llmRecoveryReason : null,
        fotoUrl,
        duracaoMs: Date.now() - startTime,
        metadados: {
          ...(atrasoInfo && { requerAprovacaoAtraso: true }),
          ...(llmRecoveryUsed && { recoveredFromNearMiss: true }),
        },
      });
    })().catch((e) => console.error(`[${eventoSucesso} log] falha:`, e));
    return jsonResponse({
      success: true,
      data: {
        identificado: true,
        tipo: 'people',
        colaboradorId: colaborador.id,
        externalIds: externalIdsFinal,
        colaborador: {
          id: colaborador.id,
          nome: colaborador.nome,
          email: colaborador.email,
          cpf: colaborador.cpf,
          cargo: colaborador.cargo_id ? { id: colaborador.cargo_id, nome: colaborador.cargo_nome } : null,
          departamento: colaborador.departamento_nome || null,
          // `tipo` é o nome canonico (mesmo do /autenticar). `perfil` mantido
          // como alias por compat com clientes antigos.
          tipo: colaborador.tipo,
          perfil: colaborador.tipo,
          foto: colaborador.foto_url || null,
          permitePontoMobile: colaborador.permite_ponto_mobile ?? false,
          nivel,
          permissoes,
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
