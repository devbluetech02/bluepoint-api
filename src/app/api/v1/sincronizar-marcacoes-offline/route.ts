import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { sincronizarMarcacoesSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

export async function POST(request: NextRequest) {
  return withAuth(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(sincronizarMarcacoesSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { marcacoes } = validation.data;
      
      let sincronizadas = 0;
      const falhas: Array<{ indice: number; motivo: string }> = [];

      await client.query('BEGIN');

      for (let i = 0; i < marcacoes.length; i++) {
        const m = marcacoes[i];
        
        try {
          // Verificar se colaborador existe
          const colaboradorResult = await client.query(
            `SELECT id FROM bluepoint.bt_colaboradores WHERE id = $1 AND status = 'ativo'`,
            [m.colaboradorId]
          );

          if (colaboradorResult.rows.length === 0) {
            falhas.push({ indice: i, motivo: 'Colaborador não encontrado ou inativo' });
            continue;
          }

          // Verificar se já existe marcação com mesmo timestamp
          const existeResult = await client.query(
            `SELECT id FROM bluepoint.bt_marcacoes 
             WHERE colaborador_id = $1 AND data_hora = $2`,
            [m.colaboradorId, m.dataHora]
          );

          if (existeResult.rows.length > 0) {
            falhas.push({ indice: i, motivo: 'Marcação já existe' });
            continue;
          }

          // Inserir marcação
          await client.query(
            `INSERT INTO bluepoint.bt_marcacoes (
              colaborador_id, data_hora, tipo, latitude, longitude, metodo
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              m.colaboradorId,
              m.dataHora,
              m.tipo,
              m.localizacao?.latitude || null,
              m.localizacao?.longitude || null,
              m.metodo,
            ]
          );

          sincronizadas++;
        } catch (error) {
          console.error(`Erro ao sincronizar marcação ${i}:`, error);
          falhas.push({ indice: i, motivo: 'Erro ao processar marcação' });
        }
      }

      await client.query('COMMIT');

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'CREATE',
        modulo: 'marcacoes',
        descricao: `Sincronização offline: ${sincronizadas} marcações sincronizadas`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        metadados: {
          totalEnviadas: marcacoes.length,
          sincronizadas,
          falhas: falhas.length,
        },
      });

      return successResponse({
        sincronizadas,
        falhas,
        mensagem: `${sincronizadas} marcações sincronizadas com sucesso`,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao sincronizar marcações:', error);
      return serverErrorResponse('Erro ao sincronizar marcações');
    } finally {
      client.release();
    }
  });
}
