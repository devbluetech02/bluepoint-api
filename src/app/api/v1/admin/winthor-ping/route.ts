import { NextRequest, NextResponse } from 'next/server';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import * as net from 'node:net';

// GET /api/v1/admin/winthor-ping
//
// Diagnóstico Winthor — testa conectividade TCP com host:port do DSN
// e tenta initOracleClient + getConnection com timeout curto.

function parseDsn(dsn: string): { host: string; port: number; service: string } | null {
  // formato esperado: host:port/service
  const m = dsn.match(/^([^:/]+):(\d+)\/(.+)$/);
  if (!m) return null;
  return { host: m[1], port: parseInt(m[2], 10), service: m[3] };
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; ms: number; err?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean, err?: string) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve({ ok, ms: Date.now() - start, err });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, 'timeout'));
    sock.once('error', (e) => finish(false, (e as Error).message));
    sock.connect(port, host);
  });
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization') ?? '';
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  return (async () => {
    try {
      const dsn = process.env.WINTHOR_DSN ?? '';
      const user = process.env.WINTHOR_USER ?? '';
      const passLen = (process.env.WINTHOR_PASSWORD ?? '').length;
      const parsed = parseDsn(dsn);
      const result: Record<string, unknown> = {
        env: { dsn_set: !!dsn, user_set: !!user, password_len: passLen, dsn_parsed: parsed },
      };

      if (parsed) {
        result.tcp = await tcpProbe(parsed.host, parsed.port, 8000);
      }

      if (parsed && (result.tcp as { ok: boolean }).ok) {
        try {
          const oracledb = await import('oracledb');
          const libDir = process.env.ORACLE_INSTANT_CLIENT_DIR;
          try {
            (oracledb.default ?? oracledb).initOracleClient({ libDir });
          } catch (e) {
            const m = (e as Error).message;
            if (!m.includes('NJS-077')) result.thick_init_err = m;
          }
          const start = Date.now();
          const conn = await Promise.race([
            (oracledb.default ?? oracledb).getConnection({ user, password: process.env.WINTHOR_PASSWORD!, connectString: dsn }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('getConnection-timeout-15s')), 15000)),
          ]);
          result.oracle_connect_ms = Date.now() - start;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (conn as any).execute('SELECT CODPROD FROM WINDOW.PCPRODUT FETCH FIRST 1 ROWS ONLY');
          result.oracle_select_ok = true;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (conn as any).close();
        } catch (e) {
          result.oracle_err = (e as Error).message;
        }
      }

      return successResponse(result);
    } catch (e) {
      console.error('[winthor-ping]', e);
      return serverErrorResponse((e as Error).message);
    }
  })();
}
