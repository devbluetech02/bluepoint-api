import { NextRequest, NextResponse } from 'next/server';
import { successResponse, serverErrorResponse } from '@/lib/api-response';

// POST /api/v1/admin/winthor-query
// body: { sql: string }
//
// Endpoint TEMPORÁRIO de debug — executa SELECT arbitrário no Winthor pelo
// pool oracledb. Auth via CRON_SECRET. APAGAR depois.

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  try {
    const body = (await request.json()) as { sql?: string };
    const sql = (body.sql ?? '').trim();
    if (!sql || !/^select\s/i.test(sql)) {
      return successResponse({ error: 'só SELECT permitido' });
    }
    const oracledb = await import('oracledb');
    try { (oracledb.default ?? oracledb).initOracleClient({ libDir: process.env.ORACLE_INSTANT_CLIENT_DIR }); }
    catch (e) { if (!`${(e as Error).message}`.includes('NJS-077')) throw e; }
    const conn = await (oracledb.default ?? oracledb).getConnection({
      user: process.env.WINTHOR_USER!, password: process.env.WINTHOR_PASSWORD!, connectString: process.env.WINTHOR_DSN!,
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await (conn as any).execute(sql, {}, { outFormat: (oracledb.default ?? oracledb).OUT_FORMAT_OBJECT });
      return successResponse({ rows: r.rows, count: r.rows?.length ?? 0 });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (conn as any).close();
    }
  } catch (e) {
    console.error('[winthor-query]', e);
    return serverErrorResponse((e as Error).message);
  }
}
