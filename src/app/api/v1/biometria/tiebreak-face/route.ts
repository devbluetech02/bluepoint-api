import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query } from '@/lib/db';
import {
  bufferToEncoding,
  extractFaceEncoding,
  findTopMatchesByPerson,
} from '@/lib/face-recognition';
import {
  cacheGet,
  cacheSet,
  CACHE_KEYS,
  CACHE_TTL,
  checkRateLimit,
} from '@/lib/cache';
import {
  escolherCandidatoComLLM,
  type TiebreakCandidate,
} from '@/lib/face-llm-verify';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { logFaceEventAsync, uploadFotoFaceLog } from '@/lib/face-log';

/**
 * POST /api/v1/biometria/tiebreak-face
 *
 * Fluxo de fallback "não sou eu". Cliente chama quando o usuário
 * rejeita o match inicial. Aqui:
 *  1) Extrai o encoding da foto capturada (mesma do match falho).
 *  2) Procura top-10 pessoas no banco, filtra distância <= 0.65,
 *     remove os rejeitados, mantém top-7.
 *  3) Pede pra um modelo de visão grande (Sonnet 4.5 default)
 *     escolher quem é. Modelo recebe nomes + ranking ArcFace + fotos.
 *  4) Se acertou alguém, salva a resolução em Redis com TTL 60s sob
 *     um sessionId UUID e devolve pra cliente. Cliente exibe modal
 *     "É você, [Nome]?" e ao confirmar bate em /tiebreak-confirmar
 *     com o sessionId.
 *  5) Se ninguém parecido, devolve TIEBREAK_NO_MATCH e cliente
 *     mostra opções "cadastrar minha face" / "chamar gestor".
 *
 * Limite implícito: cliente só deve chamar 1 vez por sessão (o
 * frontend deve travar a UI). Mesmo assim auditamos cada tentativa.
 */

