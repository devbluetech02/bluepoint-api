import { NextResponse } from 'next/server';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  errors?: Record<string, string[]>;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  paginacao: {
    total: number;
    pagina: number;
    limite: number;
    totalPaginas: number;
  };
}

export function successResponse<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status });
}

export function createdResponse<T>(data: T) {
  return NextResponse.json({ success: true, data }, { status: 201 });
}

export function noContentResponse() {
  return new NextResponse(null, { status: 204 });
}

export function errorResponse(message: string, status = 400) {
  return NextResponse.json({ success: false, error: message }, { status });
}

export function validationErrorResponse(errors: Record<string, string[]>) {
  return NextResponse.json(
    { success: false, error: 'Erro de validação', errors },
    { status: 422 }
  );
}

export function unauthorizedResponse(message = 'Não autenticado') {
  return NextResponse.json({ success: false, error: message }, { status: 401 });
}

export function forbiddenResponse(message = 'Acesso negado') {
  return NextResponse.json({ success: false, error: message }, { status: 403 });
}

export function notFoundResponse(message = 'Recurso não encontrado') {
  return NextResponse.json({ success: false, error: message }, { status: 404 });
}

export function serverErrorResponse(message = 'Erro interno do servidor') {
  console.error('Server Error:', message);
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

// Helper para paginação
export function buildPaginatedResponse<T>(
  dados: T[],
  total: number,
  pagina: number,
  limite: number
): PaginatedResponse<T> {
  return {
    success: true,
    data: dados,
    paginacao: {
      total,
      pagina,
      limite,
      totalPaginas: Math.ceil(total / limite),
    },
  };
}

export function paginatedSuccessResponse<T>(
  dados: T[],
  total: number,
  pagina: number,
  limite: number
) {
  return NextResponse.json(buildPaginatedResponse(dados, total, pagina, limite));
}

// Helper para extrair parâmetros de paginação da URL
export function getPaginationParams(searchParams: URLSearchParams) {
  const pagina = Math.max(1, parseInt(searchParams.get('pagina') || '1'));
  const limite = Math.min(100, Math.max(1, parseInt(searchParams.get('limite') || '50')));
  const offset = (pagina - 1) * limite;
  
  return { pagina, limite, offset };
}

// Helper para extrair ordenação
export function getOrderParams(searchParams: URLSearchParams, allowedFields: string[]) {
  const ordenar = searchParams.get('ordenar');
  if (!ordenar) return { orderBy: 'id', orderDir: 'ASC' };
  
  const [field, dir] = ordenar.split(':');
  const orderBy = allowedFields.includes(field) ? field : 'id';
  const orderDir = dir?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  
  return { orderBy, orderDir };
}
