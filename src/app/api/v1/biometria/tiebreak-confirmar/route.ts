import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import {
  cacheGet,
  cacheDel,
  cacheDelPattern,
  invalidateMarcacaoCache,
  CACHE_KEYS,
  checkRateLimit,
} from '@/lib/cache';
import {
  bufferToEncoding,
  compareFaces,
  encodingToBuffer,
  extractFaceEncoding,
} from '@/lib/face-recognition';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { uploadArquivo } from '@/lib/storage';
import { embedTableRowAfterInsert } from '@/lib/embeddings';
import { tipoPontoBiometriaSchema } from '@/lib/validation';
import type { TiebreakSession } from '../tiebreak-face/route';

/**
 * POST /api/v1/biometria/tiebreak-confirmar
 *
 * Segunda etapa do fluxo "não sou eu". Cliente confirma o candidato
 * sugerido pelo LLM e o backend:
 *  1) Valida o sessionId (existência + TTL no Redis).
 *  2) Faz upload da foto capturada (na sessão).
 *  3) Detecta o tipo do ponto (entrada/saida/almoço/retorno).
 *  4) Insere a marcação atribuída ao colaborador escolhido.
 *  5) Em background, dispara auto-aprendizado pra somar o encoding
 *     capturado ao registro do colaborador — assim, num próximo
 *     scan, o ArcFace bate direto sem precisar do tiebreak.
 *  6) Invalida cache de marcações + sessão.
 */

const SESSION_PREFIX = 'tiebreak:session:';

const schema = z.object({
  sessionId: z.string().uuid(),
  dispositivoCodigo: z.string().length(6).toUpperCase().optional(),
  tipoPonto: tipoPontoBiometriaSchema,
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  origem: z.string().optional(),
});

interface Dispositivo {
  id: number;
  nome: string;
  status: string;
  permite_entrada: boolean;
  permite_saida: boolean;
  empresa_id: number | null;
}

function jsonResponse(data: object, status = 200) {
  return NextResponse.json(data, { status });
}

async function detectarTipoPonto(
  colaboradorId: number,
): Promise<'entrada' | 'saida' | 'almoco' | 'retorno'> {
  const r = await query(
    `SELECT tipo FROM people.marcacoes
       WHERE colaborador_id = $1
         AND DATE(data_hora) = CURRENT_DATE
       ORDER BY data_hora ASC`,
    [colaboradorId],
  );
  if (r.rows.length === 0) return 'entrada';
  const ultimo = r.rows[r.rows.length - 1].tipo;
  const teveAlmoco = r.rows.some((m) => m.tipo === 'almoco');
  const teveRetorno = r.rows.some((m) => m.tipo === 'retorno');
  const teveSaida = r.rows.some((m) => m.tipo === 'saida');
  if (ultimo === 'entrada' && !teveAlmoco) return 'almoco';
  if (ultimo === 'almoco' && !teveRetorno) return 'retorno';
  if (ultimo === 'retorno') return 'saida';
  if (ultimo === 'saida') return 'saida';
  if (teveSaida) return 'saida';
  return ultimo === 'entrada' || ultimo === 'retorno' ? 'saida' : 'entrada';
}

async function validarDispositivo(
  codigo: string,
): Promise<{ valido: boolean; dispositivo?: Dispositivo; erro?: string; code?: string }> {
  const result = await query(
    `SELECT id, nome, status, permite_entrada, permite_saida, empresa_id
       FROM people.dispositivos WHERE codigo = $1`,
    [codigo],
  );
  if (result.rows.length === 0) {
    return { valido: false, erro: 'Dispositivo não encontrado', code: 'DEVICE_NOT_FOUND' };
  }
  const d = result.rows[0] as Dispositivo;
  if (d.status === 'inativo') return { valido: false, erro: 'Dispositivo inativo', code: 'DEVICE_INACTIVE' };
  if (d.status === 'bloqueado') return { valido: false, erro: 'Dispositivo bloqueado', code: 'DEVICE_BLOCKED' };
  return { valido: true, dispositivo: d };
}

