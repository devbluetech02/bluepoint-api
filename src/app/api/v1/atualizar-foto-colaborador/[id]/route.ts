import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { salvarFotoColaborador } from '@/lib/storage';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

// OPTIONS - Preflight CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders,
  });
}

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  console.log('[FOTO] Iniciando PUT');
  console.log('[FOTO] Content-Type:', request.headers.get('content-type'));
  
  return withAuth(request, async (req, user) => {
    console.log('[FOTO] Autenticado:', user.nome);
    try {
      const { id } = await params;
      console.log('[FOTO] ID:', id);
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      // Verificar se colaborador existe
      const result = await query(
        `SELECT id, nome, foto_url FROM bluepoint.bt_colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colaborador = result.rows[0];

      const formData = await req.formData();
      const foto = formData.get('foto') as File | null;

      if (!foto) {
        return errorResponse('Foto não fornecida', 400);
      }

      // Validar tipo de arquivo
      const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedTypes.includes(foto.type)) {
        return errorResponse('Tipo de arquivo não permitido. Use JPEG, PNG ou WebP.', 400);
      }

      // Validar tamanho (máximo 5MB)
      const maxSize = 5 * 1024 * 1024; // 5MB
      if (foto.size > maxSize) {
        return errorResponse('Arquivo muito grande. Tamanho máximo: 5MB.', 400);
      }

      // Obter extensão do arquivo
      const extensao = foto.name.split('.').pop()?.toLowerCase() || 'jpg';

      // Converter para buffer
      console.log('[FOTO] Convertendo para buffer...');
      const buffer = Buffer.from(await foto.arrayBuffer());
      console.log('[FOTO] Buffer size:', buffer.length);

      // Salvar foto no MinIO (deleta a anterior automaticamente)
      console.log('[FOTO] Salvando no MinIO...');
      const { url: fotoUrl, caminho } = await salvarFotoColaborador(
        colaboradorId,
        colaborador.nome,
        buffer,
        foto.type,
        extensao
      );

      // Atualizar colaborador no banco
      await query(
        `UPDATE bluepoint.bt_colaboradores SET foto_url = $1, atualizado_em = NOW() WHERE id = $2`,
        [fotoUrl, colaboradorId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'UPDATE',
        modulo: 'colaboradores',
        descricao: `Foto atualizada: ${colaborador.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosNovos: { fotoUrl, caminho },
      });

      return successResponse({
        id: colaboradorId,
        nome: colaborador.nome,
        fotoUrl,
        caminho,
        mensagem: 'Foto atualizada com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar foto:', error);
      return serverErrorResponse('Erro ao atualizar foto');
    }
  });
}

// DELETE - Remover foto do colaborador
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      // Verificar se colaborador existe
      const result = await query(
        `SELECT id, nome, foto_url FROM bluepoint.bt_colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colaborador = result.rows[0];

      if (!colaborador.foto_url) {
        return errorResponse('Colaborador não possui foto', 400);
      }

      // Importar função de deletar
      const { deletarFotoColaborador } = await import('@/lib/storage');

      // Deletar foto do MinIO
      await deletarFotoColaborador(colaboradorId, colaborador.nome);

      // Atualizar colaborador no banco
      await query(
        `UPDATE bluepoint.bt_colaboradores SET foto_url = NULL, atualizado_em = NOW() WHERE id = $1`,
        [colaboradorId]
      );

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'DELETE',
        modulo: 'colaboradores',
        descricao: `Foto removida: ${colaborador.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { fotoUrl: colaborador.foto_url },
      });

      return successResponse({
        id: colaboradorId,
        nome: colaborador.nome,
        mensagem: 'Foto removida com sucesso',
      });
    } catch (error) {
      console.error('Erro ao remover foto:', error);
      return serverErrorResponse('Erro ao remover foto');
    }
  });
}
