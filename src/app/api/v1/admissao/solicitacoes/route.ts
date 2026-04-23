import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { serverErrorResponse, successResponse } from '@/lib/api-response';
import { withAdmissao } from '@/lib/middleware';

const STATUS_VALIDOS = [
  'nao_acessado', 'aguardando_rh', 'correcao_solicitada', 'aso_solicitado',
  'aso_recebido', 'em_teste', 'aso_reprovado', 'assinatura_solicitada',
  'contrato_assinado', 'admitido', 'rejeitado',
];

const STATUS_ASO = new Set(['aso_solicitado', 'aso_recebido']);

function buildEndereco(row: Record<string, string | null>): string {
  const partes = [
    row.clinica_logradouro,
    row.clinica_numero ? row.clinica_logradouro ? `, ${row.clinica_numero}` : row.clinica_numero : null,
    row.clinica_bairro ? ` — ${row.clinica_bairro}` : null,
    row.clinica_cidade && row.clinica_estado ? `, ${row.clinica_cidade}/${row.clinica_estado}` : (row.clinica_cidade ?? null),
    row.clinica_cep ? `, ${row.clinica_cep}` : null,
  ];
  return partes.filter(Boolean).join('') || '';
}

function buildAso(row: Record<string, unknown>): Record<string, unknown> | null {
  if (!STATUS_ASO.has(row.status as string) || !row.clinica_id) return null;

  const aso: Record<string, unknown> = {
    clinica: row.clinica_nome as string,
    endereco: buildEndereco(row as Record<string, string | null>),
  };

  if (row.data_exame_aso) {
    aso.dataHora = new Date(row.data_exame_aso as string).toISOString();
  }

  if (row.mensagem_aso) aso.observacoes = row.mensagem_aso;

  return aso;
}

/**
 * GET /api/v1/admissao/solicitacoes
 * Lista solicitações de admissão com paginação e filtro por status.
 * Retorna nome, empresa e cargo do usuário provisório vinculado.
 * Quando status é aso_solicitado/aso_recebido, inclui sub-objeto `aso` com dados do exame.
 * Se o token for de usuário provisório, filtra apenas as suas próprias solicitações.
 */
export async function GET(request: NextRequest) {
  return withAdmissao(request, async (req, user) => {
    try {
      const { searchParams } = request.nextUrl;
      const status = searchParams.get('status');
      const page   = Math.max(1, parseInt(searchParams.get('page')  ?? '1'));
      const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20')));
      const offset = (page - 1) * limit;

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (status) {
        if (!STATUS_VALIDOS.includes(status)) {
          return successResponse({ solicitacoes: [], total: 0, page, limit });
        }
        params.push(status);
        conditions.push(`s.status = $${params.length}`);
      }

      // Usuário provisório só vê as próprias solicitações
      if (user.tipo === 'provisorio') {
        params.push(user.userId);
        conditions.push(`s.usuario_provisorio_id = $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Dedup por provisório: só a solicitação mais recente por usuario_provisorio_id entra no feed.
      // Solicitações sem vínculo (legado) não são agrupadas — caem pelo id próprio.
      // Filtros (status, usuario_provisorio_id para token provisório) aplicam ANTES do ranking,
      // garantindo que cada provisório aparece na sua última solicitação dentro do filtro.
      const latestFilteredCTE = `
        WITH filtradas AS (
          SELECT s.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY COALESCE(s.usuario_provisorio_id::text, s.id::text)
                   ORDER BY s.criado_em DESC
                 ) AS rn
          FROM people.solicitacoes_admissao s
          ${where}
        )
      `;

      const countResult = await query(
        `${latestFilteredCTE}
         SELECT COUNT(*) as total FROM filtradas WHERE rn = 1`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      params.push(limit, offset);
      const dataResult = await query(
        `${latestFilteredCTE}
         SELECT
           s.id,
           s.formulario_id,
           s.status,
           s.dados,
           s.clinica_id,
           s.data_exame_aso,
           s.mensagem_aso,
           s.aso_solicitado_em,
           s.criado_em,
           s.atualizado_em,
           up.id             AS usuario_id,
           up.nome           AS usuario_nome,
           up.cpf            AS usuario_cpf,
           up.dias_teste     AS usuario_dias_teste,
           c.id              AS cargo_id,
           c.nome            AS cargo_nome,
           e.id              AS empresa_id,
           e.nome_fantasia   AS empresa_nome,
           cl.nome           AS clinica_nome,
           cl.logradouro     AS clinica_logradouro,
           cl.numero         AS clinica_numero,
           cl.bairro         AS clinica_bairro,
           cl.cidade         AS clinica_cidade,
           cl.estado         AS clinica_estado,
           cl.cep            AS clinica_cep
         FROM filtradas s
         LEFT JOIN people.usuarios_provisorios up ON up.id = s.usuario_provisorio_id
         LEFT JOIN people.cargos   c ON c.id = up.cargo_id
         LEFT JOIN people.empresas e ON e.id = up.empresa_id
         LEFT JOIN people.clinicas cl ON cl.id = s.clinica_id
         WHERE s.rn = 1
         ORDER BY s.criado_em DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      const solicitacoes = dataResult.rows.map((row) => {
        const aso = buildAso(row);
        return {
          id:           row.id,
          formularioId: row.formulario_id,
          status:       row.status,
          dados:        row.dados,
          diasTeste:    row.usuario_dias_teste ?? null,
          criadoEm:     row.criado_em,
          atualizadoEm: row.atualizado_em,
          candidato: row.usuario_id ? {
            id:   row.usuario_id,
            nome: row.usuario_nome,
            cpf:  row.usuario_cpf,
            diasTeste: row.usuario_dias_teste ?? null,
            cargo:   row.cargo_id   ? { id: row.cargo_id,   nome: row.cargo_nome   } : null,
            empresa: row.empresa_id ? { id: row.empresa_id, nome: row.empresa_nome } : null,
          } : null,
          ...(aso ? { aso } : {}),
        };
      });

      return successResponse({ solicitacoes, total, page, limit });
    } catch (error) {
      console.error('Erro ao listar solicitações de admissão:', error);
      return serverErrorResponse('Erro ao listar solicitações de admissão');
    }
  });
}
