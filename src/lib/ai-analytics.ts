import { query } from '@/lib/db';
import { criarNotificacao } from '@/lib/notificacoes';
import { sendEmail } from '@/lib/email';

interface MetricasEmpresa {
  empresaId: number;
  nomeFantasia: string;
  totalColaboradores: number;
  presentesHoje: number;
  ausentesHoje: number;
  atrasadosHoje: number;
  horasExtrasMes: number;
  limiteHorasExtras: number | null;
  percentualLimiteHE: number | null;
  solicitacoesPendentes: number;
  tendenciaAusencias7d: number[];
  departamentoMaisAusencias: { nome: string; ausentes: number } | null;
}

interface AlertaGerado {
  empresaId: number | null;
  categoria: string;
  severidade: 'info' | 'atencao' | 'critico';
  titulo: string;
  mensagem: string;
  dados: Record<string, unknown>;
  origem: 'ia' | 'regra';
}

interface AnaliseResultado {
  alertas: AlertaGerado[];
  metricas: MetricasEmpresa[];
  analisadoEm: string;
  iaDisponivel: boolean;
}

async function coletarMetricasPorEmpresa(): Promise<MetricasEmpresa[]> {
  const empresasResult = await query(
    'SELECT id, nome_fantasia FROM bluepoint.bt_empresas ORDER BY nome_fantasia'
  );
  const metricas: MetricasEmpresa[] = [];

  for (const empresa of empresasResult.rows) {
    const eid = empresa.id;
    const [totalColab, presentesHoje, atrasadosHoje, horasExtrasMes, limiteHE, pendentes, tendencia7d, deptAusencias] = await Promise.all([
      query('SELECT COUNT(*) as total FROM bluepoint.bt_colaboradores WHERE empresa_id = $1 AND status = \'ativo\'', [eid]),
      query('SELECT COUNT(DISTINCT m.colaborador_id) as presentes FROM bluepoint.bt_marcacoes m JOIN bluepoint.bt_colaboradores c ON m.colaborador_id = c.id WHERE c.empresa_id = $1 AND DATE(m.data_hora) = CURRENT_DATE', [eid]),
      query('SELECT COUNT(DISTINCT s.colaborador_id) as atrasados FROM bluepoint.bt_solicitacoes s JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.tipo = \'atraso\' AND DATE(s.data_evento) = CURRENT_DATE', [eid]),
      query('SELECT COALESCE(SUM(CASE WHEN bh.horas > 0 THEN bh.horas ELSE 0 END), 0) as total FROM bluepoint.bt_banco_horas bh JOIN bluepoint.bt_colaboradores c ON bh.colaborador_id = c.id WHERE c.empresa_id = $1 AND EXTRACT(MONTH FROM bh.data) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM bh.data) = EXTRACT(YEAR FROM CURRENT_DATE)', [eid]),
      query('SELECT limite_mensal FROM bluepoint.bt_limites_he_empresas WHERE empresa_id = $1', [eid]),
      query('SELECT COUNT(*) as total FROM bluepoint.bt_solicitacoes s JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.status = \'pendente\'', [eid]),
      query('SELECT d.dia::date as dia, (SELECT COUNT(*) FROM bluepoint.bt_colaboradores c2 WHERE c2.empresa_id = $1 AND c2.status = \'ativo\' AND c2.id NOT IN (SELECT DISTINCT colaborador_id FROM bluepoint.bt_marcacoes WHERE DATE(data_hora) = d.dia::date)) as ausentes FROM generate_series(CURRENT_DATE - INTERVAL \'6 days\', CURRENT_DATE, \'1 day\') d(dia) ORDER BY d.dia', [eid]),
      query('SELECT d.nome, COUNT(c.id) as ausentes FROM bluepoint.bt_departamentos d JOIN bluepoint.bt_colaboradores c ON c.departamento_id = d.id WHERE c.empresa_id = $1 AND c.status = \'ativo\' AND c.id NOT IN (SELECT DISTINCT colaborador_id FROM bluepoint.bt_marcacoes WHERE DATE(data_hora) = CURRENT_DATE) GROUP BY d.id, d.nome ORDER BY ausentes DESC LIMIT 1', [eid]),
    ]);

    const total = parseInt(totalColab.rows[0]?.total || '0');
    const presentes = parseInt(presentesHoje.rows[0]?.presentes || '0');
    const limVal = limiteHE.rows[0]?.limite_mensal ? parseFloat(limiteHE.rows[0].limite_mensal) : null;
    const heTotal = parseFloat(horasExtrasMes.rows[0]?.total || '0');

    metricas.push({
      empresaId: eid,
      nomeFantasia: empresa.nome_fantasia,
      totalColaboradores: total,
      presentesHoje: presentes,
      ausentesHoje: total - presentes,
      atrasadosHoje: parseInt(atrasadosHoje.rows[0]?.atrasados || '0'),
      horasExtrasMes: heTotal,
      limiteHorasExtras: limVal,
      percentualLimiteHE: limVal ? Math.round((heTotal / limVal) * 100) : null,
      solicitacoesPendentes: parseInt(pendentes.rows[0]?.total || '0'),
      tendenciaAusencias7d: tendencia7d.rows.map((r: Record<string, string>) => parseInt(r.ausentes || '0')),
      departamentoMaisAusencias: deptAusencias.rows[0] ? { nome: deptAusencias.rows[0].nome, ausentes: parseInt(deptAusencias.rows[0].ausentes) } : null,
    });
  }
  return metricas;
}

