import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withAdmin } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import crypto from 'crypto';

interface Params {
  params: Promise<{ id: string }>;
}

// Gera código único do dispositivo (6 dígitos alfanuméricos)
function gerarCodigoDispositivo(): string {
  const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sem I, O, 0, 1 para evitar confusão
  let codigo = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    codigo += caracteres[bytes[i] % caracteres.length];
  }
  return codigo;
}

function jsonResponse(data: object, status: number = 200) {
  return NextResponse.json(data, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function POST(request: NextRequest, { params }: Params) {
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
      const codigoAntigo = dispositivo.codigo;
      const novoCodigo = gerarCodigoDispositivo();

      // Atualizar código
      await query(
        `UPDATE people.dispositivos SET codigo = $1, atualizado_em = NOW() WHERE id = $2`,
        [novoCodigo, dispositivoId]
      );

      // Auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'dispositivos',
        descricao: `Código do dispositivo regenerado: ${dispositivo.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { codigo: codigoAntigo },
        dadosNovos: { codigo: novoCodigo },
      });

      return jsonResponse({
        success: true,
        data: {
          id: dispositivoId,
          codigo: novoCodigo,
          codigoAntigo,
          mensagem: 'Código regenerado com sucesso. Atualize o dispositivo com o novo código.',
        },
      });

    } catch (error) {
      console.error('Erro ao regenerar código:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao regenerar código',
        code: 'INTERNAL_ERROR',
      }, 500);
    }
  });
}