async function inserirMarcacao(args: {
  colaboradorId: number;
  tipo: 'entrada' | 'saida' | 'almoco' | 'retorno';
  dispositivo: Dispositivo | null;
  empresaId: number | null;
  latitude?: number;
  longitude?: number;
  fotoUrl: string | null;
  clientIp?: string | null;
}) {
  const sequenciaResult = await query(
    `SELECT COUNT(*)::int AS count FROM people.marcacoes
       WHERE colaborador_id = $1
         AND DATE(data_hora) = CURRENT_DATE`,
    [args.colaboradorId],
  );
  const sequencia = (sequenciaResult.rows[0]?.count ?? 0) + 1;

  const result = await query(
    `INSERT INTO people.marcacoes (
       colaborador_id, data_hora, tipo, latitude, longitude,
       metodo, dispositivo_id, empresa_id, foto_url, criado_em
     ) VALUES ($1, NOW(), $2, $3, $4, 'biometria', $5, $6, $7, NOW())
     RETURNING id`,
    [
      args.colaboradorId,
      args.tipo,
      args.latitude ?? null,
      args.longitude ?? null,
      args.dispositivo?.id ?? null,
      args.dispositivo?.empresa_id ?? args.empresaId ?? null,
      args.fotoUrl,
    ],
  );

  if (args.dispositivo) {
    await query(
      `UPDATE people.dispositivos
          SET total_registros = total_registros + 1,
              ultimo_acesso = NOW(),
              ip_ultimo_acesso = $1
        WHERE id = $2`,
      [args.clientIp ?? null, args.dispositivo.id],
    );
  }

  const marcacaoId = result.rows[0].id;
  await invalidateMarcacaoCache(args.colaboradorId);
  await cacheDelPattern(`${CACHE_KEYS.ATRASOS_TOLERADOS}*`);
  embedTableRowAfterInsert('marcacoes', marcacaoId).catch(() => {});

  return { marcacaoId, tipo: args.tipo, sequencia };
}

/**
 * Auto-aprende o encoding capturado pro colaborador escolhido.
 * Roda em background (não bloqueia a resposta).
 */
// Mesmas constantes da face-recognition.ts (mantidas em sync — após
// incidente de cluster contaminado em 2026-05-06, qualquer caminho
// de auto-aprendizado precisa respeitar esses tetos).
const MAX_ENCODINGS_APRENDIDOS = 20;
const AUTO_APRENDER_MIN_QUALIDADE = 0.50;
const DIVERSIDADE_MINIMA_TIEBREAK = 0.08;

