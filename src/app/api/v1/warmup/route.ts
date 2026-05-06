import { NextResponse } from 'next/server';
import { checkFaceServiceHealth } from '@/lib/face-recognition';
import { cacheGet, cacheSet, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { query } from '@/lib/db';
import { bufferToEncoding } from '@/lib/face-recognition';

/**
 * GET /api/v1/warmup
 * Verifica saúde do face-service Python e pré-carrega cache de encodings
 * Chamar após deploy para evitar cold start na primeira requisição real
 */
export async function GET() {
  const startTime = Date.now();
  const results: Record<string, { status: string; time: number }> = {};

  try {
    // 1. Verificar se o face-service Python está online
    const faceServiceStart = Date.now();
    
    try {
      const isHealthy = await checkFaceServiceHealth();
      results.faceService = { 
        status: isHealthy ? 'healthy' : 'unavailable', 
        time: Date.now() - faceServiceStart 
      };
    } catch {
      results.faceService = { status: 'unavailable', time: Date.now() - faceServiceStart };
    }

    // 2. Pré-carregar cache de encodings
    const cacheStart = Date.now();
    let encodings = await cacheGet(CACHE_KEYS.BIOMETRIA_ENCODINGS);
    
    if (!encodings) {
      // Mesma trava de inativos: ver /verificar-face/route.ts.
      const encodingsResult = await query(
        `SELECT bf.colaborador_id, bf.external_id, bf.encoding
         FROM people.biometria_facial bf
         LEFT JOIN people.colaboradores c ON bf.colaborador_id = c.id
         WHERE bf.encoding IS NOT NULL
           AND (
             bf.colaborador_id IS NULL
             OR c.status = 'ativo'
           )`
      );

      if (encodingsResult.rows.length > 0) {
        encodings = encodingsResult.rows.map(row => ({
          colaboradorId: row.colaborador_id as number | null,
          externalIds: row.external_id as Record<string, string> || {},
          encoding: Array.from(bufferToEncoding(row.encoding)),
        }));

        await cacheSet(CACHE_KEYS.BIOMETRIA_ENCODINGS, encodings, CACHE_TTL.LONG);
        results.encodings = { status: `cached ${encodingsResult.rows.length} encodings`, time: Date.now() - cacheStart };
      } else {
        results.encodings = { status: 'no encodings found', time: Date.now() - cacheStart };
      }
    } else {
      results.encodings = { status: `already cached (${(encodings as unknown[]).length} encodings)`, time: Date.now() - cacheStart };
    }

    return NextResponse.json({
      success: true,
      message: 'Warmup concluído',
      engine: 'InsightFace/ArcFace (Python microservice)',
      totalTime: Date.now() - startTime,
      results,
    });
  } catch (error) {
    console.error('Erro no warmup:', error);
    return NextResponse.json({
      success: false,
      error: 'Erro no warmup',
      totalTime: Date.now() - startTime,
      results,
    }, { status: 500 });
  }
}
