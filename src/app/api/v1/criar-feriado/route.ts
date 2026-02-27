import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { criarFeriadoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateFeriadoCache } from '@/lib/cache';

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(criarFeriadoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const result = await query(
        `INSERT INTO bt_feriados (nome, data, tipo, recorrente, abrangencia, descricao)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, nome`,
        [data.nome, data.data, data.tipo, data.recorrente, data.abrangencia || null, data.descricao || null]
      );

      const feriado = result.rows[0];

      // Invalidar cache
      await invalidateFeriadoCache();

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'CREATE',
        modulo: 'feriados',
        descricao: `Feriado criado: ${feriado.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: feriado.id, nome: data.nome, data: data.data },
      });

      return createdResponse({
        id: feriado.id,
        nome: feriado.nome,
        mensagem: 'Feriado criado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao criar feriado:', error);
      return serverErrorResponse('Erro ao criar feriado');
    }
  });
}
