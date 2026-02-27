import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { criarDepartamentoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateDepartamentoCache } from '@/lib/cache';

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(criarDepartamentoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const result = await query(
        `INSERT INTO bt_departamentos (nome, descricao, gestor_id)
         VALUES ($1, $2, $3)
         RETURNING id, nome`,
        [data.nome, data.descricao || null, data.gestorId || null]
      );

      const departamento = result.rows[0];

      // Invalidar cache
      await invalidateDepartamentoCache();

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'CREATE',
        modulo: 'departamentos',
        descricao: `Departamento criado: ${departamento.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: departamento.id, nome: data.nome },
      });

      return createdResponse({
        id: departamento.id,
        nome: departamento.nome,
        mensagem: 'Departamento criado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao criar departamento:', error);
      return serverErrorResponse('Erro ao criar departamento');
    }
  });
}
