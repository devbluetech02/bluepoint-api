import { NextRequest } from 'next/server';
import { query, queryRecrutamento } from '@/lib/db';
import {
  successResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';

// GET /api/v1/recrutamento/candidatos/:cpf
//
// Retorna a candidatura mais recente do CPF informado, com todos os campos
// mapeados em FLUXO_RECRUTAMENTO.md §2.3 + bloco de referências (§3.8).
// `:cpf` pode vir formatado ou só com dígitos — o endpoint normaliza.
//
// O processo_seletivo no People (se existir) também volta junto, pra que o
// front saiba se já há um processo vivo pra esse candidato.

interface CandidatoRow {
  id: number;
  nome: string;
  cpf_norm: string;
  cpf: string;
  telefone_norm: string;
  telefone: string | null;
  email: string | null;
  data_nasc: string | null;
  sexo: string | null;
  rg_candidato: string | null;
  cnh_categoria: string | null;
  cep: string | null;
  logradouro: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  estado: string | null;
  vaga: string | null;
  vaga_interesse: string | null;
  cloudinary_url: string | null;
  banco: string | null;
  chave_pix: string | null;
  tipo_chave: string | null;
  data_candidatura: Date | null;

  // referências
  nome_referencia: string | null;
  telefone_referencia: string | null;
  descricao_referencia: string | null;
  status_referencia: string | null;
  nome_referencia_2: string | null;
  telefone_referencia_2: string | null;
  descricao_referencia_2: string | null;
  status_referencia_2: string | null;
  nome_referencia_3: string | null;
  telefone_referencia_3: string | null;
  descricao_referencia_3: string | null;
  status_referencia_3: string | null;
}

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function mapStatusReferencia(raw: string | null): string {
  const t = trimOrNull(raw)?.toUpperCase();
  if (!t) return 'pendente';
  if (t === 'APROVADO') return 'aprovada';
  if (t === 'REPROVADO') return 'reprovada';
  if (t === 'INDETERMINADO') return 'nao_validada';
  return 'pendente';
}

function buildReferencia(
  posicao: 1 | 2 | 3,
  nome: string | null,
  telefone: string | null,
  descricao: string | null,
  status: string | null
) {
  const nomeT = trimOrNull(nome);
  const telT = trimOrNull(telefone);
  const descT = trimOrNull(descricao);
  // §3.8: nome === "Inexistente" (string literal) → ausente
  const ausente = !nomeT || nomeT.toLowerCase() === 'inexistente';
  return {
    posicao,
    ausente,
    nome: ausente ? null : nomeT,
    telefone: ausente ? null : telT,
    descricao: ausente ? null : descT,
    status: ausente ? 'ausente' : mapStatusReferencia(status),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cpf: string }> }
) {
  return withGestor(request, async () => {
    try {
      const { cpf } = await params;
      const cpfNorm = (cpf ?? '').replace(/\D/g, '');
      if (cpfNorm.length !== 11) {
        return errorResponse('CPF inválido', 400);
      }

      const result = await queryRecrutamento<CandidatoRow>(
        `WITH base AS (
           SELECT
             id, nome, cpf, telefone, email, data_nasc, sexo, rg_candidato,
             cnh_categoria, cep, logradouro, bairro, cidade, uf, estado,
             vaga, vaga_interesse, cloudinary_url, banco, chave_pix, tipo_chave,
             data_candidatura,
             nome_referencia, telefone_referencia, descricao_referencia, status_referencia,
             nome_referencia_2, telefone_referencia_2, descricao_referencia_2, status_referencia_2,
             nome_referencia_3, telefone_referencia_3, descricao_referencia_3, status_referencia_3,
             regexp_replace(cpf, '\\D', '', 'g')      AS cpf_norm,
             regexp_replace(telefone, '\\D', '', 'g') AS telefone_norm
             FROM public.candidatos
            WHERE regexp_replace(cpf, '\\D', '', 'g') = $1
            ORDER BY data_candidatura DESC NULLS LAST, id DESC
            LIMIT 1
         )
         SELECT * FROM base`,
        [cpfNorm]
      );

      const c = result.rows[0];
      if (!c) {
        return notFoundResponse('Candidato não encontrado no banco de Recrutamento');
      }

      // processo_seletivo no People + status atual da solicitação de admissão
      // vinculada (que é o que o DP vê — granular: nao_acessado,
      // aguardando_rh, contrato_assinado, etc).
      const procResult = await query<{
        id: string;
        status: string;
        caminho: string;
        criado_em: Date;
        usuario_provisorio_id: number | null;
        solicitacao_admissao_id: string | null;
        solicitacao_status: string | null;
      }>(
        `SELECT ps.id::text, ps.status, ps.caminho, ps.criado_em,
                ps.usuario_provisorio_id, ps.solicitacao_admissao_id,
                sa.status AS solicitacao_status
           FROM people.processo_seletivo ps
           LEFT JOIN people.solicitacoes_admissao sa
                  ON sa.id = ps.solicitacao_admissao_id
          WHERE ps.candidato_cpf_norm = $1
          ORDER BY ps.criado_em DESC
          LIMIT 1`,
        [cpfNorm]
      );
      const proc = procResult.rows[0] ?? null;

      const payload = {
        id: c.id,
        nome: trimOrNull(c.nome),
        cpf: c.cpf_norm,
        telefone: c.telefone_norm || null,
        email: trimOrNull(c.email),
        dataNascimento: c.data_nasc,
        sexo: trimOrNull(c.sexo),
        rgNumero: trimOrNull(c.rg_candidato),
        cnhCategoria: trimOrNull(c.cnh_categoria),
        endereco: {
          cep: trimOrNull(c.cep),
          logradouro: trimOrNull(c.logradouro),
          bairro: trimOrNull(c.bairro),
          cidade: trimOrNull(c.cidade),
          uf: trimOrNull(c.uf),
          estado: trimOrNull(c.estado),
        },
        vaga: trimOrNull(c.vaga),
        vagaInteresse: trimOrNull(c.vaga_interesse),
        curriculoUrl: trimOrNull(c.cloudinary_url),
        banco: trimOrNull(c.banco),
        pix: {
          chave: trimOrNull(c.chave_pix),
          tipoChave: trimOrNull(c.tipo_chave),
        },
        dataCandidatura: c.data_candidatura,
        referencias: [
          buildReferencia(1, c.nome_referencia, c.telefone_referencia, c.descricao_referencia, c.status_referencia),
          buildReferencia(2, c.nome_referencia_2, c.telefone_referencia_2, c.descricao_referencia_2, c.status_referencia_2),
          buildReferencia(3, c.nome_referencia_3, c.telefone_referencia_3, c.descricao_referencia_3, c.status_referencia_3),
        ],
        processoSeletivo: proc
          ? {
              id: proc.id,
              status: proc.status,
              caminho: proc.caminho,
              criadoEm: proc.criado_em,
              usuarioProvisorioId: proc.usuario_provisorio_id,
              solicitacaoAdmissaoId: proc.solicitacao_admissao_id,
              solicitacaoStatus: proc.solicitacao_status,
            }
          : null,
      };

      return successResponse(payload);
    } catch (error) {
      console.error('[recrutamento/candidatos/:cpf] erro:', error);
      return serverErrorResponse('Erro ao buscar candidato');
    }
  });
}
