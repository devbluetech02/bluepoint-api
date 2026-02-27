import { query } from '@/lib/db';
import { criarNotificacao } from '@/lib/notificacoes';
import { sendEmail } from '@/lib/email';
import { cacheGet, cacheSet } from '@/lib/cache';
import { PUSH_VISUAL, buildPushPayload, sendPush } from '@/lib/push-onesignal';

const INTERVALO_MS = 30 * 60 * 1000; // 30 minutos
const ALERTA_TTL = 86400; // 24h - evita duplicata no mesmo dia
const GEMINI_COOLDOWN = 14400; // 4h entre analises de IA

let timerRef: ReturnType<typeof setInterval> | null = null;

function alertaKey(tipo: string, empresaId: number): string {
  const dia = new Date().toISOString().split('T')[0];
  return 'alerta_periodico:' + tipo + ':' + empresaId + ':' + dia;
}

async function jaEnviou(key: string): Promise<boolean> {
  return (await cacheGet<boolean>(key)) === true;
}

async function marcarEnviado(key: string): Promise<void> {
  await cacheSet(key, true, ALERTA_TTL);
}

interface Alerta {
  empresaId: number;
  categoria: string;
  severidade: 'info' | 'atencao' | 'critico';
  titulo: string;
  mensagem: string;
  dados: Record<string, unknown>;
  origem: 'regra' | 'ia';
  notificar: boolean;
}

async function salvarAlerta(a: Alerta): Promise<void> {
  await query(
    'INSERT INTO bluepoint.bt_alertas_inteligentes (empresa_id,categoria,severidade,titulo,mensagem,dados,origem) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [a.empresaId, a.categoria, a.severidade, a.titulo, a.mensagem, JSON.stringify(a.dados), a.origem]
  );
}

async function enviarPushOneSignal(alertas: Alerta[], adminIds: string[]): Promise<void> {
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey || adminIds.length === 0) return;

  for (const alerta of alertas) {
    const visual = PUSH_VISUAL[alerta.severidade] || PUSH_VISUAL.info;

    try {
      const payload = buildPushPayload({
        appId,
        headingText: alerta.titulo,
        contentText: alerta.mensagem,
        visual,
        data: {
          tipo: 'alerta_inteligente',
          categoria: alerta.categoria,
          severidade: alerta.severidade,
          empresaId: alerta.empresaId,
        },
      });
      payload.include_aliases = { external_id: adminIds };

      const result = await sendPush(apiKey, payload);
      if (!result.ok) {
        console.error('[OneSignal] Erro ' + result.status + ':', JSON.stringify(result.body));
      } else {
        console.log('[OneSignal] Push [' + alerta.severidade.toUpperCase() + '] enviado: ' + alerta.titulo.slice(0, 50));
      }
    } catch (error) {
      console.error('[OneSignal] Falha ao enviar push:', error);
    }
  }
}

async function notificarAdmins(alertas: Alerta[]): Promise<void> {
  const paraNotificar = alertas.filter(a => a.notificar);
  if (paraNotificar.length === 0) return;

  const admins = await query(
    "SELECT id, email, nome FROM bluepoint.bt_colaboradores WHERE tipo = 'admin' AND status = 'ativo'"
  );

  const criticos = paraNotificar.filter(a => a.severidade === 'critico');
  const atencao = paraNotificar.filter(a => a.severidade === 'atencao');
  const adminIds = admins.rows.map((a) => String(a.id));

  // Push notifications via OneSignal (todos que devem notificar)
  enviarPushOneSignal(paraNotificar, adminIds).catch(e =>
    console.error('[Alertas Periodicos] Erro OneSignal:', e)
  );

  for (const admin of admins.rows) {
    const partes = [
      criticos.length > 0 ? criticos.length + ' critico(s)' : '',
      atencao.length > 0 ? atencao.length + ' de atencao' : '',
    ].filter(Boolean);

    await criarNotificacao({
      usuarioId: admin.id,
      tipo: 'alerta',
      titulo: 'Alertas Inteligentes: ' + paraNotificar.length + ' novo(s)',
      mensagem: partes.join(', ') + '. Acesse o painel para detalhes.',
      link: '/alertas-inteligentes',
      metadados: { total: paraNotificar.length, criticos: criticos.length },
    });

    if (criticos.length > 0 && admin.email) {
      const lista = criticos.map(a =>
        '<li style="margin-bottom:12px"><strong style="color:#dc2626">[CRITICO]</strong> ' +
        a.titulo + '<br><span style="color:#6b7280">' + a.mensagem + '</span></li>'
      ).join('');
      const base = process.env.BASE_URL || 'http://localhost:3000';

      await sendEmail({
        to: admin.email,
        subject: 'BluePoint ALERTA: ' + criticos.length + ' critico(s)',
        html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;color:#333;line-height:1.6"><div style="max-width:600px;margin:0 auto;padding:20px"><div style="background:#dc2626;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0"><h2 style="margin:0">Alertas Criticos</h2></div><div style="background:#f9fafb;padding:30px;border-radius:0 0 8px 8px"><p>Ola, ' + admin.nome + '!</p><ul style="padding-left:20px">' + lista + '</ul><p style="text-align:center;margin-top:20px"><a href="' + base + '/alertas-inteligentes" style="display:inline-block;background:#1e40af;color:white;padding:12px 30px;text-decoration:none;border-radius:6px">Ver Detalhes</a></p></div></div></body></html>',
      });
    }
  }
}

