import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withAdmin(request, async (req, user) => {
    try {
      const { id } = await params;
      const dispositivoId = parseInt(id);

      if (isNaN(dispositivoId)) {
        return jsonResponse({
          success: false,
          error: 'ID inválido',
          code: 'INVALID_ID',
        }, 400);
      }

      // Verificar se existe
      const existeResult = await query(
        `SELECT id, nome, codigo FROM people.dispositivos WHERE id = $1`,
        [dispositivoId]
      );

      if (existeResult.rows.length === 0) {
        return jsonResponse({
          success: false,
          error: 'Dispositivo não encontrado',
          code: 'NOT_FOUND',
        }, 404);
      }

      const dispositivo = existeResult.rows[0];

      // Verificar se tem marcações vinculadas
      const marcacoesResult = await query(
        `SELECT COUNT(*) FROM people.marcacoes WHERE dispositivo_id = $1`,
        [dispositivoId]
      );

      const totalMarcacoes = parseInt(marcacoesResult.rows[0].count);

      if (totalMarcacoes > 0) {
        // Apenas inativar ao invés de excluir
        await query(
          `UPDATE people.dispositivos SET status = 'inativo', atualizado_em = NOW() WHERE id = $1`,
          [dispositivoId]
        );

        await registrarAuditoria({
          usuarioId: user.userId,
          acao: 'editar',
          modulo: 'dispositivos',
          descricao: `Dispositivo inativado (possui ${totalMarcacoes} marcações): ${dispositivo.nome}`,
          ip: getClientIp(request),
          userAgent: getUserAgent(request),
          dadosAnteriores: { id: dispositivoId, nome: dispositivo.nome },
        });

        return jsonResponse({
          success: true,
          data: {
            id: dispositivoId,
            mensagem: `Dispositivo inativado (possui ${totalMarcacoes} marcações vinculadas)`,
            inativado: true,
          },
        });
      }

      // Excluir
      await query(
        `DELETE FROM people.dispositivos WHERE id = $1`,
        [dispositivoId]
      );

      // Auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'excluir',
        modulo: 'dispositivos',
        descricao: `Dispositivo excluído: ${dispositivo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: dispositivoId, nome: dispositivo.nome, codigo: dispositivo.codigo },
      });

      return jsonResponse({
        success: true,
        data: {
          id: dispositivoId,
          mensagem: 'Dispositivo excluído com sucesso',
        },
      });

    } catch (error) {
      console.error('Erro ao excluir dispositivo:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao excluir dispositivo',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}