function gerarAlertasRegras(metricas: MetricasEmpresa[]): AlertaGerado[] {
  const alertas: AlertaGerado[] = [];
  for (const m of metricas) {
    if (m.totalColaboradores === 0) continue;
    const pctAus = Math.round((m.ausentesHoje / m.totalColaboradores) * 100);

    if (m.ausentesHoje >= 50) {
      alertas.push({ empresaId: m.empresaId, categoria: 'ausencia', severidade: 'critico', titulo: m.nomeFantasia + ': ' + m.ausentesHoje + ' colaboradores ausentes hoje!', mensagem: 'A empresa ' + m.nomeFantasia + ' tem ' + m.ausentesHoje + ' colaboradores ausentes hoje (' + pctAus + '% do total). Pode impactar as operacoes.', dados: { ausentesHoje: m.ausentesHoje, total: m.totalColaboradores, pct: pctAus }, origem: 'regra' });
    } else if (pctAus >= 30) {
      alertas.push({ empresaId: m.empresaId, categoria: 'ausencia', severidade: 'atencao', titulo: m.nomeFantasia + ': ' + pctAus + '% de ausencia hoje', mensagem: m.ausentesHoje + ' de ' + m.totalColaboradores + ' colaboradores ausentes em ' + m.nomeFantasia + '.', dados: { ausentesHoje: m.ausentesHoje, total: m.totalColaboradores, pct: pctAus }, origem: 'regra' });
    }

    if (m.atrasadosHoje >= 5) {
      alertas.push({ empresaId: m.empresaId, categoria: 'atraso', severidade: m.atrasadosHoje >= 20 ? 'critico' : 'atencao', titulo: m.nomeFantasia + ': ' + m.atrasadosHoje + ' pessoas se atrasaram hoje', mensagem: 'Registrados ' + m.atrasadosHoje + ' atrasos em ' + m.nomeFantasia + ' hoje.' + (m.atrasadosHoje >= 20 ? ' Numero muito acima do normal!' : ' Recomenda-se investigar.'), dados: { atrasadosHoje: m.atrasadosHoje }, origem: 'regra' });
    }

    if (m.percentualLimiteHE !== null && m.limiteHorasExtras !== null) {
      if (m.percentualLimiteHE >= 100) {
        alertas.push({ empresaId: m.empresaId, categoria: 'hora_extra', severidade: 'critico', titulo: m.nomeFantasia + ': Limite de hora extra ATINGIDO!', mensagem: m.nomeFantasia + ' atingiu ' + m.percentualLimiteHE + '% do limite mensal de HE (' + m.horasExtrasMes.toFixed(1) + 'h de ' + m.limiteHorasExtras + 'h). Evitar novas HE.', dados: { he: m.horasExtrasMes, limite: m.limiteHorasExtras, pct: m.percentualLimiteHE }, origem: 'regra' });
      } else if (m.percentualLimiteHE >= 80) {
        alertas.push({ empresaId: m.empresaId, categoria: 'hora_extra', severidade: 'atencao', titulo: m.nomeFantasia + ': ' + m.percentualLimiteHE + '% do limite de hora extra', mensagem: m.nomeFantasia + ' consumiu ' + m.percentualLimiteHE + '% do limite mensal de HE (' + m.horasExtrasMes.toFixed(1) + 'h de ' + m.limiteHorasExtras + 'h).', dados: { he: m.horasExtrasMes, limite: m.limiteHorasExtras, pct: m.percentualLimiteHE }, origem: 'regra' });
      }
    }

    if (m.solicitacoesPendentes >= 20) {
      alertas.push({ empresaId: m.empresaId, categoria: 'geral', severidade: m.solicitacoesPendentes >= 50 ? 'critico' : 'atencao', titulo: m.nomeFantasia + ': ' + m.solicitacoesPendentes + ' solicitacoes pendentes', mensagem: m.solicitacoesPendentes + ' solicitacoes aguardam aprovacao em ' + m.nomeFantasia + '.', dados: { pendentes: m.solicitacoesPendentes }, origem: 'regra' });
    }

    if (m.departamentoMaisAusencias && m.departamentoMaisAusencias.ausentes >= 10) {
      alertas.push({ empresaId: m.empresaId, categoria: 'ausencia', severidade: 'atencao', titulo: m.nomeFantasia + ': Dept "' + m.departamentoMaisAusencias.nome + '" com ' + m.departamentoMaisAusencias.ausentes + ' ausencias', mensagem: 'O departamento ' + m.departamentoMaisAusencias.nome + ' concentra ' + m.departamentoMaisAusencias.ausentes + ' ausencias hoje.', dados: { dept: m.departamentoMaisAusencias.nome, ausentes: m.departamentoMaisAusencias.ausentes }, origem: 'regra' });
    }
  }
  return alertas;
}

