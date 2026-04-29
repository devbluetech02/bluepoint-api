import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Gera um request ID único
function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
}

// Lista de origens permitidas para CORS (além de * para demais)
const ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://10.1.3.216:8080',
];

export function middleware(request: NextRequest) {
  const requestId = generateRequestId();
  const startTime = Date.now();

  const origin = request.headers.get('origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '*';

  // Headers CORS completos para multi-plataforma (preflight e respostas)
  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Requested-With, X-Request-ID, X-Client-Version, X-Platform',
    'Access-Control-Expose-Headers': 'X-Request-ID, X-Response-Time, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };

  // Handle preflight (OPTIONS) — navegador envia antes de POST com Authorization/multipart
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  // Handle actual requests
  const response = NextResponse.next();

  // Add CORS headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  // Headers de rastreamento e performance
  response.headers.set('X-Request-ID', requestId);
  response.headers.set('X-Response-Time', `${Date.now() - startTime}ms`);

  // Headers de segurança
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');

  // Cache control para APIs
  if (request.nextUrl.pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    response.headers.set('Pragma', 'no-cache');
  }

  return response;
}

// Apply middleware a rotas de API: /api/v1/* (incluindo apps) e /api/prestadores/* (ex.: extrair-dados-nfe)
export const config = {
  matcher: [
    '/api/v1/:path*',
    '/api/public/:path*',
    '/api/prestadores/:path*',
  ],
};
