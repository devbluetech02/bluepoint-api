import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import {
  paginatedSuccessResponse,
  serverErrorResponse,
  getPaginationParams,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';

// GET /api/v1/recrutamento/candidatos
//
// Lista paginada de candidatos do banco externo de Recrutamento (DigitalOcean,
// public.candidatos). Sempre retorna a candidatura MAIS RECENTE por CPF
// (FLUXO_RECRUTAMENTO.md §2.2). Para cada item, anexa `processo_status`
// consultando people.processo_seletivo (banco do People) — assim o front
// pode mostrar badge "em processo" sem perder a fonte de verdade do status.
//
// Query params:
//   - pagina, limite (paginação padrão da API)
//   - busca: nome, CPF (digits) ou telefone (digits, sufixo)
//   - vaga: filtro por contains em vaga (ILIKE)
//   - apenas_disponiveis: se 'true', oculta candidatos com processo vivo
export async function GET(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);
      const busca = (searchParams.get('busca') ?? '').trim();
      const vaga = (searchParams.get('vaga') ?? '').trim();
      const apenasDisponiveis = searchParams.get('apenas_disponiveis') === 'true';

      // Filtros aplicados em cima da CTE com row_number
      const filtros: string[] = ['rn = 1'];
      const params: unknown[] = [];

      if (busca) {
        const buscaDigits = busca.replace(/\D/g, '');
        // Match por nome (ILIKE) OU CPF (=) OU telefone (sufixo dos últimos 9 dígitos)
        const buscaIdx = params.length + 1;
        params.push(`%${busca}%`);
        if (buscaDigits) {
          const digitsIdx = params.length + 1;
          params.push(buscaDigits);
          const sufixoIdx = params.length + 1;
          params.push(buscaDigits.slice(-9));
          filtros.push(
            `(nome ILIKE $${buscaIdx} OR cpf_norm = $${digitsIdx} OR tel_norm LIKE '%' || $${sufixoIdx})`
          );
        } else {
          filtros.push(`nome ILIKE $${buscaIdx}`);
        }
      }

      if (vaga) {
        const idx = params.length + 1;
        params.push(`%${vaga}%`);
        filtros.push(`vaga ILIKE $${idx}`);
      }

      const where = filtros.join(' AND ');

      const baseCTE = `
        WITH base AS (
          SELECT
            id, nome, cpf, telefone, email, vaga, vaga_interesse,
            cidade, uf, data_candidatura, cloudinary_url, cnh_categoria,
            regexp_replace(cpf, '\\D', '', 'g')      AS cpf_norm,
            regexp_replace(telefone, '\\D', '', 'g') AS tel_norm,
            ROW_NUMBER() OVER (
              PARTITION BY regexp_replace(cpf, '\\D', '', 'g')
              ORDER BY data_candidatura DESC NULLS LAST, id DESC
            ) AS rn
          FROM public.candidatos
          WHERE cpf IS NOT NULL AND TRIM(cpf) <> ''
        )
      `;

      // count total (CPFs distintos após filtros)
      const countResult = await queryRecrutamento<{ total: string }>(
        `${baseCTE} SELECT COUNT(*)::text AS total FROM base WHERE ${where}`,
        params
      );
      const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

      // página
      const limitIdx = params.length + 1;
      const offsetIdx = params.length + 2;
      const dataResult = await queryRecrutamento<{
        id: number;
        nome: string;
        cpf: string;
        cpf_norm: string;
        telefone: string | null;
        email: string | null;
        vaga: string | null;
        vaga_interesse: string | null;
        cidade: string | null;
        uf: string | null;
        data_candidatura: Date | null;
        cloudinary_url: string | null;
        cnh_categoria: string | null;
      }>(
        `${baseCTE}
         SELECT id, nome, cpf, cpf_norm, telefone, email, vaga, vaga_interesse,
                cidade, uf, data_candidatura, cloudinary_url, cnh_categoria
           FROM base
          WHERE ${where}
          ORDER BY data_candidatura DESC NULLS LAST
          LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        [...params, limite, offset]
      );

      const candidatos = dataResult.rows;
      const cpfs = candidatos.map((c) => c.cpf_norm);

      // Lookup em People: quem já tem processo aberto/admissão/admitido
      const processosMap = new Map<
        string,
        { id: string; status: string; caminho: string }
      >();
      if (cpfs.length > 0) {
        const procResult = await query<{
          id: string;
          candidato_cpf_norm: string;
          status: string;
          caminho: string;
        }>(
          `SELECT id::text, candidato_cpf_norm, status, caminho
             FROM people.processo_seletivo
            WHERE candidato_cpf_norm = ANY($1::varchar[])
              AND status <> 'cancelado'`,
          [cpfs]
        );
        for (const r of procResult.rows) {
          processosMap.set(r.candidato_cpf_norm, {
            id: r.id,
            status: r.status,
            caminho: r.caminho,
          });
        }
      }

      let payload = candidatos.map((c) => {
        const proc = processosMap.get(c.cpf_norm) ?? null;
        return {
          id: c.id,
          nome: c.nome,
          cpf: c.cpf_norm,
          telefone: (c.telefone ?? '').replace(/\D/g, ''),
          email: c.email,
          vaga: c.vaga,
          vagaInteresse: c.vaga_interesse,
          cidade: c.cidade,
          uf: c.uf,
          dataCandidatura: c.data_candidatura,
          curriculoUrl: c.cloudinary_url,
          cnhCategoria: c.cnh_categoria,
          processoSeletivo: proc,
        };
      });

      if (apenasDisponiveis) {
        payload = payload.filter((c) => c.processoSeletivo === null);
      }

      return paginatedSuccessResponse(payload, total, pagina, limite);
    } catch (error) {
      console.error('[recrutamento/candidatos] erro:', error);
      return serverErrorResponse('Erro ao listar candidatos');
    }
  });
}
