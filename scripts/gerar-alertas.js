const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USERNAME || 'bluepoint',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE || 'bluepoint',
});

async function main() {
  await pool.query('SET search_path TO bluepoint, public');
  const empresas = await pool.query('SELECT id, nome_fantasia FROM bt_empresas');
  let gerados = 0;

  for (const emp of empresas.rows) {
    const t = await pool.query('SELECT COUNT(*) as t FROM bt_colaboradores WHERE empresa_id = $1 AND status = $2', [emp.id, 'ativo']);
    const pr = await pool.query('SELECT COUNT(DISTINCT m.colaborador_id) as t FROM bt_marcacoes m JOIN bt_colaboradores c ON m.colaborador_id = c.id WHERE c.empresa_id = $1 AND DATE(m.data_hora) = CURRENT_DATE', [emp.id]);
    const tot = parseInt(t.rows[0].t), pres = parseInt(pr.rows[0].t), aus = tot - pres;
    if (tot === 0) continue;
    const pct = Math.round((aus / tot) * 100);

    if (aus >= 50) {
      await pool.query('INSERT INTO bt_alertas_inteligentes (empresa_id,categoria,severidade,titulo,mensagem,dados,origem) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [emp.id, 'ausencia', 'critico', emp.nome_fantasia + ': ' + aus + ' ausentes hoje!', aus + ' de ' + tot + ' (' + pct + '%)', JSON.stringify({aus,tot,pct}), 'regra']);
      gerados++; console.log('CRIT: ' + emp.nome_fantasia);
    } else if (pct >= 30) {
      await pool.query('INSERT INTO bt_alertas_inteligentes (empresa_id,categoria,severidade,titulo,mensagem,dados,origem) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [emp.id, 'ausencia', 'atencao', emp.nome_fantasia + ': ' + pct + '% ausencia (' + aus + ')', aus + ' de ' + tot + ' ausentes', JSON.stringify({aus,tot,pct}), 'regra']);
      gerados++; console.log('ATENC: ' + emp.nome_fantasia);
    }
  }

  const admins = await pool.query("SELECT id FROM bt_colaboradores WHERE tipo = 'admin' AND status = 'ativo'");
  for (const a of admins.rows) {
    await pool.query('INSERT INTO bt_notificacoes (usuario_id,tipo,titulo,mensagem,link) VALUES ($1,$2,$3,$4,$5)',
      [a.id, 'alerta', 'Analise: ' + gerados + ' alerta(s)', gerados + ' alertas detectados', '/alertas-inteligentes']);
  }

  console.log(gerados + ' alertas, ' + admins.rows.length + ' admins notificados');
  const all = await pool.query('SELECT severidade, titulo FROM bt_alertas_inteligentes ORDER BY id');
  all.rows.forEach(r => console.log('[' + r.severidade + '] ' + r.titulo));
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
