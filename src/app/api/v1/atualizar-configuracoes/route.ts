import { NextRequest } from 'next/server';
import { getClient } from '@/lib/db';
import { successResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAdmin } from '@/lib/middleware';
import { atualizarConfiguracoesSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cacheDelPattern, CACHE_KEYS } from '@/lib/cache';

export async function PUT(request: NextRequest) {
  return withAdmin(request, async (req, user) => {
    const client = await getClient();
    
    try {
      const body = await req.json();
      
      const validation = validateBody(atualizarConfiguracoesSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const { categoria, configuracoes } = validation.data;

      await client.query('BEGIN');

      const configuracoesAtualizadas: string[] = [];

      for (const [chave, valor] of Object.entries(configuracoes)) {
        await client.query(
          `INSERT INTO configuracoes (categoria, chave, valor)
           VALUES ($1, $2, $3)
           ON CONFLICT (categoria, chave) 
           DO UPDATE SET valor = $3, atualizado_em = NOW()`,
          [categoria, chave, valor]
        );
        configuracoesAtualizadas.push(chave);
      }

      await client.query('COMMIT');

      // Invalidar cache de configurações
      await cacheDelPattern(`${CACHE_KEYS.CONFIGURACOES}*`);

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'configuracoes',
        descricao: `Configurações atualizadas: ${categoria}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { categoria, configuracoes },
      });

      return successResponse({
        mensagem: 'Configurações atualizadas com sucesso',
        configuracoesAtualizadas,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao atualizar configurações:', error);
      return serverErrorResponse('Erro ao atualizar configurações');
    } finally {
      client.release();
    }
  });
}