async function analisarEmpresas(): Promise<Alerta[]> {
  const empresas = await query('SELECT id, nome_fantasia FROM bluepoint.bt_empresas ORDER BY nome_fantasia');
  const alertas: Alerta[] = [];

  for (const emp of empresas.rows) {
    const eid = emp.id;
    const nome = emp.nome_fantasia;

    const [totRes, presRes, atrasoRes, heRes, limRes, pendRes] = await Promise.all([
      query("SELECT COUNT(*) as t FROM bluepoint.bt_colaboradores WHERE empresa_id = $1 AND status = 'ativo'", [eid]),
      query('SELECT COUNT(DISTINCT m.colaborador_id) as t FROM bluepoint.bt_marcacoes m JOIN bluepoint.bt_colaboradores c ON m.colaborador_id = c.id WHERE c.empresa_id = $1 AND DATE(m.data_hora) = CURRENT_DATE', [eid]),
      query("SELECT COUNT(DISTINCT s.colaborador_id) as t FROM bluepoint.bt_solicitacoes s JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.tipo = 'atraso' AND DATE(s.data_evento) = CURRENT_DATE", [eid]),
      query('SELECT COALESCE(SUM(CASE WHEN bh.horas > 0 THEN bh.horas ELSE 0 END), 0) as t FROM bluepoint.bt_banco_horas bh JOIN bluepoint.bt_colaboradores c ON bh.colaborador_id = c.id WHERE c.empresa_id = $1 AND EXTRACT(MONTH FROM bh.data) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM bh.data) = EXTRACT(YEAR FROM CURRENT_DATE)', [eid]),
      query('SELECT limite_mensal FROM bluepoint.bt_limites_he_empresas WHERE empresa_id = $1', [eid]),
      query("SELECT COUNT(*) as t FROM bluepoint.bt_solicitacoes s JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.status = 'pendente'", [eid]),
    ]);

    const total = parseInt(totRes.rows[0]?.t || '0');
    if (total === 0) continue;
    const presentes = parseInt(presRes.rows[0]?.t || '0');
    const ausentes = total - presentes;
    const pctAus = Math.round((ausentes / total) * 100);
    const atrasados = parseInt(atrasoRes.rows[0]?.t || '0');
    const heMes = parseFloat(heRes.rows[0]?.t || '0');
    const limiteHE = limRes.rows[0]?.limite_mensal ? parseFloat(limRes.rows[0].limite_mensal) : null;
    const pctHE = limiteHE ? Math.round((heMes / limiteHE) * 100) : null;
    const pendentes = parseInt(pendRes.rows[0]?.t || '0');

    // --- AUSENCIAS ---
    if (ausentes >= 50 && !(await jaEnviou(alertaKey('aus50', eid)))) {
      await marcarEnviado(alertaKey('aus50', eid));
      alertas.push({ empresaId: eid, categoria: 'ausencia', severidade: 'critico', titulo: nome + ': ' + ausentes + ' colaboradores ausentes!', mensagem: ausentes + ' de ' + total + ' ausentes (' + pctAus + '%). Impacto operacional provavel.', dados: { ausentes, total, pctAus }, origem: 'regra', notificar: true });
    } else if (pctAus >= 30 && !(await jaEnviou(alertaKey('aus30', eid)))) {
      await marcarEnviado(alertaKey('aus30', eid));
      alertas.push({ empresaId: eid, categoria: 'ausencia', severidade: 'atencao', titulo: nome + ': ' + pctAus + '% de ausencia (' + ausentes + ')', mensagem: ausentes + ' de ' + total + ' ausentes em ' + nome + '.', dados: { ausentes, total, pctAus }, origem: 'regra', notificar: false });
    }

    // --- ATRASOS ---
    if (atrasados >= 20 && !(await jaEnviou(alertaKey('atr20', eid)))) {
      await marcarEnviado(alertaKey('atr20', eid));
      alertas.push({ empresaId: eid, categoria: 'atraso', severidade: 'critico', titulo: nome + ': ' + atrasados + ' atrasados hoje!', mensagem: 'Numero muito acima do normal em ' + nome + '.', dados: { atrasados }, origem: 'regra', notificar: true });
    } else if (atrasados >= 5 && !(await jaEnviou(alertaKey('atr5', eid)))) {
      await marcarEnviado(alertaKey('atr5', eid));
      alertas.push({ empresaId: eid, categoria: 'atraso', severidade: 'atencao', titulo: nome + ': ' + atrasados + ' atrasados hoje', mensagem: atrasados + ' atrasos registrados em ' + nome + '.', dados: { atrasados }, origem: 'regra', notificar: false });
    }

    // --- HORA EXTRA ---
    if (pctHE !== null && limiteHE !== null) {
      if (pctHE >= 100 && !(await jaEnviou(alertaKey('he100', eid)))) {
        await marcarEnviado(alertaKey('he100', eid));
        alertas.push({ empresaId: eid, categoria: 'hora_extra', severidade: 'critico', titulo: nome + ': Limite de HE atingido!', mensagem: pctHE + '% do limite (' + heMes.toFixed(1) + 'h de ' + limiteHE + 'h).', dados: { heMes, limiteHE, pctHE }, origem: 'regra', notificar: true });
      } else if (pctHE >= 80 && !(await jaEnviou(alertaKey('he80', eid)))) {
        await marcarEnviado(alertaKey('he80', eid));
        alertas.push({ empresaId: eid, categoria: 'hora_extra', severidade: 'atencao', titulo: nome + ': ' + pctHE + '% do limite de HE', mensagem: heMes.toFixed(1) + 'h de ' + limiteHE + 'h consumidos.', dados: { heMes, limiteHE, pctHE }, origem: 'regra', notificar: false });
      }
    }

    // --- SOLICITACOES PENDENTES ---
    if (pendentes >= 50 && !(await jaEnviou(alertaKey('pend50', eid)))) {
      await marcarEnviado(alertaKey('pend50', eid));
      alertas.push({ empresaId: eid, categoria: 'geral', severidade: 'critico', titulo: nome + ': ' + pendentes + ' solicitacoes pendentes!', mensagem: 'Acumulo critico em ' + nome + '.', dados: { pendentes }, origem: 'regra', notificar: true });
    } else if (pendentes >= 20 && !(await jaEnviou(alertaKey('pend20', eid)))) {
      await marcarEnviado(alertaKey('pend20', eid));
      alertas.push({ empresaId: eid, categoria: 'geral', severidade: 'atencao', titulo: nome + ': ' + pendentes + ' pendentes', mensagem: pendentes + ' solicitacoes aguardam aprovacao.', dados: { pendentes }, origem: 'regra', notificar: false });
    }
  }

  return alertas;
}

