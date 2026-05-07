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
  /** Cargo da vaga (ex.: "MOTOBOY") */
  cargo: string;
  /** UF/sigla pra hashtag no histórico (ex.: "GO", "SP", "CSC", "CTBA") */
  hashtag: string;
  /** Valor em reais (number) */
  valor: number;
  /** Código da filial Winthor (PCLANC.CODFILIAL) — empresas.cod_filial_winthor */
  codFilial: number;
  /** Chave PIX já normalizada (sem +55 no telefone — só dígitos crus) */
  chavePix: string;
  /** Tipo da chave: 'telefone' | 'cpf' | 'cnpj' | 'email' | 'aleatoria' */
  tipoChave: string;
  /** Login Winthor do gestor que aprovou o pagamento (ex.: "ROBSONAREND") */
  nomeFunc: string;
}

interface LancarResultado {
  recnum: number;
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
    const historico =
      `PAGAMENTO REF.DIA DE PRESTACAO DE SERVICO (${nome}) ${cargo}` +
      (hashtag ? ` #${hashtag}` : '');

    // 1. Reserva RECNUM
    const r0 = await conn.execute<{ N: number }>(
      `SELECT FERRAMENTAS.F_PROX_RECNUM AS N FROM DUAL`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const recnum = (r0.rows?.[0]?.N as number) ?? 0;
    if (!recnum) throw new Error('Winthor: F_PROX_RECNUM retornou 0');

    // 2. INSERT em PCLANC com defaults equivalentes aos lançamentos manuais.
    await conn.execute(
      `INSERT INTO WINDOW.PCLANC (
         RECNUM, DTLANC, HISTORICO, DUPLIC, CODFILIAL, INDICE, TIPOLANC,
         TIPOPARCEIRO, NOMEFUNC, TIPOPAGTO, MOEDA, NFSERVICO, ADIANTAMENTO,
         FORMAPGTO, CODROTINACAD, CODROTINAALT, PARCELA, NUMNOTA, CODFORNEC,
         TIPOSERVICO, LACREDIGCONECSOCIAL, OPCAOPAGAMENTOIPVA,
         UTILIZOURATEIOCONTA, PRCRATEIOUTILIZADO, VALOR, CODCONTA,
         DTVENC, DTEMISSAO, DTCOMPETENCIA, DTAGENDAMENTO, DTMOEDA,
         FORNECEDOR, REINFEVENTOR4040, AGENDAMENTO,
         CHAVEPIX, TIPOCHAVEPIX, CODTIPOCHAVEPIX
       ) VALUES (
         :recnum, SYSDATE, :historico, '1', :codFilial, 'A', 'C',
         'F', :nomeFunc, NULL, 'R', 'N', NULL,
         '45', 'DIA TESTE PEOPLE', 'DIA TESTE PEOPLE', '1', 0, 1045,
         '99', 0, 0,
         'N', 100, :valor, 23124,
         TRUNC(SYSDATE), TRUNC(SYSDATE), TRUNC(SYSDATE), TRUNC(SYSDATE), TRUNC(SYSDATE),
         'PRESTADOR DE SERVICO', 'N', 'N',
         :chavePix, :tipoChaveLabel, :tipoChaveCod
       )`,
      {
        recnum,
        historico,
        codFilial: args.codFilial,
        nomeFunc: (args.nomeFunc || '').toUpperCase().replace(/\s+/g, '').slice(0, 20),
        valor: args.valor,
        chavePix: chave,
        tipoChaveLabel: tipo.label,
        tipoChaveCod: tipo.cod,
      },
    );

    await conn.commit();
    return { recnum };
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
