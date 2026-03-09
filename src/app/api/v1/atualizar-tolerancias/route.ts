import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { atualizarToleranciasSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function PUT(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(atualizarToleranciasSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      await client.query('BEGIN');

      const configs = [
        ['tolerancia_entrada', data.toleranciaEntrada.toString()],
        ['tolerancia_saida', data.toleranciaSaida.toString()],
        ['tolerancia_intervalo', data.toleranciaIntervalo.toString()],
        ['considerar_fim_semana', data.considerarFimSemana.toString()],
        ['considerar_feriados', data.considerarFeriados.toString()],
      ];

      for (const [chave, valor] of configs) {
        await client.query(
          `INSERT INTO bt_configuracoes (categoria, chave, valor)
           VALUES ('ponto', $1, $2)
           ON CONFLICT (categoria, chave) 
           DO UPDATE SET valor = $2, atualizado_em = NOW()`,
          [chave, valor]
        );
      }

      await client.query('COMMIT');

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'configuracoes',
        descricao: 'Tolerâncias de ponto atualizadas',
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: data,
      });

      return successResponse({
        mensagem: 'Tolerâncias atualizadas com sucesso',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao atualizar tolerâncias:', error);
      return serverErrorResponse('Erro ao atualizar tolerâncias');
    } finally {
      client.release();
    }
  });
}
