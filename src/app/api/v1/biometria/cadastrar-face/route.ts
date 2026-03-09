import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withBiometriaAuth } from '@/lib/middleware';
import { extractFaceEncoding, encodingToBuffer, bufferToEncoding, findBestMatchGeneric, calcularThresholdDinamico } from '@/lib/face-recognition';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheDel, checkRateLimit, CACHE_KEYS } from '@/lib/cache';
import { uploadArquivo } from '@/lib/storage';
import { z } from 'zod';

// Gera dicas personalizadas baseadas na análise de qualidade
function gerarDicasQualidade(detalhes?: {
  scoreDeteccao: number;
  tamanhoFace: number;
  centralizacao: number;
}): string[] {
  const dicas: string[] = [];
  
  if (!detalhes) {
    return ['Melhore a iluminação e aproxime o rosto da câmera.'];
  }
  
  if (detalhes.scoreDeteccao < 0.7) {
    dicas.push('Melhore a iluminação do ambiente.');
  }
  if (detalhes.tamanhoFace < 0.6) {
    dicas.push('Aproxime mais o rosto da câmera.');
  }
  if (detalhes.centralizacao < 0.6) {
    dicas.push('Centralize o rosto na imagem.');
  }
  
  if (dicas.length === 0) {
    dicas.push('Tente capturar uma nova imagem com melhor iluminação.');
  }
  
  return dicas;
}

const cadastrarFaceSchema = z.object({
  colaboradorId: z.number().int().positive().optional(),
  externalId: z.string().min(1).max(100).regex(/^[^_]+_[^_]+$/, 'External ID deve ter formato prefixo_id').optional(),
  imagem: z.string().min(100, 'Imagem inválida'),
  // Se true, adiciona encoding extra ao invés de sobrescrever o principal
  // Ideal para cadastrar a mesma pessoa de câmeras/condições diferentes
  adicional: z.boolean().optional().default(false),
}).refine(data => data.colaboradorId || data.externalId, {
  message: 'Informe colaboradorId ou externalId',
});

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

// Função para obter IP do cliente
function getClientIpFromRequest(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfIp = request.headers.get('cf-connecting-ip');
  
  if (cfIp) return cfIp;
  if (forwarded) return forwarded.split(',')[0].trim();
  if (realIp) return realIp;
  
  return 'unknown';
}

