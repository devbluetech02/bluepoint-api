import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      // Verificar se colaborador existe
      const colaboradorResult = await query(
        `SELECT id FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (colaboradorResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const cacheKey = `${CACHE_KEYS.DOCUMENTOS}colaborador:${colaboradorId}`;

      const dados = await cacheAside(cacheKey, async () => {
        const result = await query(
          `SELECT d.id, d.tipo, d.tipo_documento_id, d.nome, d.url, d.storage_key, d.tamanho, d.data_upload, d.data_validade,
                  t.codigo AS tipo_codigo, t.nome_exibicao AS tipo_nome_exibicao, t.validade_meses, t.categoria AS tipo_categoria
           FROM people.documentos_colaborador d
           LEFT JOIN people.tipos_documento_colaborador t ON t.id = d.tipo_documento_id
           WHERE d.colaborador_id = $1
           ORDER BY d.data_upload DESC`,
          [colaboradorId]
        );

        const hoje = new Date().toISOString().substring(0, 10);
        const hojeDate = new Date(hoje);

        function diasParaVencer(dataValidade: string | null): number | null {
          if (dataValidade == null) return null;
          const d = new Date(dataValidade);
          const diffMs = d.getTime() - hojeDate.getTime();
          return Math.floor(diffMs / (24 * 60 * 60 * 1000));
        }

        type DocRow = {
          id: number;
          tipo: string;
          tipo_documento_id: number | null;
          nome: string;
          url: string;
          storage_key: string | null;
          tamanho: number | null;
          data_upload: string;
          data_validade: string | null;
          tipo_codigo: string | null;
          tipo_nome_exibicao: string | null;
          validade_meses: number | null;
          tipo_categoria: 'operacional' | 'admissao' | null;
        };
        const documentos = (result.rows as DocRow[]).map((doc) => {
          const vencido = doc.data_validade != null && doc.data_validade < hoje;
          return {
            id: doc.id,
            tipo: doc.tipo,
            tipoDocumentoId: doc.tipo_documento_id,
            tipoNomeExibicao: doc.tipo_nome_exibicao ?? doc.tipo,
            categoria: doc.tipo_categoria ?? 'operacional',
            nome: doc.nome,
            url: doc.url,
            tamanho: doc.tamanho,
            dataUpload: doc.data_upload,
            dataValidade: doc.data_validade,
            vencido,
            diasParaVencer: diasParaVencer(doc.data_validade),
          };
        });

        // Tipos obrigatórios para o cargo do colaborador (para o front exibir o que falta)
        const colabRow = await query(
          `SELECT c.cargo_id FROM people.colaboradores c WHERE c.id = $1`,
          [colaboradorId]
        );
        const cargoId = colabRow.rows[0]?.cargo_id ?? null;

        let tiposObrigatoriosCargo: { tipoDocumentoId: number; codigo: string; obrigatorio: boolean }[] = [];
        if (cargoId) {
          const tiposCargoResult = await query(
            `SELECT t.id, t.codigo, COALESCE(ct.obrigatorio, t.obrigatorio_padrao) AS obrigatorio
             FROM people.tipos_documento_colaborador t
             LEFT JOIN people.cargo_tipo_documento ct ON ct.tipo_documento_id = t.id AND ct.cargo_id = $1
             WHERE t.categoria = 'operacional'
             ORDER BY t.id`,
            [cargoId]
          );
          type TipoCargoRow = { id: number; codigo: string; obrigatorio: boolean };
          tiposObrigatoriosCargo = (tiposCargoResult.rows as TipoCargoRow[]).map((r) => ({
            tipoDocumentoId: r.id,
            codigo: r.codigo,
            obrigatorio: r.obrigatorio,
          }));
        } else {
          const todosTiposResult = await query(
            `SELECT id, codigo, obrigatorio_padrao
             FROM people.tipos_documento_colaborador
             WHERE categoria = 'operacional'
             ORDER BY id`
          );
          type TipoPadraoRow = { id: number; codigo: string; obrigatorio_padrao: boolean };
          tiposObrigatoriosCargo = (todosTiposResult.rows as TipoPadraoRow[]).map((r) => ({
            tipoDocumentoId: r.id,
            codigo: r.codigo,
            obrigatorio: r.obrigatorio_padrao,
          }));
        }

        return {
          documentos,
          tiposObrigatoriosCargo,
        };
      }, CACHE_TTL.MEDIUM);

      return successResponse(dados);
    } catch (error) {
      console.error('Erro ao listar documentos:', error);
      return serverErrorResponse('Erro ao listar documentos');
    }
  });
}
