/**
 * Integração com o ERP Winthor (Oracle).
 *
 * Atualmente usado pra registrar pagamentos PIX a candidatos em dia de
 * teste como contas a pagar (WINDOW.PCLANC). Padrão descoberto a partir
 * dos lançamentos manuais existentes:
 *
 *   - CODFORNEC = 1045 (fornecedor genérico "PRESTADOR DE SERVIÇO")
 *   - FORMAPGTO = 45 (PIX)
 *   - CODCONTA  = 23124
 *   - TIPOSERVICO = 99
 *   - CODFILIAL  = empresa.cod_filial_winthor (dynamic)
 *
 * Variáveis de ambiente:
 *   WINTHOR_DSN, WINTHOR_USER, WINTHOR_PASSWORD (SecureStrings SSM)
 *
 * Modo "thick" (Oracle Instant Client) é necessário porque o Winthor
 * usa um verifier de senha antigo. Inicializa lazy na primeira chamada;
 * `ORACLE_INSTANT_CLIENT_DIR` aponta pro diretório no container Docker.
 */

import oracledb, { type Pool as OraPool } from 'oracledb';

let inited = false;
let pool: OraPool | null = null;

function ensureClient(): void {
  if (inited) return;
  const libDir = process.env.ORACLE_INSTANT_CLIENT_DIR;
  if (libDir) {
    try {
      oracledb.initOracleClient({ libDir });
    } catch (e) {
      // initOracleClient só pode ser chamado 1x — em dev/test pode ter
      // sido chamado por outra rota; ignora "already initialized".
      if (!`${(e as Error).message}`.includes('NJS-077')) {
        throw e;
      }
    }
  }
  inited = true;
}

async function getPool(): Promise<OraPool> {
  ensureClient();
  if (pool) return pool;
  const user = process.env.WINTHOR_USER;
  const password = process.env.WINTHOR_PASSWORD;
  const dsn = process.env.WINTHOR_DSN;
  if (!user || !password || !dsn) {
    throw new Error('Winthor: WINTHOR_USER/WINTHOR_PASSWORD/WINTHOR_DSN não configurados');
  }
  pool = await oracledb.createPool({
    user,
    password,
    connectString: dsn,
    poolMin: 0,
    poolMax: 4,
    poolIncrement: 1,
    poolTimeout: 60,
    queueTimeout: 30_000,
  });
  return pool;
}

interface LancarPagamentoArgs {
  /** Nome completo do candidato (ex.: "JOÃO DA SILVA") */
  nomeCandidato: string;
  /** Cargo da vaga (ex.: "MOTOBOY") — usado pra mapear o centro de custo. */
  cargo: string;
  /** UF/sigla pra hashtag no histórico (ex.: "GO", "SP", "CSC", "CTBA") */
  hashtag: string;
  /** Valor em reais (number) */
  valor: number;
  /** Chave PIX já normalizada (sem +55 no telefone — só dígitos crus) */
  chavePix: string;
  /** Tipo da chave: 'telefone' | 'cpf' | 'cnpj' | 'email' | 'aleatoria' */
  tipoChave: string;
  /** Login Winthor do gestor que aprovou o pagamento (ex.: "ROBSONAREND") */
  nomeFunc: string;
  /**
   * Data do dia de teste sendo pago (YYYY-MM-DD). Entra no HISTORICO pra
   * diferenciar lançamentos do mesmo candidato em dias distintos lançados
   * no MESMO DIA — sem isso, o anti-dup por (HISTORICO+CHAVEPIX+VALOR) +
   * TRUNC(DTLANC)=TRUNC(SYSDATE) bloqueia o segundo lançamento.
   * Opcional pra compatibilidade com callers legados (cron, admin test).
   */
  dataDiaTeste?: string;
}

interface LancarResultado {
  recnum: number;
  codigoCentroCusto: string;
}

/** CODFILIAL fixa pros pagamentos PIX do dia de teste (regra do financeiro). */
const COD_FILIAL_FIXA = '17';

/** CODIGOCENTROCUSTO default quando o cargo não bate em nenhuma chave conhecida. */
const CC_DEFAULT = '1.1'; // ADMINISTRATIVO GERAL

/**
 * Tira acentos / normaliza pra match case-insensitive contra a tabela.
 * Ex.: "VENDEDOR INTERNO" === normalize("vendedor interno  ").
 */