// Função para parsear externalId (formato: prefixo_id)
function parseExternalId(externalId: string): { prefixo: string; id: string } {
  const parts = externalId.split('_');
  if (parts.length !== 2) {
    throw new Error('Formato inválido para externalId');
  }
  return {
    prefixo: parts[0],
    id: parts[1],
  };
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const clientIp = getClientIpFromRequest(request);

  // Rate limiting: 30 cadastros por minuto por IP
  const rateLimit = await checkRateLimit(`biometria:cadastrar:${clientIp}`, 30, 60);
  
  const rateLimitHeaders = {
    'X-RateLimit-Limit': '30',
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

  return withBiometriaAuth(request, async (req, isApiToken, user) => {
    try {
      // Parse body
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({
          success: false,
          error: 'JSON inválido',
          code: 'INVALID_JSON',
        }, 400, rateLimitHeaders);
      }
      
      // Validar request
      const validation = cadastrarFaceSchema.safeParse(body);
      if (!validation.success) {
        return jsonResponse({
          success: false,
          error: 'Erro de validação',
          code: 'VALIDATION_ERROR',
          details: validation.error.issues.map(i => ({
            field: i.path.join('.') || 'geral',
            message: i.message,
          })),
        }, 422, rateLimitHeaders);
      }

      const { colaboradorId, externalId, imagem, adicional } = validation.data;

      let colaboradorId_final: number | null = null;
      let colaboradorNome: string = '';
      let isExternal = false;
      let externalData: { prefixo: string; id: string } | null = null;

      if (colaboradorId) {
        // Modo BluePoint: Buscar colaborador pelo ID
        const colaboradorResult = await query(
          `SELECT id, nome FROM bluepoint.bt_colaboradores WHERE id = $1`,
          [colaboradorId]
        );

        if (colaboradorResult.rows.length === 0) {
          return jsonResponse({
            success: false,
            error: 'Colaborador não encontrado',
            code: 'COLLABORATOR_NOT_FOUND',
          }, 404, rateLimitHeaders);
        }
        colaboradorId_final = colaboradorResult.rows[0].id;
        colaboradorNome = colaboradorResult.rows[0].nome;
      } else if (externalId) {
        // Modo Externo: Parsear externalId e não precisa de colaborador
        try {
          externalData = parseExternalId(externalId);
          isExternal = true;
          colaboradorNome = `Externo_${externalId}`;
        } catch (error) {
          return jsonResponse({
            success: false,
            error: 'Formato inválido para externalId. Use formato: prefixo_id',
            code: 'INVALID_EXTERNAL_ID_FORMAT',
          }, 400, rateLimitHeaders);
        }
      } else {
        return jsonResponse({
          success: false,
          error: 'Informe colaboradorId ou externalId',
          code: 'MISSING_IDENTIFIER',
        }, 400, rateLimitHeaders);
      }

      // Extrair encoding facial via InsightFace/ArcFace
      const { 
        encoding, 
        qualidade, 
        qualidadeDetalhada,
        error 
      } = await extractFaceEncoding(imagem);

      if (!encoding || error) {
        return jsonResponse({
          success: false,
          error: error || 'Não foi possível detectar a face na imagem',
          code: 'FACE_NOT_DETECTED',
          dica: 'Certifique-se de que o rosto está bem iluminado, centralizado e visível na câmera.',
        }, 400, rateLimitHeaders);
      }

      // Para cadastro adicional (câmera diferente), exigimos qualidade menor
      // Para cadastro principal, exigimos qualidade melhor
      const qualidadeMinima = adicional ? 0.25 : 0.4;
      if (qualidade < qualidadeMinima) {
        return jsonResponse({
          success: false,
          error: 'Qualidade da imagem insuficiente para cadastro. Por favor, capture uma imagem melhor.',
          code: 'LOW_QUALITY',
          qualidade,
          qualidadeDetalhada,
          minQualidade: qualidadeMinima,
          dicas: gerarDicasQualidade(qualidadeDetalhada),
        }, 400, rateLimitHeaders);
      }

      console.log(`[Cadastrar Face] Qualidade: ${qualidade}`);

      // Converter encoding para buffer
      const encodingBuffer = encodingToBuffer(encoding);

      // Salvar foto de referência no MinIO
      let fotoReferenciaUrl: string | null = null;
      try {
        const base64Data = imagem.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Detectar tipo de imagem
        let extensao = 'jpg';
        let contentType = 'image/jpeg';
        if (imagem.startsWith('data:image/png')) {
          extensao = 'png';
          contentType = 'image/png';
        } else if (imagem.startsWith('data:image/webp')) {
          extensao = 'webp';
          contentType = 'image/webp';
        }

        // Gerar caminho único (fuso horário Brasil)
        const agora = new Date();
        const opcoesBrasil = { timeZone: 'America/Sao_Paulo' };
        const dataFormatada = agora.toLocaleDateString('sv-SE', opcoesBrasil);
        const horaFormatada = agora.toLocaleTimeString('pt-BR', { 
          ...opcoesBrasil, 
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).replace(/:/g, '-');

        let caminho: string;
        if (isExternal) {
          caminho = `biometria/externos/${externalId}/${dataFormatada}_${horaFormatada}.${extensao}`;
        } else {
          caminho = `biometria/${colaboradorId_final}/${dataFormatada}_${horaFormatada}.${extensao}`;
        }

        fotoReferenciaUrl = await uploadArquivo(caminho, buffer, contentType);
        console.log(`[Cadastrar Face] Foto salva: ${fotoReferenciaUrl}`);
      } catch (uploadError) {
        console.warn('[Cadastrar Face] Erro ao salvar foto de referência:', uploadError);
        // Continua mesmo se falhar o upload - o encoding é mais importante
      }

      // ===============================================================
      // VERIFICAÇÃO DE REGISTRO EXISTENTE - Primeiro pelo identificador
      // ===============================================================
      
      let operacao: 'insert' | 'update' | 'merge' = 'insert';
      let registroExistenteId: number | null = null;
      let mergeInfo: { colaboradorIdExistente: number | null; externalIdsExistentes: Record<string, string> } | null = null;

      // SEMPRE verificar primeiro se já existe registro pelo identificador atual
      if (isExternal && externalData) {
        // Buscar por external_id com o mesmo prefixo E mesmo ID
        const existeResult = await query(
          `SELECT id FROM bluepoint.bt_biometria_facial 
           WHERE external_id @> $1::jsonb`,
          [JSON.stringify({ [externalData.prefixo]: externalData.id })]
        );
        if (existeResult.rows.length > 0) {
          operacao = 'update';
          registroExistenteId = existeResult.rows[0].id as number;
          console.log(`[Cadastrar Face] Registro existente encontrado pelo externalId: ${externalData.prefixo}_${externalData.id}, ID: ${registroExistenteId}`);
        }
      } else {
        const existeResult = await query(
          `SELECT id FROM bluepoint.bt_biometria_facial WHERE colaborador_id = $1`,
          [colaboradorId_final]
        );
        if (existeResult.rows.length > 0) {
          operacao = 'update';
          registroExistenteId = existeResult.rows[0].id as number;
          console.log(`[Cadastrar Face] Registro existente encontrado pelo colaboradorId: ${colaboradorId_final}, ID: ${registroExistenteId}`);
        }
      }

      // ===============================================================
      // VERIFICAÇÃO DE FACE - Busca se a mesma face já existe em OUTRO registro
      // ===============================================================
      
      // Buscar todos os encodings existentes no banco (exceto o registro atual se existir)
      const allEncodingsResult = await query(
        `SELECT id, colaborador_id, external_id, encoding 
         FROM bluepoint.bt_biometria_facial 
         WHERE encoding IS NOT NULL ${registroExistenteId ? 'AND id != $1' : ''}`,
        registroExistenteId ? [registroExistenteId] : []
      );

      // Converter para formato compatível com findBestMatchGeneric
      const existingEncodings: Array<{
        id: number;
        colaboradorId: number | null;
        externalIds: Record<string, string>;
        encoding: Float32Array;
      }> = [];

      for (const row of allEncodingsResult.rows) {
        try {
          const enc = bufferToEncoding(row.encoding as Buffer);
          existingEncodings.push({
            id: row.id as number,
            colaboradorId: row.colaborador_id as number | null,
            externalIds: row.external_id as Record<string, string> || {},
            encoding: enc,
          });
        } catch (e) {
          console.warn(`[Cadastrar Face] Erro ao converter encoding do registro ${row.id}:`, e);
        }
      }

      // Procurar se a face já existe em OUTRO registro
      if (existingEncodings.length > 0) {
        const threshold = calcularThresholdDinamico(qualidade);
        const faceMatch = await findBestMatchGeneric(encoding, existingEncodings, threshold);

        if (faceMatch) {
          // Face encontrada em OUTRO registro! Verificar se podemos fazer MERGE
          const matchRecord = faceMatch.match;
          
          console.log(`[Cadastrar Face] Face encontrada em OUTRO registro! ID: ${matchRecord.id}, ColabID: ${matchRecord.colaboradorId}, ExtIDs: ${JSON.stringify(matchRecord.externalIds)}, Distância: ${faceMatch.distance.toFixed(4)}`);

          if (isExternal && externalData) {
            // Cadastrando com externalId...
            if (matchRecord.externalIds[externalData.prefixo] && matchRecord.externalIds[externalData.prefixo] !== externalData.id) {
              // Já existe OUTRO ID para o mesmo prefixo → BLOQUEAR (possível pessoa diferente)
              return jsonResponse({
                success: false,
                error: `Esta face já está cadastrada com outro ${externalData.prefixo} (${matchRecord.externalIds[externalData.prefixo]}). Se você é essa pessoa, use o identificador correto.`,
                code: 'FACE_ALREADY_EXISTS',
                existingId: matchRecord.externalIds[externalData.prefixo],
              }, 409, rateLimitHeaders);
            } else if (!matchRecord.externalIds[externalData.prefixo]) {
              // Registro não tem este prefixo ainda → MERGE (vincular externalId ao registro existente)
              operacao = 'merge';
              registroExistenteId = matchRecord.id;
              mergeInfo = { 
                colaboradorIdExistente: matchRecord.colaboradorId, 
                externalIdsExistentes: matchRecord.externalIds 
              };
              console.log(`[Cadastrar Face] MERGE: Vinculando ${externalData.prefixo}_${externalData.id} ao registro ${matchRecord.id}`);
            }
            // Se externalIds[prefixo] === externalData.id, é a mesma pessoa atualizando → continua normal
          } else {
            // Cadastrando com colaboradorId...
            if (matchRecord.colaboradorId && matchRecord.colaboradorId !== colaboradorId_final) {
              // Já existe OUTRO colaborador_id → BLOQUEAR (possível pessoa diferente)
              return jsonResponse({
                success: false,
                error: `Esta face já está cadastrada para outro colaborador (ID: ${matchRecord.colaboradorId}). Se você é essa pessoa, faça login com a conta correta.`,
                code: 'FACE_ALREADY_EXISTS',
                existingColaboradorId: matchRecord.colaboradorId,
              }, 409, rateLimitHeaders);
            } else if (!matchRecord.colaboradorId && Object.keys(matchRecord.externalIds).length > 0) {
              // Registro só tem external_ids → MERGE (vincular colaboradorId ao registro existente)
              operacao = 'merge';
              registroExistenteId = matchRecord.id;
              mergeInfo = { 
                colaboradorIdExistente: null, 
                externalIdsExistentes: matchRecord.externalIds 
              };
              console.log(`[Cadastrar Face] MERGE: Vinculando colaboradorId=${colaboradorId_final} ao registro ${matchRecord.id}`);
            }
            // Se colaboradorId === colaboradorId_final, é a mesma pessoa atualizando → continua normal
          }
        }
      }

      console.log(`[Cadastrar Face] Operação: ${operacao}, RegistroID: ${registroExistenteId}, Adicional: ${adicional}`);

      // ===============================================================
      // MODO ADICIONAL: Adicionar encoding extra ao registro existente
      // ===============================================================
      if (adicional && registroExistenteId) {
        // Verificar quantos encodings extras já existem (máximo 5)
        const countResult = await query(
          `SELECT total_encodings FROM bluepoint.bt_biometria_facial WHERE id = $1`,
          [registroExistenteId]
        );
        const totalAtual = countResult.rows[0]?.total_encodings || 1;
        
        if (totalAtual >= 6) {
          return jsonResponse({
            success: false,
            error: 'Limite de 6 encodings (1 principal + 5 extras) atingido. Remova um encoding extra ou recadastre a face principal.',
            code: 'MAX_ENCODINGS_REACHED',
            totalEncodings: totalAtual,
          }, 400, rateLimitHeaders);
        }

        await query(
          `UPDATE bluepoint.bt_biometria_facial 
           SET encodings_extras = array_append(encodings_extras, $1),
               qualidades_extras = array_append(qualidades_extras, $2),
               total_encodings = total_encodings + 1,
               atualizado_em = NOW()
           WHERE id = $3`,
          [encodingBuffer, qualidade, registroExistenteId]
        );

        // Invalidar cache
        await cacheDel(CACHE_KEYS.BIOMETRIA_ENCODINGS);

        // Registrar auditoria
        if (user) {
          await registrarAuditoria({
            usuarioId: user.userId,
            acao: 'editar',
            modulo: 'biometria',
            descricao: `Encoding adicional cadastrado para: ${colaboradorNome} (total: ${totalAtual + 1})`,
            ip: getClientIp(request),
            userAgent: getUserAgent(request),
            dadosNovos: { colaboradorId: colaboradorId_final, qualidade, totalEncodings: totalAtual + 1 },
          });
        }

        return jsonResponse({
          success: true,
          data: {
            colaboradorId: colaboradorId_final,
            qualidade,
            qualidadeDetalhada,
            fotoReferencia: fotoReferenciaUrl,
            operacao: 'adicional',
            totalEncodings: totalAtual + 1,
            mensagem: `Encoding adicional cadastrado com sucesso! Total: ${totalAtual + 1} encodings.`,
            dica: 'Quanto mais encodings de câmeras/condições diferentes, melhor o reconhecimento.',
            processedIn: Date.now() - startTime,
          },
        }, 200, rateLimitHeaders);
      }

      // Se é modo adicional mas não tem registro existente, faz insert normal
      if (adicional && !registroExistenteId) {
        console.log(`[Cadastrar Face] Modo adicional sem registro existente - criando registro principal.`);
      }

      // ===============================================================
      // EXECUTAR OPERAÇÃO NO BANCO (modo principal - sobrescreve)
      // ===============================================================

      if (operacao === 'merge' && registroExistenteId && mergeInfo) {
        // MERGE: Adicionar novo identificador ao registro existente (mesma pessoa, sistemas diferentes)
        if (isExternal && externalData) {
          // Adicionar external_id ao registro que pode ter colaborador_id
          await query(
            `UPDATE bluepoint.bt_biometria_facial 
             SET external_id = jsonb_set(COALESCE(external_id, '{}'::jsonb), $1, $2),
                 encoding = $3, qualidade = $4, foto_referencia_url = $5, atualizado_em = NOW()
             WHERE id = $6`,
            [[externalData.prefixo], JSON.stringify(externalData.id), encodingBuffer, qualidade, fotoReferenciaUrl, registroExistenteId]
          );
          console.log(`[Cadastrar Face] MERGE: Adicionado ${externalData.prefixo}:${externalData.id} ao registro ${registroExistenteId}`);
        } else {
          // Adicionar colaborador_id ao registro que só tem external_ids
          await query(
            `UPDATE bluepoint.bt_biometria_facial 
             SET colaborador_id = $1, encoding = $2, qualidade = $3, foto_referencia_url = $4, atualizado_em = NOW()
             WHERE id = $5`,
            [colaboradorId_final, encodingBuffer, qualidade, fotoReferenciaUrl, registroExistenteId]
          );
          console.log(`[Cadastrar Face] MERGE: Adicionado colaboradorId=${colaboradorId_final} ao registro ${registroExistenteId}`);
          
          // Atualizar flag no colaborador
          await query(
            `UPDATE bluepoint.bt_colaboradores SET face_registrada = true, atualizado_em = NOW() WHERE id = $1`,
            [colaboradorId_final]
          );
        }
      } else if (operacao === 'update' && registroExistenteId) {
        // UPDATE: Atualizar registro existente
        if (isExternal && externalData) {
          await query(
            `UPDATE bluepoint.bt_biometria_facial 
             SET external_id = jsonb_set(COALESCE(external_id, '{}'::jsonb), $1, $2),
                 encoding = $3, qualidade = $4, foto_referencia_url = $5, atualizado_em = NOW()
             WHERE id = $6`,
            [[externalData.prefixo], JSON.stringify(externalData.id), encodingBuffer, qualidade, fotoReferenciaUrl, registroExistenteId]
          );
        } else {
          await query(
            `UPDATE bluepoint.bt_biometria_facial 
             SET encoding = $1, qualidade = $2, foto_referencia_url = $3, atualizado_em = NOW()
             WHERE id = $4`,
            [encodingBuffer, qualidade, fotoReferenciaUrl, registroExistenteId]
          );
          
          // Atualizar flag no colaborador
          await query(
            `UPDATE bluepoint.bt_colaboradores SET face_registrada = true, atualizado_em = NOW() WHERE id = $1`,
            [colaboradorId_final]
          );
        }
      } else {
        // INSERT: Criar novo registro
        if (isExternal && externalData) {
          // Construir o JSON no JavaScript e passar como string para o PostgreSQL
          const externalIdJson = JSON.stringify({ [externalData.prefixo]: externalData.id });
          await query(
            `INSERT INTO bluepoint.bt_biometria_facial (external_id, encoding, qualidade, foto_referencia_url)
             VALUES ($1::jsonb, $2, $3, $4)`,
            [externalIdJson, encodingBuffer, qualidade, fotoReferenciaUrl]
          );
        } else {
          await query(
            `INSERT INTO bluepoint.bt_biometria_facial (colaborador_id, encoding, qualidade, foto_referencia_url)
             VALUES ($1, $2, $3, $4)`,
            [colaboradorId_final, encodingBuffer, qualidade, fotoReferenciaUrl]
          );
          
          // Atualizar flag no colaborador
          await query(
            `UPDATE bluepoint.bt_colaboradores SET face_registrada = true, atualizado_em = NOW() WHERE id = $1`,
            [colaboradorId_final]
          );
        }
      }

      // IMPORTANTE: Invalidar cache de encodings para que nova face seja considerada
      await cacheDel(CACHE_KEYS.BIOMETRIA_ENCODINGS);

      // Montar dados finais para resposta
      let finalColaboradorId: number | null = colaboradorId_final;
      let finalExternalIds: Record<string, string> = {};
      
      if (operacao === 'merge' && mergeInfo) {
        // No merge, combinar os IDs
        finalColaboradorId = colaboradorId_final || mergeInfo.colaboradorIdExistente;
        finalExternalIds = { ...mergeInfo.externalIdsExistentes };
        if (isExternal && externalData) {
          finalExternalIds[externalData.prefixo] = externalData.id;
        }
      } else if (isExternal && externalData) {
        finalExternalIds[externalData.prefixo] = externalData.id;
      }

      // Registrar auditoria (só se tiver user JWT)
      if (user) {
        await registrarAuditoria({
          usuarioId: user.userId,
          acao: operacao === 'insert' ? 'CREATE' : 'UPDATE',
          modulo: 'biometria',
          descricao: operacao === 'merge' 
            ? `Face vinculada (merge): colaboradorId=${finalColaboradorId}, externalIds=${JSON.stringify(finalExternalIds)}`
            : `Face ${operacao === 'insert' ? 'cadastrada' : 'atualizada'} para: ${colaboradorNome}`,
          ip: getClientIp(request),
          userAgent: getUserAgent(request),
          dadosNovos: { colaboradorId: finalColaboradorId, externalIds: finalExternalIds, qualidade, operacao },
        });
      }

      // Definir mensagem baseada na operação
      let mensagem = 'Face cadastrada com sucesso';
      if (operacao === 'merge') {
        mensagem = 'Face vinculada com sucesso ao registro existente';
      } else if (operacao === 'update') {
        mensagem = 'Face atualizada com sucesso';
      }

      return jsonResponse({
        success: true,
        data: {
          colaboradorId: finalColaboradorId,
          externalIds: finalExternalIds,
          qualidade,
          qualidadeDetalhada,
          fotoReferencia: fotoReferenciaUrl,
          operacao, // 'insert' | 'update' | 'merge'
          mensagem,
          processedIn: Date.now() - startTime,
        },
      }, operacao === 'insert' ? 201 : 200, rateLimitHeaders);

    } catch (error) {
      console.error('Erro ao cadastrar face:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao processar cadastro facial',
        code: 'INTERNAL_ERROR',
      }, 500, rateLimitHeaders);
    }
  });
}

// Suporte a OPTIONS para CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
