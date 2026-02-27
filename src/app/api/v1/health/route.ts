import { NextResponse } from 'next/server';
import { healthCheck, getPoolStats } from '@/lib/db';
import { isRedisConnected, getCacheStats } from '@/lib/cache';

export async function GET() {
  const [dbHealthy, redisConnected, cacheStats] = await Promise.all([
    healthCheck(),
    isRedisConnected(),
    getCacheStats(),
  ]);

  const poolStats = getPoolStats();

  const status = dbHealthy ? 'healthy' : 'unhealthy';
  const httpStatus = dbHealthy ? 200 : 503;

  return NextResponse.json({
    status,
    timestamp: new Date().toISOString(),
    services: {
      database: {
        status: dbHealthy ? 'connected' : 'disconnected',
        pool: poolStats,
      },
      redis: {
        status: redisConnected ? 'connected' : 'disconnected',
        ...cacheStats,
      },
    },
  }, { status: httpStatus });
}
