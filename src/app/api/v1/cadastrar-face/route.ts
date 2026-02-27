import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { cadastrarFaceSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(cadastrarFaceSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id, nome FROM bluepoint.bt_colaboradores WHERE id = $1`,
        [data.colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      // Simular processamento de biometria (em produção usaria um serviço real)
      const qualidade = data.qualidade === 'alta' ? 0.95 : data.qualidade === 'media' ? 0.80 : 0.65;

      // Salvar biometria (ou atualizar se já existe)
      await query(
        `INSERT INTO bt_biometria_facial (colaborador_id, qualidade, foto_referencia_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (colaborador_id) 
         DO UPDATE SET qualidade = $2, foto_referencia_url = $3, atualizado_em = NOW()`,
        [data.colaboradorId, qualidade, data.fotos[0]] // Usar primeira foto como referência
      );

      // Atualizar flag no colaborador
      await query(
        `UPDATE bluepoint.bt_colaboradores SET face_registrada = true, atualizado_em = NOW() WHERE id = $1`,
        [data.colaboradorId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'CREATE',
        modulo: 'colaboradores',
        descricao: `Biometria facial cadastrada: ${colaboradorResult.rows[0].nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
      });

      return createdResponse({
        colaboradorId: data.colaboradorId,
        faceRegistrada: true,
        qualidadeBiometria: qualidade,
        mensagem: 'Biometria facial cadastrada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao cadastrar face:', error);
      return serverErrorResponse('Erro ao cadastrar biometria');
    }
  });
}