function normCargo(c: string): string {
  return c
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mapeia cargo do nosso domínio → CODIGOCENTROCUSTO em WINDOW.PCCENTROCUSTO.
 * Mapping aprovado pelo financeiro em 2026-05-08. Cargos novos caem no default.
 */
const CARGO_TO_CC: Record<string, string> = {
  'ANALISTA DE DP': '5.1.2',                       // DEPARTAMENTO PESSOAL
  'ANALISTA DE FATURAMENTO': '1.1.5',              // FINANCEIRO
  'ANALISTA DE SUPORTE': '4.1.1',                  // ESTRUTURA DE T.I
  'ASSISTENTE DE RECURSOS HUMANOS': '5.1',         // RH GERAL
  'ASSISTENTE DE RELACIONAMENTO': '2.1.2',         // SAC
  'ATENDENTE DE SAC': '2.1.2',                     // SAC
  'AUXILIAR DE OPERACOES': '3.1',                  // OPERACIONAL GERAL
  'AUXILIAR DE SERVICOS GERAIS': '1.1',            // ADMINISTRATIVO GERAL
  'COORDENADOR DE OPERACOES': '3.1',
  'DESENVOLVEDOR': '4.1.7',                        // DESENVOLVIMENTO EM TI
  'ESTOQUISTA': '3.1.1',                           // ESTOQUE / ALMOXARIFADO
  'GERENTE DE OPERACOES': '3.1',
  'LIDER DE ENTREGADOR': '3.1.2',                  // LOGÍSTICA EXTERNA
  'LIDER DE ESTOQUE': '3.1.1',
  'MOTOBOY': '3.1.2',
  'MOTORISTA DE CAMINHAO': '3.1.2',
  'OPERADOR DE EMPILHADEIRA': '3.1.3',             // LOGÍSTICA INTERNA
  'OWNER': '6.1',                                  // DIRETORIA E SÓCIOS GERAL
  'RECEPCIONISTA': '1.1',                          // ADMINISTRATIVO GERAL
  'RECRUTADOR': '5.1.3',                           // RECRUTAMENTO E SELEÇÃO
  'SUPERVISOR A DE RELACIONAMENTOS': '2.1.2',      // SAC — norm troca "(A)" → " A "
  'SUPERVISOR COMERCIAL': '2.1',
  'SUPERVISOR DE OPERACOES': '3.1',
  'VENDEDOR EXTERNO': '2.1.5',                     // COMERCIAL VENDAS EXTERNAS
  'VENDEDOR INTERNO': '2.1.6',                     // COMERCIAL VENDAS INTERNAS
};

function resolverCentroCusto(cargo: string): string {
  return CARGO_TO_CC[normCargo(cargo)] || CC_DEFAULT;
}

/** "YYYY-MM-DD" → "DD/MM/YYYY". Retorna string vazia se input inválido. */
function formatarDataDDMMYYYY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Mapeia tipo de chave do nosso domínio pra (label, código) do Winthor. */
function mapearTipoChavePix(tipo: string): { label: string; cod: string; chaveFormatada: (raw: string) => string } {
  const t = tipo.trim().toLowerCase();
  if (t === 'telefone' || t === 'celular') {
    return {
      label: 'Telefone',
      cod: '01',
      // Winthor armazena só dígitos no campo chave_pix (vimos na consulta:
      // "61998341333"). Sem +55, sem espaços, sem máscara.
      chaveFormatada: (raw) => raw.replace(/\D/g, '').replace(/^55(\d{10,11})$/, '$1'),
    };
  }
  if (t === 'email' || t === 'e-mail') {
    return { label: 'E-mail', cod: '02', chaveFormatada: (raw) => raw.trim().toLowerCase() };
  }
  if (t === 'cpf' || t === 'cnpj') {
    return { label: 'CPF/CNPJ', cod: '03', chaveFormatada: (raw) => raw.replace(/\D/g, '') };
  }
  if (t === 'aleatoria' || t === 'evp') {
    return { label: 'Aleatoria', cod: '04', chaveFormatada: (raw) => raw.trim() };
  }
  return { label: tipo, cod: '99', chaveFormatada: (raw) => raw };
}

/**
 * Insere um lançamento de pagamento PIX em WINDOW.PCLANC.
 * Retorna o RECNUM gerado.
 */
export async function lancarPagamentoPixNoWinthor(
  args: LancarPagamentoArgs,
): Promise<LancarResultado> {
  const p = await getPool();
  const conn = await p.getConnection();
  try {
    const tipo = mapearTipoChavePix(args.tipoChave);
    const chave = tipo.chaveFormatada(args.chavePix);

    const hashtag = (args.hashtag || '').replace(/^#/, '').toUpperCase().slice(0, 8);
    const nome = args.nomeCandidato.trim().toUpperCase().slice(0, 80);
    const cargo = args.cargo.trim().toUpperCase().slice(0, 40);
    const codigoCentroCusto = resolverCentroCusto(args.cargo);
    // Formata data como DD/MM/YYYY pra entrar no HISTORICO. Se o caller
    // não passou (legado), cai pro formato antigo — backwards-compatible.
    const dataFmt = args.dataDiaTeste
      ? formatarDataDDMMYYYY(args.dataDiaTeste)
      : '';
    const historico =
      `PAGAMENTO REF.DIA ${dataFmt ? `${dataFmt} ` : ''}DE PRESTACAO DE SERVICO (${nome}) ${cargo}` +
      (hashtag ? ` #${hashtag}` : '');

    // Pagamento retroativo (data do teste anterior a hoje em BRT) →
    // DTCOMPETENCIA aponta pro dia do teste (regra financeiro: competência
    // reflete a prestação de serviço, não a data do caixa). Same-day mantém
    // SYSDATE. Server roda em UTC; converte agora pra BRT (-03:00) só pra
    // calcular o "hoje" usado na comparação.
    let dtCompetenciaIso: string | null = null;
    if (args.dataDiaTeste) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(args.dataDiaTeste);
      if (m) {
        const dataIso = `${m[1]}-${m[2]}-${m[3]}`;
        const hojeBrt = new Date(Date.now() - 3 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        if (dataIso < hojeBrt) {
          dtCompetenciaIso = dataIso;
        }
      }
    }

    // 1. Anti-dup defensivo: olha pra PCLANC procurando um lançamento
    //    idêntico no MESMO DIA (mesmo HISTORICO + CHAVEPIX + VALOR). Se
    //    achar, devolve o RECNUM existente sem inserir de novo.
    //
    //    Janela de 1 dia (TRUNC(DTLANC) = TRUNC(SYSDATE)) porque "mesmo
    //    candidato + mesmo cargo + mesmo valor + mesma data" é o mesmo
    //    evento de pagamento. Em datas diferentes (ex.: dois dias de
    //    teste em semanas distintas com mesma pessoa), são lançamentos
    //    legítimos separados que devem ser inseridos individualmente.
    //
    //    Cobre 2 cenários que a guarda do `pagamento_pix.winthor_recnum`
    //    no Postgres não pega:
    //      - INSERT manual via /admin/winthor-test-lancamento (sem
    //        atualizar Postgres) seguido de pagamento normal pelo app
    //        no mesmo dia.
    //      - Race condition (dois cron retries em paralelo no mesmo
    //        pagamento — pouco provável, mas barato proteger).
    const dupCheck = await conn.execute<{ RECNUM: number }>(
      `SELECT RECNUM FROM WINDOW.PCLANC
        WHERE HISTORICO = :h
          AND CHAVEPIX  = :c
          AND VALOR     = :v
          AND TRUNC(DTLANC) = TRUNC(SYSDATE)
        FETCH FIRST 1 ROWS ONLY`,
      { h: historico, c: chave, v: args.valor },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const dupRecnum = dupCheck.rows?.[0]?.RECNUM;
    if (dupRecnum) {
      console.log(
        `[winthor] anti-dup: já existe RECNUM=${dupRecnum} (HISTORICO+CHAVEPIX+VALOR ` +
        `mesmo dia); pulando INSERT.`,
      );
      return { recnum: Number(dupRecnum), codigoCentroCusto };
    }

    // 2. Reserva RECNUM — fallback derivando direto de PCLANC porque a
    //    function FERRAMENTAS.F_PROX_RECNUM não está acessível pelo
    //    usuário CHRISTOFER (ORA-00904 "identificador inválido"). Como
    //    PCLANC.RECNUM tem PK, qualquer race condition vira erro de
    //    constraint e o cron retry pega no próximo ciclo.
    const r0 = await conn.execute<{ N: number }>(
      `SELECT NVL(MAX(RECNUM), 0) + 1 AS N FROM WINDOW.PCLANC`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const recnum = (r0.rows?.[0]?.N as number) ?? 0;
    if (!recnum) throw new Error('Winthor: MAX(RECNUM)+1 retornou 0');

    // 3. INSERT em PCLANC com defaults equivalentes aos lançamentos manuais.
    //    CODFILIAL='17' é fixo pra todos os pagamentos PIX do dia de teste
    //    (regra do financeiro — independe da empresa do candidato).
    //    DTMOEDA é VARCHAR2(1) (flag, NULL em 100% dos casos) — fora do INSERT.
    await conn.execute(
      `INSERT INTO WINDOW.PCLANC (
         RECNUM, DTLANC, HISTORICO, DUPLIC, CODFILIAL, INDICE, TIPOLANC,
         TIPOPARCEIRO, NOMEFUNC, TIPOPAGTO, MOEDA, NFSERVICO, ADIANTAMENTO,
         FORMAPGTO, CODROTINACAD, CODROTINAALT, PARCELA, NUMNOTA, CODFORNEC,
         TIPOSERVICO, LACREDIGCONECSOCIAL, OPCAOPAGAMENTOIPVA,
         UTILIZOURATEIOCONTA, PRCRATEIOUTILIZADO, VALOR, CODCONTA,
         DTVENC, DTEMISSAO, DTCOMPETENCIA, DTAGENDAMENTO,
         FORNECEDOR, REINFEVENTOR4040, AGENDAMENTO,
         CHAVEPIX, TIPOCHAVEPIX, CODTIPOCHAVEPIX
       ) VALUES (
         :recnum, SYSDATE, :historico, '1', :codFilial, 'A', 'C',
         'F', :nomeFunc, NULL, 'R', 'N', NULL,
         '45', 'DIA TESTE PEOPLE', 'DIA TESTE PEOPLE', '1', 0, 1045,
         '99', 0, 0,
         'S', 100, :valor, 23124,
         TRUNC(SYSDATE), TRUNC(SYSDATE),
         NVL(TO_DATE(:dtCompetencia, 'YYYY-MM-DD'), TRUNC(SYSDATE)),
         TRUNC(SYSDATE),
         'PRESTADOR DE SERVICO', 'N', 'N',
         :chavePix, :tipoChaveLabel, :tipoChaveCod
       )`,
      {
        recnum,
        historico,
        codFilial: COD_FILIAL_FIXA,
        nomeFunc: (args.nomeFunc || '').toUpperCase().replace(/\s+/g, '').slice(0, 20),
        valor: args.valor,
        chavePix: chave,
        tipoChaveLabel: tipo.label,
        tipoChaveCod: tipo.cod,
        dtCompetencia: dtCompetenciaIso,
      },
    );

    // 4. INSERT do rateio em PCRATEIOCENTROCUSTO — 1 linha com 100% no CC
    //    derivado do cargo. Sem isso o lançamento entra na PCLANC mas o
    //    contábil não consegue alocar por departamento (gera relatório
    //    quebrado e o financeiro tem que rateirar manualmente).
    //    UTILIZOURATEIOCONTA='S' acima sinaliza pro Winthor que o rateio
    //    veio populado pela rotina externa.
    await conn.execute(
      `INSERT INTO WINDOW.PCRATEIOCENTROCUSTO (
         RECNUM, CODCONTA, VALOR, PERCRATEIO, DTLANC, CODFILIAL,
         CODIGOCENTROCUSTO, ROTINAINSERT, CONTRAPARTIDA
       ) VALUES (
         :recnum, 23124, :valor, 100, SYSDATE, :codFilial,
         :cc, 'DIA TESTE PEOPLE', 'N'
       )`,
      {
        recnum,
        valor: args.valor,
        codFilial: COD_FILIAL_FIXA,
        cc: codigoCentroCusto,
      },
    );

    await conn.commit();
    return { recnum, codigoCentroCusto };
  } finally {
    try { await conn.close(); } catch { /* noop */ }
  }
}

/** Util pra debug em endpoint admin — devolve true se ping (SELECT 1 FROM DUAL) deu OK. */
export async function pingWinthor(): Promise<boolean> {
  try {
    const p = await getPool();
    const c = await p.getConnection();
    try {
      await c.execute(`SELECT 1 FROM DUAL`);
      return true;
    } finally {
      await c.close();
    }
  } catch (e) {
    console.warn('[winthor] ping falhou:', (e as Error).message);
    return false;
  }
}
