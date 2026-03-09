import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { atualizarLocalizacaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const localizacaoId = parseInt(id);

      if (isNaN(localizacaoId)) {
        return notFoundResponse('Localização não encontrada');
      }

      const body = await req.json();
      
      const validation = validateBody(atualizarLocalizacaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se existe
      const atualResult = await query(
        `SELECT * FROM bt_localizacoes WHERE id = $1`,
        [localizacaoId]
      );

      if (atualResult.rows.length === 0) {
        return notFoundResponse('Localização não encontrada');
      }

      // Atualizar
      await query(
        `UPDATE bt_localizacoes SET
          nome = COALESCE($1, nome),
          tipo = COALESCE($2, tipo),
          endereco_cep = COALESCE($3, endereco_cep),
          endereco_logradouro = COALESCE($4, endereco_logradouro),
          endereco_numero = COALESCE($5, endereco_numero),
          endereco_complemento = COALESCE($6, endereco_complemento),
          endereco_bairro = COALESCE($7, endereco_bairro),
          endereco_cidade = COALESCE($8, endereco_cidade),
          endereco_estado = COALESCE($9, endereco_estado),
          latitude = COALESCE($10, latitude),
          longitude = COALESCE($11, longitude),
          raio_permitido = COALESCE($12, raio_permitido),
          horarios_funcionamento = COALESCE($13, horarios_funcionamento),
          atualizado_em = NOW()
        WHERE id = $14`,
        [
          data.nome,
          data.tipo,
          data.endereco?.cep,
          data.endereco?.logradouro,
          data.endereco?.numero,
          data.endereco?.complemento,
          data.endereco?.bairro,
          data.endereco?.cidade,
          data.endereco?.estado,
          data.coordenadas?.latitude,
          data.coordenadas?.longitude,
          data.raioPermitido,
          data.horariosFuncionamento ? JSON.stringify(data.horariosFuncionamento) : null,
          localizacaoId,
        ]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'localizacoes',
        descricao: `Localização atualizada: ${data.nome || atualResult.rows[0].nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return successResponse({
        id: localizacaoId,
        mensagem: 'Localização atualizada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar localização:', error);
      return serverErrorResponse('Erro ao atualizar localização');
    }
  });
}
