import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Gera um request ID único
function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
}

export function middleware(request: NextRequest) {
  const requestId = generateRequestId();
  const startTime = Date.now();

  // Headers CORS completos para multi-plataforma
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Request-ID, X-Client-Version, X-Platform',
    'Access-Control-Expose-Headers': 'X-Request-ID, X-Response-Time, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    'Access-Control-Max-Age': '86400',
  };

  // Handle preflight requests (OPTIONS)
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
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

// Apply middleware to all API routes EXCEPT /api/v1/apps (upload de APKs grandes)
export const config = {
  matcher: [
    // Match all API routes except apps upload
    '/api/v1/((?!apps).*)',
    '/api/v1/apps/:nome/download',  // Download de APK pode passar pelo middleware
  ],
};