async function autoAprenderEncoding(
  colaboradorId: number,
  imagem: string,
): Promise<void> {
  try {
    const ext = await extractFaceEncoding(imagem);
    if (!ext.encoding) return;
    if (ext.qualidade < AUTO_APRENDER_MIN_QUALIDADE) {
      console.log(
        `[Tiebreak Auto-Aprendizado] Pulando — qualidade ${ext.qualidade.toFixed(3)} < ${AUTO_APRENDER_MIN_QUALIDADE}`,
      );
      return;
    }

    const bioResult = await query<{
      id: number;
      encoding: Buffer | null;
      encodings_extras: Buffer[] | null;
      encodings_aprendidos: Buffer[] | null;
      total_aprendidos: number | null;
    }>(
      `SELECT id, encoding, encodings_extras, encodings_aprendidos, total_aprendidos
         FROM people.biometria_facial WHERE colaborador_id = $1 LIMIT 1`,
      [colaboradorId],
    );
    if (bioResult.rows.length === 0) return;
    const bio = bioResult.rows[0];

    if ((bio.total_aprendidos ?? 0) >= MAX_ENCODINGS_APRENDIDOS) {
      console.log(
        `[Tiebreak Auto-Aprendizado] Pulando — já tem ${bio.total_aprendidos} aprendidos (cap=${MAX_ENCODINGS_APRENDIDOS})`,
      );
      return;
    }

    // Verificar diversidade — pula se já é muito parecido com algum encoding
    // existente (não acrescenta informação nova).
    const todos: Float32Array[] = [];
    if (bio.encoding) {
      try {
        todos.push(bufferToEncoding(Buffer.isBuffer(bio.encoding) ? bio.encoding : Buffer.from(bio.encoding)));
      } catch {
        /* ignore */
      }
    }
    for (const buf of bio.encodings_extras ?? []) {
      try {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        todos.push(bufferToEncoding(b));
      } catch {
        /* ignore */
      }
    }
    for (const buf of bio.encodings_aprendidos ?? []) {
      try {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        todos.push(bufferToEncoding(b));
      } catch {
        /* ignore */
      }
    }

    let menorDist = Infinity;
    for (const e of todos) {
      const d = await compareFaces(ext.encoding, e);
      if (d < menorDist) menorDist = d;
    }
    if (menorDist < DIVERSIDADE_MINIMA_TIEBREAK) {
      console.log(
        `[Tiebreak Auto-Aprendizado] Pulando — encoding muito similar (dist=${menorDist.toFixed(4)} < ${DIVERSIDADE_MINIMA_TIEBREAK}).`,
      );
      return;
    }

    await query(
      `UPDATE people.biometria_facial
          SET encodings_aprendidos = array_append(encodings_aprendidos, $1),
              qualidades_aprendidos = array_append(qualidades_aprendidos, $2),
              total_aprendidos = total_aprendidos + 1,
              atualizado_em = NOW()
        WHERE id = $3`,
      [encodingToBuffer(ext.encoding), ext.qualidade, bio.id],
    );
    // Invalida cache de encodings pra que a próxima identificação use o
    // novo aprendido. Tiebreak é raro o suficiente pra não sobrecarregar
    // o banco com reload imediato.
    await cacheDel(CACHE_KEYS.BIOMETRIA_ENCODINGS);
    console.log(
      `[Tiebreak Auto-Aprendizado] ✓ Encoding aprendido pro colab ${colaboradorId} (qualidade=${ext.qualidade.toFixed(3)}, ` +
        `divergência mínima=${menorDist.toFixed(4)}, total agora=${(bio.total_aprendidos ?? 0) + 1})`,
    );
  } catch (e) {
    console.error('[Tiebreak Auto-Aprendizado] Erro (não crítico):', e);
  }
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const clientIp = getClientIp(request);

  try {
    const rateLimit = await checkRateLimit(`biometria:tiebreak-confirm:${clientIp}`, 6, 60);
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
    const { sessionId, dispositivoCodigo, tipoPonto, latitude, longitude, origem } =
      validation.data;

    const session = await cacheGet<TiebreakSession>(`${SESSION_PREFIX}${sessionId}`);
    if (!session) {
      return jsonResponse(
        {
          success: false,
          error: 'Sessão de confirmação expirou. Por favor, tente novamente.',
          code: 'TIEBREAK_SESSION_EXPIRED',
        },
        410,
      );
    }
    const { colaboradorId } = session;
    if (!colaboradorId) {
      return jsonResponse(
        { success: false, error: 'Sessão inválida', code: 'TIEBREAK_INVALID' },
        400,
      );
    }

    // Confirmar que o colaborador continua ativo
    const colabResult = await query<{
      id: number;
      nome: string;
      empresa_id: number | null;
      permite_ponto_mobile: boolean | null;
      cargo_nome: string | null;
    }>(
      `SELECT c.id, c.nome, c.empresa_id, c.permite_ponto_mobile, cg.nome AS cargo_nome
         FROM people.colaboradores c
         LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
        WHERE c.id = $1 AND c.status = 'ativo'`,
      [colaboradorId],
    );
    if (colabResult.rows.length === 0) {
      return jsonResponse(
        {
          success: false,
          error: 'Colaborador não encontrado ou inativo.',
          code: 'COLLABORATOR_NOT_FOUND',
        },
        404,
      );
    }
    const colab = colabResult.rows[0];

    // Validar dispositivo se enviado
    let dispositivo: Dispositivo | null = null;
    if (dispositivoCodigo) {
      const v = await validarDispositivo(dispositivoCodigo);
      if (!v.valido && v.code !== 'DEVICE_NOT_FOUND') {
        return jsonResponse(
          { success: false, error: v.erro, code: v.code },
          403,
        );
      }
      if (v.valido && v.dispositivo) dispositivo = v.dispositivo;
    }

    // Permissão de ponto pelo celular (totem sempre permitido)
    if (origem !== 'totem' && colab.permite_ponto_mobile === false) {
      return jsonResponse(
        {
          success: false,
          error: 'Este colaborador não tem permissão para marcar ponto pelo celular',
          code: 'MOBILE_PUNCH_NOT_ALLOWED',
        },
        403,
      );
    }

    // Tipo de ponto
    const tipoFinal = tipoPonto ?? (await detectarTipoPonto(colab.id));
    const tipoDetectado = !tipoPonto;

    // Upload foto
    let fotoUrl: string | null = null;
    try {
      const base64 = session.imagem.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64, 'base64');
      const isPng = session.imagem.startsWith('data:image/png');
      const ext = isPng ? 'png' : 'jpg';
      const ct = isPng ? 'image/png' : 'image/jpeg';
      const dataStr = new Date().toISOString().split('T')[0];
      const path = `marcacoes/${colab.id}/${dataStr}/${Date.now()}_${tipoFinal}_tiebreak.${ext}`;
      fotoUrl = await uploadArquivo(path, buffer, ct);
    } catch (uploadErr) {
      console.warn('[tiebreak-confirmar] Falha no upload (não bloqueante):', uploadErr);
    }

    const marcacao = await inserirMarcacao({
      colaboradorId: colab.id,
      tipo: tipoFinal,
      dispositivo,
      empresaId: colab.empresa_id,
      latitude,
      longitude,
      fotoUrl,
      clientIp,
    });

    // Auditoria final
    await registrarAuditoria({
      usuarioId: null,
      acao: 'criar',
      modulo: 'registro_ponto',
      descricao: `Tiebreak facial confirmado: ${colab.nome} registrou ponto (${tipoFinal}) via fluxo de fallback (LLM=${session.llm.model}, conf=${session.llm.confidence}).`,
      ip: clientIp,
      userAgent: getUserAgent(request),
      colaboradorId: colab.id,
      colaboradorNome: colab.nome,
      entidadeId: marcacao.marcacaoId,
      entidadeTipo: 'marcacao',
      dadosNovos: {
        marcacaoId: marcacao.marcacaoId,
        tipo: marcacao.tipo,
        metodo: 'biometria',
        sessionId,
        llmModel: session.llm.model,
        llmReason: session.llm.reason,
        llmConfidence: session.llm.confidence,
        confirmadoPeloUsuario: true,
      },
    });

    // Auto-aprende em background — invalida cache de encodings ao final
    autoAprenderEncoding(colab.id, session.imagem).catch((e) =>
      console.error('[tiebreak-confirmar] auto-aprender falhou:', e),
    );

    // Consome a sessão (1 uso só)
    await cacheDel(`${SESSION_PREFIX}${sessionId}`);

    return jsonResponse({
      success: true,
      data: {
        pontoRegistrado: {
          marcacaoId: marcacao.marcacaoId,
          tipo: marcacao.tipo,
          sequencia: marcacao.sequencia,
          tipoDetectadoAutomaticamente: tipoDetectado,
          dataHora: new Date().toISOString(),
          ...(dispositivo
            ? { dispositivoId: dispositivo.id, dispositivoNome: dispositivo.nome }
            : { dispositivoNaoAutorizado: true }),
        },
        colaborador: {
          id: colab.id,
          nome: colab.nome,
          cargo: colab.cargo_nome,
        },
        processedIn: Date.now() - startTime,
      },
    });
  } catch (e) {
    console.error('[tiebreak-confirmar] erro:', e);
    return jsonResponse(
      { success: false, error: 'Erro interno', code: 'INTERNAL_ERROR' },
      500,
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
