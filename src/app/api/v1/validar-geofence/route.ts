import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { validarGeofenceSchema, validateBody } from '@/lib/validation';
import { calculateDistance } from '@/lib/utils';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(validarGeofenceSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { latitude, longitude, localizacaoId } = validation.data;

      let localizacoes;

      if (localizacaoId) {
        // Validar localização específica
        const result = await query(
          `SELECT * FROM bt_localizacoes WHERE id = $1 AND status = 'ativo'`,
          [localizacaoId]
        );
        localizacoes = result.rows;
      } else {
        // Validar todas as localizações ativas
        const result = await query(
          `SELECT * FROM bt_localizacoes WHERE status = 'ativo'`
        );
        localizacoes = result.rows;
      }

      let dentroPerimetro = false;
      let localizacaoEncontrada = null;
      let menorDistancia = Infinity;

      for (const loc of localizacoes) {
        const distancia = calculateDistance(
          latitude,
          longitude,
          parseFloat(loc.latitude),
          parseFloat(loc.longitude)
        );

        if (distancia <= loc.raio_permitido) {
          dentroPerimetro = true;
          localizacaoEncontrada = {
            id: loc.id,
            nome: loc.nome,
            tipo: loc.tipo,
          };
          menorDistancia = distancia;
          break;
        }

        if (distancia < menorDistancia) {
          menorDistancia = distancia;
          localizacaoEncontrada = {
            id: loc.id,
            nome: loc.nome,
            tipo: loc.tipo,
          };
        }
      }

      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'CREATE',
        modulo: 'geofence',
        descricao: dentroPerimetro 
          ? `Geofence validado: dentro do perímetro de ${localizacaoEncontrada?.nome}`
          : `Geofence validado: fora do perímetro (${Math.round(menorDistancia)}m de ${localizacaoEncontrada?.nome})`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { latitude, longitude, dentroPerimetro, localizacao: localizacaoEncontrada, distancia: Math.round(menorDistancia) },
      });

      return successResponse({
        dentroPerimetro,
        localizacao: localizacaoEncontrada,
        distancia: Math.round(menorDistancia),
        mensagem: dentroPerimetro 
          ? `Dentro do perímetro de ${localizacaoEncontrada?.nome}` 
          : `Fora do perímetro. Localização mais próxima: ${localizacaoEncontrada?.nome} (${Math.round(menorDistancia)}m)`,
      });
    } catch (error) {
      console.error('Erro ao validar geofence:', error);
      return serverErrorResponse('Erro ao validar localização');
    }
  });
}