async function analisarComGemini(metricas: MetricasEmpresa[]): Promise<AlertaGerado[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[AI Analytics] GEMINI_API_KEY nao configurada');
    return [];
  }

  const resumo = metricas.map(m => ({
    empresa: m.nomeFantasia, colaboradores: m.totalColaboradores, presentes: m.presentesHoje,
    ausentes: m.ausentesHoje, atrasados: m.atrasadosHoje, hesMes: m.horasExtrasMes,
    limiteHE: m.limiteHorasExtras, pctHE: m.percentualLimiteHE,
    pendencias: m.solicitacoesPendentes, ausencias7d: m.tendenciaAusencias7d,
  }));

  const prompt = 'Voce e analista de RH. Analise dados de ponto e gere insights acionaveis.\n\nDADOS:\n' + JSON.stringify(resumo, null, 2) + '\n\nREGRAS:\n1. Identifique TENDENCIAS nos 7 dias de ausencias\n2. Detecte ANOMALIAS\n3. De RECOMENDACOES praticas\n4. NAO repita alertas obvios (limites/ausencias ja cobertos)\n5. Foque em padroes nao obvios\n\nResponda APENAS JSON array:\n[{"empresa":"nome|null","categoria":"tendencia|anomalia|recomendacao","severidade":"info|atencao|critico","titulo":"max 100 chars","mensagem":"max 500 chars"}]\n\nSe nao houver insights, retorne [].';

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        }),
      }
    );

    if (!resp.ok) {
      console.error('[AI Analytics] Gemini erro:', resp.status, await resp.text());
      return [];
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return [];

    const insights: Array<{ empresa: string | null; categoria: string; severidade: 'info' | 'atencao' | 'critico'; titulo: string; mensagem: string }> = JSON.parse(text);
    if (!Array.isArray(insights)) return [];

    return insights.map(i => ({
      empresaId: metricas.find(m => m.nomeFantasia === i.empresa)?.empresaId ?? null,
      categoria: i.categoria || 'geral',
      severidade: i.severidade || 'info',
      titulo: (i.titulo || '').slice(0, 500),
      mensagem: (i.mensagem || '').slice(0, 2000),
      dados: { fonte: 'gemini', empresa: i.empresa },
      origem: 'ia' as const,
    }));
  } catch (error) {
    console.error('[AI Analytics] Erro Gemini:', error);
    return [];
  }
}