async function analisarComGemini(): Promise<Alerta[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  const cooldownKey = 'alerta_periodico:ia_global';
  if (await jaEnviou(cooldownKey)) return [];
  await cacheSet(cooldownKey, true, GEMINI_COOLDOWN);

  try {
    const empresas = await query('SELECT id, nome_fantasia FROM bluepoint.bt_empresas');
    const resumos = [];

    for (const emp of empresas.rows) {
      const [t, p, a, he, pend] = await Promise.all([
        query("SELECT COUNT(*) as t FROM bluepoint.bt_colaboradores WHERE empresa_id = $1 AND status = 'ativo'", [emp.id]),
        query('SELECT COUNT(DISTINCT m.colaborador_id) as t FROM bluepoint.bt_marcacoes m JOIN bluepoint.bt_colaboradores c ON m.colaborador_id = c.id WHERE c.empresa_id = $1 AND DATE(m.data_hora) = CURRENT_DATE', [emp.id]),
        query("SELECT COUNT(DISTINCT s.colaborador_id) as t FROM bluepoint.bt_solicitacoes s JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.tipo = 'atraso' AND DATE(s.data_evento) = CURRENT_DATE", [emp.id]),
        query('SELECT COALESCE(SUM(CASE WHEN bh.horas > 0 THEN bh.horas ELSE 0 END), 0) as t FROM bluepoint.bt_banco_horas bh JOIN bluepoint.bt_colaboradores c ON bh.colaborador_id = c.id WHERE c.empresa_id = $1 AND EXTRACT(MONTH FROM bh.data) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM bh.data) = EXTRACT(YEAR FROM CURRENT_DATE)', [emp.id]),
        query("SELECT COUNT(*) as t FROM bluepoint.bt_solicitacoes s JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.status = 'pendente'", [emp.id]),
      ]);
      const tot = parseInt(t.rows[0].t);
      if (tot === 0) continue;
      resumos.push({ empresa: emp.nome_fantasia, colab: tot, presentes: parseInt(p.rows[0].t), ausentes: tot - parseInt(p.rows[0].t), atrasados: parseInt(a.rows[0].t), heMes: parseFloat(he.rows[0].t), pendencias: parseInt(pend.rows[0].t) });
    }

    if (resumos.length === 0) return [];

    const prompt = 'Analise de RH. Dados de hoje:\n' + JSON.stringify(resumos, null, 2) + '\n\nIdentifique tendencias ou anomalias. Responda JSON array: [{"empresa":"nome|null","categoria":"tendencia|anomalia|recomendacao","severidade":"info|atencao|critico","titulo":"max 80","mensagem":"max 300"}]. Se nada, retorne [].';

    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024, responseMimeType: 'application/json' },
        }),
      }
    );

    if (!resp.ok) return [];
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return [];

    const insights: Array<{ empresa: string | null; categoria: string; severidade: 'info' | 'atencao' | 'critico'; titulo: string; mensagem: string }> = JSON.parse(text);
    if (!Array.isArray(insights)) return [];

    const empresasMap = await query('SELECT id, nome_fantasia FROM bluepoint.bt_empresas');
    return insights.map(i => ({
      empresaId: empresasMap.rows.find((e) => (e as Record<string, unknown>).nome_fantasia === i.empresa)?.id ?? null,
      categoria: i.categoria || 'geral',
      severidade: i.severidade || 'info',
      titulo: (i.titulo || '').slice(0, 500),
      mensagem: (i.mensagem || '').slice(0, 2000),
      dados: { fonte: 'gemini' },
      origem: 'ia' as const,
      notificar: i.severidade === 'critico',
    }));
  } catch (error) {
    console.error('[Alertas Periodicos] Erro Gemini:', error);
    return [];
  }
}

