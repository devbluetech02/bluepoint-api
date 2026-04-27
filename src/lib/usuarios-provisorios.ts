import { query } from './db';
import { isValidCPF } from './utils';

// Helper compartilhado entre o endpoint POST /usuarios-provisorios e o novo
// fluxo de Recrutamento (POST /recrutamento/processos). Toda a lógica de
// negócio do "criar ou reaproveitar provisório + criar solicitação de
// admissão" mora aqui — assim o caminho B do recrutamento entra exatamente
// no mesmo trilho de pré-admissão que o cadastro manual sempre usou.

export const STATUS_TERMINAL_FALHA = new Set(['rejeitado', 'aso_reprovado']);

export interface CriarProvisorioInput {
  nome: string;
  cpf: string;
  empresaId: number;
  cargoId: number;
  departamentoId: number;
  jornadaId: number;
  diasTeste?: number | null;
}

export interface CriarProvisorioResultado {
  provRow: {
    id: number;
    nome: string;
    cpf: string;
    empresa_id: number;
    cargo_id: number;
    departamento_id: number;
    jornada_id: number;
    dias_teste: number | null;
    status: string;
    criado_em: Date;
  };
  solicitacaoId: string;
  reutilizado: boolean;
  readmissao: boolean;
}

export type CriarProvisorioErro =
  | { code: 'cpf_invalido' }
  | { code: 'colaborador_ativo' }
  | { code: 'processo_em_andamento' }
  | { code: 'fk_invalida'; campo: string; id: number }
  | { code: 'sem_formulario_ativo' };

const VINCULOS: Array<{
  campo: 'empresaId' | 'cargoId' | 'departamentoId' | 'jornadaId';
  tabela: string;
  label: string;
}> = [
  { campo: 'empresaId',      tabela: 'empresas',      label: 'Empresa' },
  { campo: 'cargoId',        tabela: 'cargos',        label: 'Cargo' },
  { campo: 'departamentoId', tabela: 'departamentos', label: 'Departamento' },
  { campo: 'jornadaId',      tabela: 'jornadas',      label: 'Jornada' },
];

/**
 * Cria ou reaproveita um usuário provisório + solicitação de admissão
 * `nao_acessado`. Não inicia transação por fora — o chamador deve abrir
 * BEGIN/COMMIT se quiser amarrar com outras escritas (ex: processo_seletivo).
 *
 * Retorna `{ erro }` em caso de violação de regra de negócio. Erros de
 * infraestrutura sobem como exceções normais.
 */
export async function criarOuReaproveitarProvisorio(
  input: CriarProvisorioInput,
  criadoPorUserId: number
): Promise<{ ok: true; data: CriarProvisorioResultado } | { ok: false; erro: CriarProvisorioErro }> {
  const { nome, cpf, empresaId, cargoId, departamentoId, jornadaId, diasTeste } = input;

  const cpfLimpo = cpf.replace(/\D/g, '');
  if (!isValidCPF(cpfLimpo)) {
    return { ok: false, erro: { code: 'cpf_invalido' } };
  }

  const diasTestePersist: number | null =
    diasTeste === undefined || diasTeste === null || diasTeste === 0 ? null : diasTeste;

  // 1. Colaborador ativo bloqueia, inativo libera readmissão.
  const colaboradorResult = await query<{ id: number; status: string }>(
    `SELECT id, status FROM people.colaboradores WHERE cpf = $1`,
    [cpfLimpo]
  );
  const colaborador = colaboradorResult.rows[0] ?? null;
  if (colaborador?.status === 'ativo') {
    return { ok: false, erro: { code: 'colaborador_ativo' } };
  }
  const readmissao = colaborador?.status === 'inativo';

  // 2. Provisório existente — reaproveita só se solicitação mais recente foi terminal de falha.
  const provisorioExistente = await query<{ id: number; status_solicitacao: string | null }>(
    `SELECT up.id,
            (SELECT s.status
               FROM people.solicitacoes_admissao s
              WHERE s.usuario_provisorio_id = up.id
              ORDER BY s.criado_em DESC
              LIMIT 1) AS status_solicitacao
       FROM people.usuarios_provisorios up
      WHERE up.cpf = $1`,
    [cpfLimpo]
  );
  const provisorio = provisorioExistente.rows[0] ?? null;
  const podeReaproveitar = provisorio != null
    && provisorio.status_solicitacao != null
    && STATUS_TERMINAL_FALHA.has(provisorio.status_solicitacao);

  if (provisorio != null && !podeReaproveitar) {
    return { ok: false, erro: { code: 'processo_em_andamento' } };
  }

  // 3. FKs de vínculo.
  const valoresPorCampo = { empresaId, cargoId, departamentoId, jornadaId };
  for (const v of VINCULOS) {
    const id = valoresPorCampo[v.campo];
    const check = await query(
      `SELECT 1 FROM people.${v.tabela} WHERE id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return { ok: false, erro: { code: 'fk_invalida', campo: v.label, id } };
    }
  }

  // 4. Formulário ativo.
  const formResult = await query<{ id: string }>(
    `SELECT id FROM people.formularios_admissao
      WHERE ativo = true
      ORDER BY atualizado_em DESC
      LIMIT 1`,
    []
  );
  if (formResult.rows.length === 0) {
    return { ok: false, erro: { code: 'sem_formulario_ativo' } };
  }
  const formularioId = formResult.rows[0].id;

  // 5. Cria/reaproveita provisório + nova solicitação 'nao_acessado'.
  let provRow: CriarProvisorioResultado['provRow'];
  let reutilizado = false;

  if (podeReaproveitar && provisorio) {
    reutilizado = true;
    const upd = await query<CriarProvisorioResultado['provRow']>(
      `UPDATE people.usuarios_provisorios
          SET nome            = $1,
              empresa_id      = $2,
              cargo_id        = $3,
              departamento_id = $4,
              jornada_id      = $5,
              dias_teste      = $6,
              status          = 'ativo',
              atualizado_em   = NOW()
        WHERE id = $7
      RETURNING id, nome, cpf, empresa_id, cargo_id, departamento_id, jornada_id, dias_teste, status, criado_em`,
      [nome, empresaId, cargoId, departamentoId, jornadaId, diasTestePersist, provisorio.id]
    );
    provRow = upd.rows[0];
  } else {
    const insProv = await query<CriarProvisorioResultado['provRow']>(
      `INSERT INTO people.usuarios_provisorios
         (nome, cpf, empresa_id, cargo_id, departamento_id, jornada_id, dias_teste, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, nome, cpf, empresa_id, cargo_id, departamento_id, jornada_id, dias_teste, status, criado_em`,
      [nome, cpfLimpo, empresaId, cargoId, departamentoId, jornadaId, diasTestePersist, criadoPorUserId]
    );
    provRow = insProv.rows[0];
  }

  const solResult = await query<{ id: string }>(
    `INSERT INTO people.solicitacoes_admissao
       (formulario_id, status, dados, usuario_provisorio_id)
     VALUES ($1, 'nao_acessado', '{}'::jsonb, $2)
     RETURNING id`,
    [formularioId, provRow.id]
  );
  const solicitacaoId = solResult.rows[0].id;

  return {
    ok: true,
    data: { provRow, solicitacaoId, reutilizado, readmissao },
  };
}
