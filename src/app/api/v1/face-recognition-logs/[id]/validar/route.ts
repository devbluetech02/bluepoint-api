import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/db';
import { withPermission } from '@/lib/middleware';
import {
  bufferToEncoding,
  compareFaces,
  encodingToBuffer,
  extractFaceEncoding,
} from '@/lib/face-recognition';
import { cacheDel, CACHE_KEYS } from '@/lib/cache';

/**
 * POST /api/v1/face-recognition-logs/[id]/validar
 *
 * Admin marca um evento de reconhecimento facial como "match correto"
 * (ou incorreto). Quando correto, alimenta o auto-aprendizado: o
 * encoding extraído da foto capturada é salvo como aprendido pro
 * colaborador proposto, melhorando matches futuros.
 *
 * Body: { correto: boolean }
 * Permissão: auditoria:face_logs:ver (default: nível 3 / admin).
 *
 * Limites do auto-aprendizado replicados em sync com
 * face-recognition.ts:
 *  - qualidade da foto >= 0.50
 *  - distância mínima pros encodings já cadastrados >= 0.08
 *    (encoding tem que trazer informação nova)
 *  - total_aprendidos < 20 (cap)
 *
 * Idempotente: re-marcar não duplica encoding aprendido (depende
 * da diversidade — se o mesmo já está cadastrado, é ignorado).
 */

const MAX_ENCODINGS_APRENDIDOS = 20;
const AUTO_APRENDER_MIN_QUALIDADE = 0.50;
const DIVERSIDADE_MINIMA = 0.08;

const schema = z.object({
  correto: z.boolean(),
});

interface LogRow {
  id: number;
  evento: string;
  colaborador_id_proposto: number | null;
  foto_url: string | null;
  match_validado_correto: boolean | null;
}

async function aprenderDoLog(args: {
  logId: number;
  colaboradorId: number;
  fotoUrl: string;
}): Promise<{ aprendido: boolean; motivo: string }> {
  // Baixar foto do storage
  let imageBytes: Buffer;
  try {
    const resp = await fetch(args.fotoUrl);
    if (!resp.ok) {
      return { aprendido: false, motivo: `http_${resp.status}` };
    }
    imageBytes = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    return { aprendido: false, motivo: `download_falhou: ${(e as Error).message}` };
  }

  // Reextrair encoding via face-service
  const dataUri = `data:image/jpeg;base64,${imageBytes.toString('base64')}`;
  const ext = await extractFaceEncoding(dataUri);
  if (!ext.encoding) {
    return { aprendido: false, motivo: ext.error || 'sem_encoding' };
  }
  if (ext.qualidade < AUTO_APRENDER_MIN_QUALIDADE) {
    return {
      aprendido: false,
      motivo: `qualidade ${ext.qualidade.toFixed(3)} < ${AUTO_APRENDER_MIN_QUALIDADE}`,
    };
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
    [args.colaboradorId],
  );
  if (bioResult.rows.length === 0) {
    return { aprendido: false, motivo: 'sem_biometria_cadastrada' };
  }
  const bio = bioResult.rows[0];

  if ((bio.total_aprendidos ?? 0) >= MAX_ENCODINGS_APRENDIDOS) {
    return {
      aprendido: false,
      motivo: `cap_atingido (${bio.total_aprendidos}/${MAX_ENCODINGS_APRENDIDOS})`,
    };
  }

  // Verificar diversidade
  const todos: Float32Array[] = [];
  if (bio.encoding) {
    try {
      todos.push(
        bufferToEncoding(
          Buffer.isBuffer(bio.encoding) ? bio.encoding : Buffer.from(bio.encoding),
        ),
      );
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
  if (menorDist < DIVERSIDADE_MINIMA) {
    return {
      aprendido: false,
      motivo: `dist ${menorDist.toFixed(4)} < ${DIVERSIDADE_MINIMA} (já parecido)`,
    };
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
  await cacheDel(CACHE_KEYS.BIOMETRIA_ENCODINGS);

  console.log(
    `[validar] Log #${args.logId} → encoding aprendido pro colab ${args.colaboradorId}: ` +
      `qualidade=${ext.qualidade.toFixed(3)}, divergência=${menorDist.toFixed(4)}, ` +
      `total agora=${(bio.total_aprendidos ?? 0) + 1}`,
  );
  return { aprendido: true, motivo: 'ok' };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return withPermission(request, 'auditoria:face_logs:ver', async (req, user) => {
    const { id } = await params;
    const logId = parseInt(id, 10);
    if (Number.isNaN(logId)) {
      return NextResponse.json(
        { success: false, error: 'ID inválido', code: 'INVALID_ID' },
        { status: 400 },
      );
    }

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { success: false, error: 'JSON inválido', code: 'INVALID_JSON' },
        { status: 400 },
      );
    }
    const validation = schema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Erro de validação',
          code: 'VALIDATION_ERROR',
          details: validation.error.issues,
        },
        { status: 422 },
      );
    }
    const { correto } = validation.data;

    const r = await query<LogRow>(
      `SELECT id, evento, colaborador_id_proposto, foto_url, match_validado_correto
         FROM people.face_recognition_logs WHERE id = $1`,
      [logId],
    );
    if (r.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Log não encontrado', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }
    const log = r.rows[0];

    await query(
      `UPDATE people.face_recognition_logs
          SET match_validado_correto = $1,
              match_validado_em = NOW(),
              match_validado_por = $2
        WHERE id = $3`,
      [correto, user.userId, logId],
    );

    let aprendizado: { aprendido: boolean; motivo: string } | null = null;

    // Auto-aprendizado roda só quando o admin marca como correto E
    // temos foto + colaborador proposto. Logs sem foto (raros) ou sem
    // colaborador (eventos NOT_IDENTIFIED) não alimentam.
    if (
      correto &&
      log.colaborador_id_proposto !== null &&
      log.foto_url &&
      log.foto_url.trim() !== '' &&
      // Só aprende se ainda não havia sido validado correto antes —
      // evita reprocessar e duplicar tentativa de inserir encoding.
      log.match_validado_correto !== true
    ) {
      try {
        aprendizado = await aprenderDoLog({
          logId,
          colaboradorId: log.colaborador_id_proposto,
          fotoUrl: log.foto_url,
        });
      } catch (e) {
        console.error('[validar] erro no auto-aprendizado (não crítico):', e);
        aprendizado = { aprendido: false, motivo: `excecao: ${(e as Error).message}` };
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        id: logId,
        validadoCorreto: correto,
        aprendizado,
      },
    });
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