async function persistirAlertas(alertas: AlertaGerado[]): Promise<number[]> {
  const ids: number[] = [];
  for (const a of alertas) {
    try {
      const r = await query(
        'INSERT INTO bluepoint.bt_alertas_inteligentes (empresa_id, categoria, severidade, titulo, mensagem, dados, origem) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [a.empresaId, a.categoria, a.severidade, a.titulo, a.mensagem, JSON.stringify(a.dados), a.origem]
      );
      if (r.rows[0]) ids.push(r.rows[0].id);
    } catch (e) {
      console.error('[AI Analytics] Erro persistir:', e);
    }
  }
  return ids;
}

async function notificarAdmins(alertas: AlertaGerado[]): Promise<void> {
  if (alertas.length === 0) return;
  const admins = await query('SELECT id, email, nome FROM bluepoint.bt_colaboradores WHERE tipo = \'admin\' AND status = \'ativo\'');
  const criticos = alertas.filter(a => a.severidade === 'critico');
  const atencao = alertas.filter(a => a.severidade === 'atencao');
  const info = alertas.filter(a => a.severidade === 'info');

  for (const admin of admins.rows) {
    const partes = [
      criticos.length > 0 ? criticos.length + ' critico(s)' : '',
      atencao.length > 0 ? atencao.length + ' de atencao' : '',
      info.length > 0 ? info.length + ' informativo(s)' : '',
    ].filter(Boolean);

    await criarNotificacao({
      usuarioId: admin.id, tipo: 'alerta',
      titulo: 'Analise Inteligente: ' + alertas.length + ' alerta(s)',
      mensagem: partes.join(', '), link: '/alertas-inteligentes',
      metadados: { total: alertas.length, criticos: criticos.length },
    });

    if (criticos.length > 0 && admin.email) {
      const listaCrit = criticos.map(a => '<li style="margin-bottom:12px"><strong style="color:#dc2626">[CRITICO]</strong> ' + a.titulo + '<br><span style="color:#6b7280">' + a.mensagem + '</span></li>').join('');
      const listaAtc = atencao.length > 0 ? '<h3 style="color:#f59e0b;border-bottom:2px solid #f59e0b;padding-bottom:8px">Alertas de Atencao</h3><ul style="padding-left:20px">' + atencao.map(a => '<li style="margin-bottom:12px"><strong style="color:#f59e0b">[ATENCAO]</strong> ' + a.titulo + '<br><span style="color:#6b7280">' + a.mensagem + '</span></li>').join('') + '</ul>' : '';
      const base = process.env.BASE_URL || 'http://localhost:3000';

      await sendEmail({
        to: admin.email,
        subject: 'BluePoint - ' + criticos.length + ' Alerta(s) Critico(s)',
        html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;color:#333;line-height:1.6"><div style="max-width:650px;margin:0 auto;padding:20px"><div style="background:#1e40af;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0"><h1 style="margin:0">BluePoint - Alertas Inteligentes</h1></div><div style="background:#f9fafb;padding:30px;border-radius:0 0 8px 8px"><h2 style="color:#1e40af">Ola, ' + admin.nome + '!</h2><p>Detectamos <strong>' + alertas.length + ' alerta(s)</strong>, sendo <strong style="color:#dc2626">' + criticos.length + ' critico(s)</strong>.</p><h3 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Alertas Criticos</h3><ul style="padding-left:20px">' + listaCrit + '</ul>' + listaAtc + '<p style="text-align:center;margin-top:30px"><a href="' + base + '/alertas-inteligentes" style="display:inline-block;background:#1e40af;color:white;padding:12px 30px;text-decoration:none;border-radius:6px">Ver Alertas</a></p></div><div style="text-align:center;margin-top:20px;font-size:12px;color:#6b7280"><p>BluePoint - IA Analytics</p></div></div></body></html>',
      });
    }
  }
}

