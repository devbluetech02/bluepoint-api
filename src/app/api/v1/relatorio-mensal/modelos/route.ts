import { NextRequest } from 'next/server';
import { successResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

const MODELOS_DISPONIVEIS = [
  {
    id: 'padrao',
    nome: 'Padrão',
    descricao: 'Relatório com previsto, realizado, horas extras, saldo e assinatura',
  },
  {
    id: 'completo',
    nome: 'Completo',
    descricao: 'Relatório detalhado com interjornada, horas diurnas/noturnas, HE separadas, atrasos e resumos completos',
  },
  {
    id: 'faixas_he',
    nome: 'Faixas de HE',
    descricao: 'Relatório detalhado com 13 colunas, faixas de horas extras e assinaturas',
  },
  {
    id: 'personalizado',
    nome: 'Personalizado',
    descricao: 'Relatório com colunas personalizáveis pelo usuário',
  },
];

export async function GET(request: NextRequest) {
  return withAuth(request, async () => {
    return successResponse({ modelos: MODELOS_DISPONIVEIS });
  });
}
