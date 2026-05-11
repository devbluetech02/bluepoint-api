// Importa atestados marcados no PDF "folha mes 4.pdf" para people.solicitacoes.
// Uso: RDS_IP=x.x.x.x node import-atestados-mes4.mjs [--apply]
import fs from 'node:fs';
import pg from 'pg';

const TXT_PATH = 'C:\\Users\\Christofer\\documents\\projetos\\people\\folha_mes_4.txt';
const APPLY = process.argv.includes('--apply');
const RDS_IP = process.env.RDS_IP;
if (!RDS_IP) { console.error('RDS_IP env var requerido'); process.exit(1); }

function parsePdf(text) {
  const lines = text.split(/\r?\n/);
  const colaboradores = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine;

    if (line.includes('Colaborador:') && !line.includes('CPF:')) {
      const m = line.match(/Colaborador:\s+(.+?)\s{2,}/);
      if (m) {
        if (current) colaboradores.push(current);
        current = { nome: m[1].trim(), cpf: null, dias: [] };
      }
      continue;
    }

    const cpfM = line.match(/Colaborador CPF:\s+([\d.\-]+)/);
    if (cpfM && current) {
      current.cpf = cpfM[1].replace(/\D/g, '');
      continue;
    }

    const trimmed = line.trimStart();
    const dayM = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{2})\s+-\s+\S+\s+(.*)$/);
    if (dayM && current) {
      const [, dd, mm, yy, rest] = dayM;
      const date = `20${yy}-${mm}-${dd}`;
      const fields = rest.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
      const realizado = fields[1] ?? '';
      const status = realizado.trim();
      let tipo = null;
      if (/^Atestado$/i.test(status)) tipo = 'atestado';
      // Outros status (Falta, Folga, Feriado, punches) ignorados.
      if (tipo) current.dias.push({ date, tipo });
    }
  }
  if (current) colaboradores.push(current);
  return colaboradores;
}

// Agrupa dias consecutivos do mesmo tipo em períodos
function agruparPeriodos(dias) {
  if (dias.length === 0) return [];
  const sorted = [...dias].sort((a, b) => a.date.localeCompare(b.date));
  const periodos = [];
  let inicio = sorted[0].date;
  let fim = sorted[0].date;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(fim + 'T00:00:00');
    const cur = new Date(sorted[i].date + 'T00:00:00');
    const diffDays = (cur - prev) / 86400000;
    if (diffDays === 1) {
      fim = sorted[i].date;
    } else {
      periodos.push({ inicio, fim });
      inicio = sorted[i].date;
      fim = sorted[i].date;
    }
  }
  periodos.push({ inicio, fim });
  return periodos;
}

async function main() {
  const text = fs.readFileSync(TXT_PATH, 'utf8');
  const colabs = parsePdf(text);
  const comAtestados = colabs.filter(c => c.dias.length > 0);
  console.log(`PDF parsed: ${colabs.length} colaboradores, ${comAtestados.length} com atestado.`);

  const client = new pg.Client({
    host: RDS_IP, port: 5432, database: 'postgres',
    user: 'postgres', password: 'postgres123',
  });
  await client.connect();

  const cpfs = comAtestados.map(c => c.cpf).filter(Boolean);
  const colabRows = await client.query(
    `SELECT id, nome, regexp_replace(cpf, '\\D', '', 'g') AS cpf_clean, status
     FROM people.colaboradores
     WHERE regexp_replace(cpf, '\\D', '', 'g') = ANY($1::text[])`,
    [cpfs]
  );
  const byCpf = new Map(colabRows.rows.map(r => [r.cpf_clean, r]));

  // Atestados existentes em abril/2026 (período sobreposto)
  const matchedIds = [...byCpf.values()].map(r => r.id);
  let existRows = { rows: [] };
  if (matchedIds.length) {
    existRows = await client.query(
      `SELECT colaborador_id, data_evento, data_evento_fim
       FROM people.solicitacoes
       WHERE tipo = 'atestado'
         AND status = 'aprovada'
         AND colaborador_id = ANY($1::int[])
         AND data_evento <= '2026-04-30'::date
         AND COALESCE(data_evento_fim, data_evento) >= '2026-04-01'::date`,
      [matchedIds]
    );
  }
  // Map colab_id -> Set<YYYY-MM-DD> de dias já com atestado registrado
  const cobertos = new Map();
  for (const r of existRows.rows) {
    if (!cobertos.has(r.colaborador_id)) cobertos.set(r.colaborador_id, new Set());
    const set = cobertos.get(r.colaborador_id);
    const start = new Date(r.data_evento);
    const end = r.data_evento_fim ? new Date(r.data_evento_fim) : new Date(r.data_evento);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      set.add(iso);
    }
  }

  const inserts = [];
  for (const colab of comAtestados) {
    const dbRow = byCpf.get(colab.cpf);
    if (!dbRow) continue;
    if (dbRow.status !== 'ativo') continue;
    const cobertosSet = cobertos.get(dbRow.id) ?? new Set();
    const diasFiltrados = colab.dias.filter(d => !cobertosSet.has(d.date));
    if (diasFiltrados.length === 0) continue;
    const periodos = agruparPeriodos(diasFiltrados);
    for (const p of periodos) {
      inserts.push({
        colaborador_id: dbRow.id,
        nome: dbRow.nome,
        data_inicio: p.inicio,
        data_fim: p.fim === p.inicio ? null : p.fim,
      });
    }
  }

  console.log(`\n=== Resumo ===`);
  console.log(`Colaboradores com atestado: ${comAtestados.length}`);
  console.log(`Matched no DB: ${[...byCpf.keys()].length}`);
  console.log(`Atestados (períodos) a inserir: ${inserts.length}`);
  console.log(`Amostra:`);
  for (const i of inserts.slice(0, 8)) {
    console.log(`  ${i.nome.padEnd(40)} ${i.data_inicio}${i.data_fim ? ' a ' + i.data_fim : ''}`);
  }

  if (!APPLY) {
    console.log('\n[DRY RUN] Use --apply para executar inserts.');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    for (const r of inserts) {
      await client.query(
        `INSERT INTO people.solicitacoes
           (colaborador_id, tipo, status, data_solicitacao, data_evento, data_evento_fim,
            descricao, justificativa, origem, aprovador_id, data_aprovacao)
         VALUES ($1, 'atestado', 'aprovada', CURRENT_TIMESTAMP, $2::date, $3::date,
                 $4, $5, 'manual', 1, CURRENT_TIMESTAMP)`,
        [
          r.colaborador_id,
          r.data_inicio,
          r.data_fim,
          'Atestado importado da folha de ponto Winthor',
          'Importação automática (folha mes 4.pdf)',
        ]
      );
    }
    await client.query('COMMIT');
    console.log(`OK: ${inserts.length} atestados inseridos.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('FALHA — rollback:', e);
    process.exit(2);
  }
  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