async function executarCiclo(): Promise<void> {
  try {
    console.log('[Alertas Periodicos] Executando ciclo...');
    const inicio = Date.now();

    const alertasRegras = await analisarEmpresas();
    const alertasIA = await analisarComGemini();
    const todos = [...alertasRegras, ...alertasIA];

    for (const a of todos) {
      await salvarAlerta(a);
    }

    await notificarAdmins(todos);

    const duracao = Date.now() - inicio;
    const criticos = todos.filter(a => a.severidade === 'critico').length;
    console.log('[Alertas Periodicos] ' + todos.length + ' alerta(s) (' + criticos + ' critico(s)) em ' + duracao + 'ms');
  } catch (error) {
    console.error('[Alertas Periodicos] Erro no ciclo:', error);
  }
}

export function iniciarAlertasPeriodicos(): void {
  if (timerRef) return;

  console.log('[Alertas Periodicos] Iniciando - intervalo de ' + (INTERVALO_MS / 60000) + ' minutos');

  // Primeiro ciclo apos 2 minutos (dar tempo do servidor subir)
  setTimeout(() => {
    executarCiclo();
    timerRef = setInterval(executarCiclo, INTERVALO_MS);
  }, 2 * 60 * 1000);
}

export function pararAlertasPeriodicos(): void {
  if (timerRef) {
    clearInterval(timerRef);
    timerRef = null;
    console.log('[Alertas Periodicos] Parado');
  }
}

export { executarCiclo as executarAnaliseManual };
