import { query } from '@/lib/db';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

export interface DocumentoColaboradorPayload {
  id: number;
  tipo: string;
  tipoDocumentoId: number | null;
  tipoNomeExibicao: string;
  categorias: ('operacional' | 'admissao')[];
  nome: string;
  url: string;
  tamanho: number | null;
  dataUpload: string;
  dataValidade: string | null;
  vencido: boolean;
  diasParaVencer: number | null;
}

export interface TipoObrigatorioCargoPayload {
  tipoDocumentoId: number;
  codigo: string;
  obrigatorio: boolean;
}

export interface DocumentosColaboradorResposta {
  documentos: DocumentoColaboradorPayload[];
  tiposObrigatoriosCargo: TipoObrigatorioCargoPayload[];
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
  tipo_categorias: ('operacional' | 'admissao')[] | null;
};

type TipoCargoRow = { id: number; codigo: string; obrigatorio: boolean };
type TipoPadraoRow = { id: number; codigo: string; obrigatorio_padrao: boolean };

/**
 * Carrega documentos + tipos obrigatórios do cargo de um colaborador.
 * Retorna null se o colaborador não existir. Cacheado por colaborador
 * (TTL MEDIUM) — mesma chave usada pelo endpoint single, então o batch
 * reaproveita hits feitos pelas chamadas individuais.
 */
export async function getDocumentosColaboradorCacheado(
  colaboradorId: number
): Promise<DocumentosColaboradorResposta | null> {
  if (!Number.isInteger(colaboradorId) || colaboradorId <= 0) return null;

  const colaboradorResult = await query(
    `SELECT id FROM people.colaboradores WHERE id = $1`,
    [colaboradorId]
  );
  if (colaboradorResult.rows.length === 0) return null;

  const cacheKey = `${CACHE_KEYS.DOCUMENTOS}colaborador:${colaboradorId}`;

  return cacheAside(cacheKey, async () => {
    const result = await query(
      `SELECT d.id, d.tipo, d.tipo_documento_id, d.nome, d.url, d.storage_key, d.tamanho, d.data_upload, d.data_validade,
              t.codigo AS tipo_codigo, t.nome_exibicao AS tipo_nome_exibicao, t.validade_meses, t.categorias AS tipo_categorias
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

    const documentos: DocumentoColaboradorPayload[] = (result.rows as DocRow[]).map((doc) => {
      const vencido = doc.data_validade != null && doc.data_validade < hoje;
      return {
        id: doc.id,
        tipo: doc.tipo,
        tipoDocumentoId: doc.tipo_documento_id,
        tipoNomeExibicao: doc.tipo_nome_exibicao ?? doc.tipo,
        categorias: doc.tipo_categorias ?? ['operacional'],
        nome: doc.nome,
        url: doc.url,
        tamanho: doc.tamanho,
        dataUpload: doc.data_upload,
        dataValidade: doc.data_validade,
        vencido,
        diasParaVencer: diasParaVencer(doc.data_validade),
      };
    });

    const colabRow = await query(
      `SELECT c.cargo_id FROM people.colaboradores c WHERE c.id = $1`,
      [colaboradorId]
    );
    const cargoId = colabRow.rows[0]?.cargo_id ?? null;

    let tiposObrigatoriosCargo: TipoObrigatorioCargoPayload[] = [];
    if (cargoId) {
      const tiposCargoResult = await query(
        `SELECT t.id, t.codigo, COALESCE(ct.obrigatorio, t.obrigatorio_padrao) AS obrigatorio
         FROM people.tipos_documento_colaborador t
         LEFT JOIN people.cargo_tipo_documento ct ON ct.tipo_documento_id = t.id AND ct.cargo_id = $1
         WHERE 'operacional' = ANY(t.categorias)
         ORDER BY t.id`,
        [cargoId]
      );
      tiposObrigatoriosCargo = (tiposCargoResult.rows as TipoCargoRow[]).map((r) => ({
        tipoDocumentoId: r.id,
        codigo: r.codigo,
        obrigatorio: r.obrigatorio,
      }));
    } else {
      const todosTiposResult = await query(
        `SELECT id, codigo, obrigatorio_padrao
         FROM people.tipos_documento_colaborador
         WHERE 'operacional' = ANY(categorias)
         ORDER BY id`
      );
      tiposObrigatoriosCargo = (todosTiposResult.rows as TipoPadraoRow[]).map((r) => ({
        tipoDocumentoId: r.id,
        codigo: r.codigo,
        obrigatorio: r.obrigatorio_padrao,
      }));
    }

    return { documentos, tiposObrigatoriosCargo };
  }, CACHE_TTL.MEDIUM);
}
