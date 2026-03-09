import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { criarLocalizacaoSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { invalidateLocalizacaoCache } from '@/lib/cache';
import { embedTableRowAfterInsert } from '@/lib/embeddings';

export async function POST(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(criarLocalizacaoSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      const result = await query(
        `INSERT INTO bt_localizacoes (
          nome, tipo, 
          endereco_cep, endereco_logradouro, endereco_numero, 
          endereco_complemento, endereco_bairro, endereco_cidade, endereco_estado,
          latitude, longitude, raio_permitido, horarios_funcionamento
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id, nome`,
        [
          data.nome,
          data.tipo,
          data.endereco?.cep || null,
          data.endereco?.logradouro || null,
          data.endereco?.numero || null,
          data.endereco?.complemento || null,
          data.endereco?.bairro || null,
          data.endereco?.cidade || null,
          data.endereco?.estado || null,
          data.coordenadas.latitude,
          data.coordenadas.longitude,
          data.raioPermitido,
          data.horariosFuncionamento ? JSON.stringify(data.horariosFuncionamento) : null,
        ]
      );

      const localizacao = result.rows[0];

      await invalidateLocalizacaoCache();
      await embedTableRowAfterInsert('bt_localizacoes', localizacao.id);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'criar',
        modulo: 'localizacoes',
        descricao: `Localização criada: ${localizacao.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { id: localizacao.id, nome: data.nome },
      });

      return createdResponse({
        id: localizacao.id,
        nome: localizacao.nome,
        mensagem: 'Localização criada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao criar localização:', error);
      return serverErrorResponse('Erro ao criar localização');
    }
  });
}