export async function executarAnaliseInteligente(): Promise<AnaliseResultado> {
  console.log('[AI Analytics] Iniciando...');
  const inicio = Date.now();
  const metricas = await coletarMetricasPorEmpresa();
  const alertasRegras = gerarAlertasRegras(metricas);
  const alertasIA = await analisarComGemini(metricas);
  const todos = [...alertasRegras, ...alertasIA];

  if (todos.length > 0) {
    await persistirAlertas(todos);
    await notificarAdmins(todos);
  }

  console.log('[AI Analytics] Concluido em ' + (Date.now() - inicio) + 'ms - ' + todos.length + ' alerta(s)');
  return { alertas: todos, metricas, analisadoEm: new Date().toISOString(), iaDisponivel: !!process.env.GEMINI_API_KEY };
}

export async function listarAlertasInteligentes(params: {
  empresaId?: number; categoria?: string; severidade?: string;
  apenasNaoLidos?: boolean; limite?: number; offset?: number;
}): Promise<{ alertas: unknown[]; total: number }> {
  const conds: string[] = ['ai.arquivado = FALSE'];
  const vals: unknown[] = [];
  let idx = 1;
  if (params.empresaId) { conds.push('ai.empresa_id = $' + idx++); vals.push(params.empresaId); }
  if (params.categoria) { conds.push('ai.categoria = $' + idx++); vals.push(params.categoria); }
  if (params.severidade) { conds.push('ai.severidade = $' + idx++); vals.push(params.severidade); }
  if (params.apenasNaoLidos) { conds.push('ai.lido = FALSE'); }

  const where = 'WHERE ' + conds.join(' AND ');
  const lim = Math.min(params.limite || 50, 100);
  const off = params.offset || 0;
  const limIdx = idx++;
  const offIdx = idx;

  const [res, cnt] = await Promise.all([
    query('SELECT ai.*, e.nome_fantasia as empresa_nome FROM bluepoint.bt_alertas_inteligentes ai LEFT JOIN bluepoint.bt_empresas e ON ai.empresa_id = e.id ' + where + ' ORDER BY ai.criado_em DESC LIMIT $' + limIdx + ' OFFSET $' + offIdx, [...vals, lim, off]),
    query('SELECT COUNT(*) as total FROM bluepoint.bt_alertas_inteligentes ai ' + where, vals),
  ]);

  return {
    alertas: res.rows.map(r => ({ id: r.id, empresaId: r.empresa_id, empresaNome: r.empresa_nome, categoria: r.categoria, severidade: r.severidade, titulo: r.titulo, mensagem: r.mensagem, dados: r.dados, origem: r.origem, lido: r.lido, criadoEm: r.criado_em })),
    total: parseInt(cnt.rows[0]?.total || '0'),
  };
}

export async function marcarAlertaLido(id: number): Promise<boolean> {
  const r = await query('UPDATE bluepoint.bt_alertas_inteligentes SET lido = TRUE WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function arquivarAlerta(id: number): Promise<boolean> {
  const r = await query('UPDATE bluepoint.bt_alertas_inteligentes SET arquivado = TRUE WHERE id = $1', [id]);
  return (r.rowCount ?? 0) > 0;
}