const schema = z.object({
  imagem: z.string().min(100),
  rejeitadosColaboradorIds: z.array(z.number().int().positive()).optional(),
  rejeitadosExternalKeys: z.array(z.string()).optional(),
  dispositivoCodigo: z.string().length(6).toUpperCase().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

interface CachedEncoding {
  colaboradorId: number | null;
  externalIds: Record<string, string>;
  encoding: number[];
  encodingsExtras: number[][];
  encodingsAprendidos: number[][];
  qualidadesAprendidos: number[];
  totalAprendidos: number;
}

export interface TiebreakSession {
  imagem: string; // data URI da foto capturada (pra usar no auto-aprendizado e foto da marcação)
  colaboradorId: number | null;
  candidato: {
    id: number;
    nome: string;
    foto: string | null;
    cargoNome: string | null;
    departamentoNome: string | null;
    empresaId: number | null;
    permitePontoMobile: boolean;
  };
  llm: {
    model: string;
    confidence: number;
    reason: string;
  };
  expiresAt: number;
}

const SESSION_PREFIX = 'tiebreak:session:';
const SESSION_TTL = 60; // 60s
const MAX_DISTANCE = 0.65;
const TOP_N_AFTER_FILTER = 7;

function jsonResponse(data: object, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const clientIp = getClientIp(request);
  try {
    const rateLimit = await checkRateLimit(`biometria:tiebreak:${clientIp}`, 6, 60);
    if (!rateLimit.allowed) {
      return jsonResponse(
        {
          success: false,
          error: 'Muitas tentativas. Aguarde alguns segundos.',
          code: 'RATE_LIMIT_EXCEEDED',
        },
        429,
      );
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return jsonResponse({ success: false, error: 'JSON inválido', code: 'INVALID_JSON' }, 400);
    }
    const validation = schema.safeParse(body);
    if (!validation.success) {
      return jsonResponse(
        {
          success: false,
          error: 'Erro de validação',
          code: 'VALIDATION_ERROR',
          details: validation.error.issues,
        },
        422,
      );
    }
    const {
      imagem,
      rejeitadosColaboradorIds = [],
      rejeitadosExternalKeys = [],
    } = validation.data;

    // Extrair encoding da foto capturada
    const { encoding, qualidade, error } = await extractFaceEncoding(imagem);
    if (!encoding || error) {
      return jsonResponse(
        {
          success: false,
          error: error || 'Nenhuma face detectada na imagem',
          code: 'FACE_NOT_DETECTED',
        },
        400,
      );
    }

    // Carregar encodings (mesmo padrão do verificar-face)
    let encodingsCached: CachedEncoding[] | null = await cacheGet<CachedEncoding[]>(
      CACHE_KEYS.BIOMETRIA_ENCODINGS,
    );
    if (!encodingsCached) {
      // Mesma trava de inativos do /verificar-face: registros com
      // colaborador_id != null exigem status='ativo'. Externos puros
      // continuam passando (colaborador_id IS NULL).
      const r = await query(
        `SELECT bf.colaborador_id, bf.external_id, bf.encoding, bf.encodings_extras,
                bf.encodings_aprendidos, bf.qualidades_aprendidos, bf.total_aprendidos
           FROM people.biometria_facial bf
           LEFT JOIN people.colaboradores c ON bf.colaborador_id = c.id
          WHERE bf.encoding IS NOT NULL
            AND (
              bf.colaborador_id IS NULL
              OR c.status = 'ativo'
            )`,
      );
      encodingsCached = r.rows.map((row) => {
        const extras: number[][] = [];
        if (row.encodings_extras && Array.isArray(row.encodings_extras)) {
          for (const buf of row.encodings_extras) {
            try {
              const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
              extras.push(Array.from(bufferToEncoding(b)));
            } catch {
              /* ignore */
            }
          }
        }
        const aprendidos: number[][] = [];
        if (row.encodings_aprendidos && Array.isArray(row.encodings_aprendidos)) {
          for (const buf of row.encodings_aprendidos) {
            try {
              const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
              aprendidos.push(Array.from(bufferToEncoding(b)));
            } catch {
              /* ignore */
            }
          }
        }
        return {
          colaboradorId: row.colaborador_id as number | null,
          externalIds: (row.external_id as Record<string, string>) || {},
          encoding: Array.from(bufferToEncoding(row.encoding)),
          encodingsExtras: extras,
          encodingsAprendidos: aprendidos,
          qualidadesAprendidos: [],
          totalAprendidos: row.total_aprendidos || 0,
        };
      });
      await cacheSet(CACHE_KEYS.BIOMETRIA_ENCODINGS, encodingsCached, CACHE_TTL.LONG);
    }

    if (encodingsCached.length === 0) {
      return jsonResponse({
        success: true,
        data: {
          matched: false,
          code: 'TIEBREAK_NO_MATCH',
          mensagem: 'Nenhum colaborador cadastrado com biometria.',
        },
      });
    }

    // Achatar todos os encodings (principal + extras + aprendidos)
    const encodingsFloat: Array<{
      colaboradorId: number | null;
      externalIds: Record<string, string>;
      encoding: Float32Array;
    }> = [];
    for (const e of encodingsCached) {
      encodingsFloat.push({
        colaboradorId: e.colaboradorId,
        externalIds: e.externalIds,
        encoding: new Float32Array(e.encoding),
      });
      for (const ex of e.encodingsExtras) {
        if (ex.length > 0) {
          encodingsFloat.push({
            colaboradorId: e.colaboradorId,
            externalIds: e.externalIds,
            encoding: new Float32Array(ex),
          });
        }
      }
      for (const ap of e.encodingsAprendidos) {
        if (ap.length > 0) {
          encodingsFloat.push({
            colaboradorId: e.colaboradorId,
            externalIds: e.externalIds,
            encoding: new Float32Array(ap),
          });
        }
      }
    }

    const personKey = (item: (typeof encodingsFloat)[number]) =>
      item.colaboradorId !== null
        ? `c:${item.colaboradorId}`
        : `e:${JSON.stringify(item.externalIds)}`;

    const top10 = await findTopMatchesByPerson(encoding, encodingsFloat, personKey, 10);
    const rejeitadosKeys = new Set<string>([
      ...rejeitadosColaboradorIds.map((id) => `c:${id}`),
      ...rejeitadosExternalKeys.map((k) => `e:${k}`),
    ]);
    const filtrados = top10
      .filter((m) => m.distance <= MAX_DISTANCE)
      .filter((m) => !rejeitadosKeys.has(m.key))
      .slice(0, TOP_N_AFTER_FILTER);

    if (filtrados.length === 0) {
      return jsonResponse({
        success: true,
        data: {
          matched: false,
          code: 'TIEBREAK_NO_MATCH',
          mensagem: 'Nenhum candidato próximo o suficiente para confirmar.',
          qualidadeCaptura: qualidade,
          processedIn: Date.now() - startTime,
        },
      });
    }

    // Buscar dados (nome + foto referência) de cada candidato
    const colabIds = filtrados
      .map((m) => m.match.colaboradorId)
      .filter((id): id is number => typeof id === 'number');
    const externalKeys = filtrados
      .filter((m) => m.match.colaboradorId === null)
      .map((m) => Object.keys(m.match.externalIds)[0]);

    const dadosColabsResult = colabIds.length
      ? await query<{
          colaborador_id: number;
          nome: string;
          foto_url: string | null;
          cargo_nome: string | null;
          departamento_nome: string | null;
          empresa_id: number | null;
          permite_ponto_mobile: boolean | null;
          foto_referencia_url: string | null;
        }>(
          `SELECT bf.colaborador_id,
                  c.nome,
                  c.foto_url,
                  cg.nome AS cargo_nome,
                  d.nome AS departamento_nome,
                  c.empresa_id,
                  c.permite_ponto_mobile,
                  bf.foto_referencia_url
             FROM people.biometria_facial bf
             JOIN people.colaboradores c ON c.id = bf.colaborador_id
             LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
             LEFT JOIN people.departamentos d ON d.id = c.departamento_id
            WHERE bf.colaborador_id = ANY($1::int[])
              AND c.status = 'ativo'`,
          [colabIds],
        )
      : { rows: [] as Array<{
          colaborador_id: number;
          nome: string;
          foto_url: string | null;
          cargo_nome: string | null;
          departamento_nome: string | null;
          empresa_id: number | null;
          permite_ponto_mobile: boolean | null;
          foto_referencia_url: string | null;
        }> };
    const dadosColabs = new Map(dadosColabsResult.rows.map((r) => [r.colaborador_id, r]));

    const dadosExternosResult = externalKeys.length
      ? await query<{
          external_id: Record<string, string>;
          foto_referencia_url: string | null;
        }>(
          `SELECT external_id, foto_referencia_url
             FROM people.biometria_facial
            WHERE colaborador_id IS NULL
              AND external_id ?| $1::text[]`,
          [externalKeys],
        )
      : { rows: [] as Array<{ external_id: Record<string, string>; foto_referencia_url: string | null }> };

    const candidates: TiebreakCandidate[] = filtrados.map((m, idx) => {
      const cId = m.match.colaboradorId;
      if (cId !== null) {
        const dc = dadosColabs.get(cId);
        return {
          index: idx,
          colaboradorId: cId,
          externalIds: m.match.externalIds,
          nome: dc?.nome ?? `Colaborador ${cId}`,
          distancia: m.distance,
          fotoReferenciaUrl: dc?.foto_referencia_url ?? dc?.foto_url ?? null,
        };
      }
      const externalKey = Object.keys(m.match.externalIds)[0];
      const externalRef = dadosExternosResult.rows.find((row) =>
        row.external_id && externalKey in row.external_id,
      );
      return {
        index: idx,
        colaboradorId: null,
        externalIds: m.match.externalIds,
        nome: externalKey ? `Candidato externo ${externalKey}:${m.match.externalIds[externalKey]}` : 'Candidato externo',
        distancia: m.distance,
        fotoReferenciaUrl: externalRef?.foto_referencia_url ?? null,
      };
    });

    const llmResult = await escolherCandidatoComLLM({
      capturedDataUri: imagem,
      candidates,
    });

    if (!llmResult || llmResult.matchedIndex === null) {
      await registrarAuditoria({
        usuarioId: null,
        acao: 'criar',
        modulo: 'registro_ponto',
        descricao: `Tiebreak facial: LLM não identificou correspondente entre ${candidates.length} candidatos`,
        ip: clientIp,
        userAgent: getUserAgent(request),
        entidadeTipo: 'biometria',
        metadados: {
          candidatos: candidates.map((c) => ({
            colaboradorId: c.colaboradorId,
            distancia: c.distancia,
          })),
          llmModel: llmResult?.model ?? null,
          llmReason: llmResult?.reason ?? null,
          rejeitadosColaboradorIds,
          rejeitadosExternalKeys,
        },
      });
      (async () => {
        const fotoUrl = await uploadFotoFaceLog(
          imagem,
          'TIEBREAK_NO_MATCH',
          validation.data.dispositivoCodigo,
        );
        logFaceEventAsync({
          evento: 'TIEBREAK_NO_MATCH',
          endpoint: 'tiebreak-face',
          ip: clientIp,
          userAgent: getUserAgent(request),
          dispositivoCodigo: validation.data.dispositivoCodigo,
          latitude: validation.data.latitude,
          longitude: validation.data.longitude,
          qualidade,
          llmModelo: llmResult?.model ?? null,
          llmConfirmou: llmResult ? false : null,
          llmConfidence: llmResult?.confidence ?? null,
          llmRazao: llmResult?.reason ?? null,
          llmLatencyMs: llmResult?.latencyMs ?? null,
          fotoUrl,
          duracaoMs: Date.now() - startTime,
          metadados: {
            candidatosConsiderados: candidates.length,
            candidatos: candidates.map((c) => ({
              colaboradorId: c.colaboradorId,
              distancia: c.distancia,
            })),
            rejeitadosColaboradorIds,
          },
        });
      })().catch((e) => console.error('[TIEBREAK_NO_MATCH log] falha:', e));
      return jsonResponse({
        success: true,
        data: {
          matched: false,
          code: 'TIEBREAK_NO_MATCH',
          mensagem:
            llmResult?.reason ||
            'Não conseguimos confirmar sua identidade entre os colaboradores cadastrados.',
          candidatosConsiderados: candidates.length,
          llm: llmResult
            ? { model: llmResult.model, reason: llmResult.reason, confidence: llmResult.confidence }
            : null,
          qualidadeCaptura: qualidade,
          processedIn: Date.now() - startTime,
        },
      });
    }

    const escolhido = candidates[llmResult.matchedIndex];
    if (!escolhido || escolhido.colaboradorId === null) {
      // O escolhido é um registro externo (sem colaborador no People).
      // Não dá pra registrar ponto — devolve no_match com motivo.
      return jsonResponse({
        success: true,
        data: {
          matched: false,
          code: 'TIEBREAK_NO_MATCH',
          mensagem: 'O candidato mais parecido ainda não tem cadastro no People.',
          processedIn: Date.now() - startTime,
        },
      });
    }

    const dadosColab = dadosColabs.get(escolhido.colaboradorId);
    if (!dadosColab) {
      return jsonResponse({
        success: true,
        data: {
          matched: false,
          code: 'TIEBREAK_NO_MATCH',
          mensagem: 'Colaborador escolhido não está mais ativo.',
          processedIn: Date.now() - startTime,
        },
      });
    }

    // Salvar sessão de tiebreak no Redis (60s)
    const sessionId = randomUUID();
    const session: TiebreakSession = {
      imagem,
      colaboradorId: escolhido.colaboradorId,
      candidato: {
        id: dadosColab.colaborador_id,
        nome: dadosColab.nome,
        foto: dadosColab.foto_url,
        cargoNome: dadosColab.cargo_nome,
        departamentoNome: dadosColab.departamento_nome,
        empresaId: dadosColab.empresa_id,
        permitePontoMobile: dadosColab.permite_ponto_mobile === true,
      },
      llm: {
        model: llmResult.model,
        confidence: llmResult.confidence,
        reason: llmResult.reason,
      },
      expiresAt: Date.now() + SESSION_TTL * 1000,
    };
    await cacheSet(`${SESSION_PREFIX}${sessionId}`, session, SESSION_TTL);

    await registrarAuditoria({
      usuarioId: null,
      acao: 'criar',
      modulo: 'registro_ponto',
      descricao: `Tiebreak facial: LLM escolheu ${dadosColab.nome} entre ${candidates.length} candidatos (conf=${llmResult.confidence}, dist=${escolhido.distancia.toFixed(4)}). Aguardando confirmação do usuário.`,
      ip: clientIp,
      userAgent: getUserAgent(request),
      colaboradorId: escolhido.colaboradorId,
      colaboradorNome: dadosColab.nome,
      entidadeTipo: 'biometria',
      metadados: {
        sessionId,
        candidatos: candidates.map((c) => ({
          colaboradorId: c.colaboradorId,
          nome: c.nome,
          distancia: c.distancia,
        })),
        llmModel: llmResult.model,
        llmReason: llmResult.reason,
        llmConfidence: llmResult.confidence,
        rejeitadosColaboradorIds,
        rejeitadosExternalKeys,
      },
    });

    (async () => {
      const fotoUrl = await uploadFotoFaceLog(
        imagem,
        'TIEBREAK_PROPOSED',
        validation.data.dispositivoCodigo,
      );
      logFaceEventAsync({
        evento: 'TIEBREAK_PROPOSED',
        endpoint: 'tiebreak-face',
        ip: clientIp,
        userAgent: getUserAgent(request),
        dispositivoCodigo: validation.data.dispositivoCodigo,
        latitude: validation.data.latitude,
        longitude: validation.data.longitude,
        qualidade,
        colaboradorIdProposto: escolhido.colaboradorId,
        distanciaTop1: escolhido.distancia,
        llmModelo: llmResult.model,
        llmConfirmou: true,
        llmConfidence: llmResult.confidence,
        llmRazao: llmResult.reason,
        llmLatencyMs: llmResult.latencyMs,
        fotoUrl,
        duracaoMs: Date.now() - startTime,
        metadados: {
          sessionId,
          candidatos: candidates.map((c) => ({
            colaboradorId: c.colaboradorId,
            distancia: c.distancia,
          })),
          rejeitadosColaboradorIds,
        },
      });
    })().catch((e) => console.error('[TIEBREAK_PROPOSED log] falha:', e));
    return jsonResponse({
      success: true,
      data: {
        matched: true,
        code: 'TIEBREAK_MATCH',
        sessionId,
        ttlSegundos: SESSION_TTL,
        candidato: {
          id: dadosColab.colaborador_id,
          nome: dadosColab.nome,
          cargo: dadosColab.cargo_nome,
          departamento: dadosColab.departamento_nome,
          foto: dadosColab.foto_url,
        },
        candidatosConsiderados: candidates.length,
        distanciaArcFace: escolhido.distancia,
        llm: {
          model: llmResult.model,
          confidence: llmResult.confidence,
          reason: llmResult.reason,
        },
        qualidadeCaptura: qualidade,
        processedIn: Date.now() - startTime,
      },
    });
  } catch (e) {
    console.error('[tiebreak-face] erro:', e);
    return jsonResponse(
      { success: false, error: 'Erro interno', code: 'INTERNAL_ERROR' },
      500,
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
