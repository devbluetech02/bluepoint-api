// @deprecated — Substituído por /api/v1/limites-he-empresas e /api/v1/limites-he-departamentos
// Mantido para compatibilidade; o frontend já não utiliza este endpoint.

import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { obterSaldoGestor } from '@/lib/custoHorasExtrasService';

interface Params {
  params: Promise<{ gestorId: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { gestorId: gestorIdStr } = await params;
      const gestorId = parseInt(gestorIdStr);

      if (isNaN(gestorId)) {
        return notFoundResponse('Gestor não encontrado');
      }

      const gestorResult = await query(
        `SELECT id, nome FROM people.colaboradores
         WHERE id = $1 AND status = 'ativo'
           AND tipo IN ('gestor', 'gerente', 'supervisor', 'coordenador', 'admin')`,
        [gestorId]
      );

      if (gestorResult.rows.length === 0) {
        return notFoundResponse('Gestor não encontrado ou inativo');
      }

      const saldo = await obterSaldoGestor(gestorId);

      if (!saldo) {
        return successResponse({
          gestor_id: gestorId,
          gestor_nome: gestorResult.rows[0].nome,
          limite_mensal: null,
          pode_extrapolar: true,
          acumulado_mes: 0,
          saldo_disponivel: null,
          total_aprovacoes_mes: 0,
          tem_limite: false,
        });
      }

      return successResponse({
        ...saldo,
        tem_limite: true,
      });
    } catch (error) {
      console.error('Erro ao obter saldo do gestor:', error);
      return serverErrorResponse('Erro ao obter saldo de horas extras do gestor');
    }
  });
}
