import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { notFoundResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);
      const { searchParams } = new URL(request.url);
      
      // Opções:
      // ?modo=url (padrão) - retorna JSON com URL
      // ?modo=redirect - redireciona para a imagem
      // ?modo=proxy - retorna a imagem diretamente (proxy)
      const modo = searchParams.get('modo') || 'url';

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const result = await query(
        `SELECT id, nome, foto_url FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (result.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colaborador = result.rows[0];
      const fotoUrl = colaborador.foto_url;

      if (!fotoUrl) {
        return notFoundResponse('Colaborador não possui foto cadastrada');
      }

      // Modo: Retornar JSON com URL
      if (modo === 'url') {
        return successResponse({
          id: colaboradorId,
          nome: colaborador.nome,
          fotoUrl,
        });
      }

      // Modo: Redirecionar para a imagem
      if (modo === 'redirect') {
        return NextResponse.redirect(fotoUrl);
      }

      // Modo: Proxy - buscar imagem e retornar
      if (modo === 'proxy') {
        try {
          const imageResponse = await fetch(fotoUrl);
          
          if (!imageResponse.ok) {
            return notFoundResponse('Erro ao buscar imagem');
          }

          const imageBuffer = await imageResponse.arrayBuffer();
          const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

          return new NextResponse(imageBuffer, {
            status: 200,
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=3600', // Cache 1 hora
            },
          });
        } catch (fetchError) {
          console.error('Erro ao fazer proxy da imagem:', fetchError);
          return serverErrorResponse('Erro ao buscar imagem');
        }
      }

      // Modo inválido
      return NextResponse.json({
        success: false,
        error: 'Modo inválido. Use: url, redirect ou proxy',
        code: 'INVALID_MODE',
      }, { status: 400 });

    } catch (error) {
      console.error('Erro ao obter foto:', error);
      return serverErrorResponse('Erro ao obter foto');
    }
  });
}
