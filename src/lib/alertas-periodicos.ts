import { query } from '@/lib/db';
import { criarNotificacao } from '@/lib/notificacoes';
import { enviarPushParaColaboradores } from '@/lib/push-colaborador';
import { enviarPushParaProvisorio } from '@/lib/push-provisorio';
import { sendEmail } from '@/lib/email';
import { cacheGet, cacheSet } from '@/lib/cache';
import { PUSH_VISUAL, buildPushPayload, sendPush } from '@/lib/push-onesignal';

const INTERVALO_MS = 30 * 60 * 1000; // 30 minutos
const ALERTA_TTL = 86400; // 24h - evita duplicata no mesmo dia
const GEMINI_COOLDOWN = 14400; // 4h entre analises de IA
const LEMBRETE_TTL = 7 * 24 * 3600; // 7 dias — lembretes one-shot por intervalo

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

function formatarDataBr(iso: string): string {
  const d = String(iso).split('T')[0];
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function formatarHoraSP(ts: Date | string): string {
  return new Date(ts).toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
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
    'INSERT INTO people.alertas_inteligentes (empresa_id,categoria,severidade,titulo,mensagem,dados,origem) VALUES ($1,$2,$3,$4,$5,$6,$7)',
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
    "SELECT id, email, nome FROM people.colaboradores WHERE tipo = 'admin' AND status = 'ativo'"
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
  const empresas = await query('SELECT id, nome_fantasia FROM people.empresas ORDER BY nome_fantasia');
  const alertas: Alerta[] = [];

  for (const emp of empresas.rows) {
    const eid = emp.id;
    const nome = emp.nome_fantasia;

    const [totRes, presRes, atrasoRes, heRes, limRes, pendRes] = await Promise.all([
      query("SELECT COUNT(*) as t FROM people.colaboradores WHERE empresa_id = $1 AND status = 'ativo'", [eid]),
      query('SELECT COUNT(DISTINCT m.colaborador_id) as t FROM people.marcacoes m JOIN people.colaboradores c ON m.colaborador_id = c.id WHERE c.empresa_id = $1 AND DATE(m.data_hora) = CURRENT_DATE', [eid]),
      query("SELECT COUNT(DISTINCT s.colaborador_id) as t FROM people.solicitacoes s JOIN people.colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.tipo = 'atraso' AND DATE(s.data_evento) = CURRENT_DATE", [eid]),
      query('SELECT COALESCE(SUM(CASE WHEN bh.horas > 0 THEN bh.horas ELSE 0 END), 0) as t FROM people.banco_horas bh JOIN people.colaboradores c ON bh.colaborador_id = c.id WHERE c.empresa_id = $1 AND EXTRACT(MONTH FROM bh.data) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM bh.data) = EXTRACT(YEAR FROM CURRENT_DATE)', [eid]),
      query('SELECT limite_mensal FROM people.limites_he_empresas WHERE empresa_id = $1', [eid]),
      query("SELECT COUNT(*) as t FROM people.solicitacoes s JOIN people.colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.status = 'pendente'", [eid]),
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
    const empresas = await query('SELECT id, nome_fantasia FROM people.empresas');
    const resumos = [];

    for (const emp of empresas.rows) {
      const [t, p, a, he, pend] = await Promise.all([
        query("SELECT COUNT(*) as t FROM people.colaboradores WHERE empresa_id = $1 AND status = 'ativo'", [emp.id]),
        query('SELECT COUNT(DISTINCT m.colaborador_id) as t FROM people.marcacoes m JOIN people.colaboradores c ON m.colaborador_id = c.id WHERE c.empresa_id = $1 AND DATE(m.data_hora) = CURRENT_DATE', [emp.id]),
        query("SELECT COUNT(DISTINCT s.colaborador_id) as t FROM people.solicitacoes s JOIN people.colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.tipo = 'atraso' AND DATE(s.data_evento) = CURRENT_DATE", [emp.id]),
        query('SELECT COALESCE(SUM(CASE WHEN bh.horas > 0 THEN bh.horas ELSE 0 END), 0) as t FROM people.banco_horas bh JOIN people.colaboradores c ON bh.colaborador_id = c.id WHERE c.empresa_id = $1 AND EXTRACT(MONTH FROM bh.data) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM bh.data) = EXTRACT(YEAR FROM CURRENT_DATE)', [emp.id]),
        query("SELECT COUNT(*) as t FROM people.solicitacoes s JOIN people.colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.status = 'pendente'", [emp.id]),
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

    const empresasMap = await query('SELECT id, nome_fantasia FROM people.empresas');
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

// =====================================================
// LEMBRETES DE PRÉ-ADMISSÃO PARADA
// - correcao_solicitada: lembra o candidato após 12h, depois a cada 24h
// - aguardando_rh:       lembra os gestores/admins após 24h, depois a cada 24h
// Cache key inclui a data do lembrete para evitar múltiplos envios no mesmo dia.
// =====================================================

async function lembrarPreAdmissoesParadas(): Promise<void> {
  try {
    // Busca pré-admissões paradas há mais de 12h (correcao) ou 24h (aguardando_rh)
    const result = await query<{
      id: string;
      status: string;
      usuario_provisorio_id: number | null;
      onesignal_subscription_id: string | null;
      horas_parada: number;
    }>(`
      SELECT
        id,
        status,
        usuario_provisorio_id,
        onesignal_subscription_id,
        EXTRACT(EPOCH FROM (NOW() - atualizado_em)) / 3600 AS horas_parada
      FROM people.solicitacoes_admissao
      WHERE status IN ('correcao_solicitada', 'aguardando_rh')
        AND (
          (status = 'correcao_solicitada' AND atualizado_em < NOW() - INTERVAL '3 hours')
          OR
          (status = 'aguardando_rh'       AND atualizado_em < NOW() - INTERVAL '24 hours')
        )
    `);

    if (result.rows.length === 0) return;

    // Janela de 3h para correcao_solicitada, 24h para aguardando_rh
    // Cache key inclui o slot de tempo para controlar a frequência correta
    const slotCorrecao = Math.floor(Date.now() / (3 * 60 * 60 * 1000));   // muda a cada 3h
    const hoje = new Date().toISOString().split('T')[0];                    // muda a cada 24h

    // Carrega admins/gestores uma única vez
    const adminsResult = await query<{ id: number }>(
      `SELECT id FROM people.colaboradores WHERE tipo IN ('admin', 'gestor') AND status = 'ativo'`
    );
    const adminIds = adminsResult.rows.map(r => r.id);

    for (const sol of result.rows) {
      const slot = sol.status === 'correcao_solicitada' ? slotCorrecao : hoje;
      const cacheKey = `lembrete_admissao:${sol.id}:${slot}`;
      if (await jaEnviou(cacheKey)) continue;
      const ttlLembrete = sol.status === 'correcao_solicitada' ? 3 * 3600 : ALERTA_TTL;
      await cacheSet(cacheKey, true, ttlLembrete);

      const horas = Math.round(sol.horas_parada);

      if (sol.status === 'correcao_solicitada' && sol.usuario_provisorio_id) {
        // Notifica o candidato para corrigir e reenviar
        criarNotificacao({
          usuarioId: sol.usuario_provisorio_id,
          tipo: 'lembrete',
          titulo: 'Formulário aguardando correção',
          mensagem: `Seu formulário de pré-admissão tem correções solicitadas há ${horas}h. Acesse o app para revisar e reenviar.`,
          link: '/pre-admissao',
          metadados: { acao: 'lembrete_correcao', solicitacaoId: sol.id, horasParada: horas },
        }).catch(err => console.error('[Alertas Periodicos] Erro ao criar notificação pré-admissão:', err));

        enviarPushParaProvisorio(
          sol.usuario_provisorio_id,
          {
            titulo: 'Formulário aguardando correção',
            mensagem: `Seu formulário tem correções há ${horas}h. Toque para revisar e reenviar.`,
            severidade: horas >= 48 ? 'critico' : 'atencao',
            data: { tipo: 'lembrete_correcao_admissao', solicitacaoId: sol.id },
            url: '/pre-admissao',
          },
          sol.onesignal_subscription_id,
        ).catch(err => console.error('[Alertas Periodicos] Erro ao enviar push pré-admissão:', err));

      }

      if (sol.status === 'aguardando_rh' && adminIds.length > 0) {
        // Notifica gestores/admins para revisar
        for (const adminId of adminIds) {
          criarNotificacao({
            usuarioId: adminId,
            tipo: 'lembrete',
            titulo: 'Pré-admissão aguardando revisão',
            mensagem: `Há uma pré-admissão aguardando revisão há ${horas}h. Acesse o painel para analisar.`,
            link: '/pre-admissao',
            metadados: { acao: 'lembrete_aguardando_rh', solicitacaoId: sol.id, horasParada: horas },
          }).catch(err => console.error('[Alertas Periodicos] Erro ao criar notificação gestor pré-admissão:', err));
        }

        await enviarPushParaColaboradores(adminIds, {
          titulo: 'Pré-admissão aguardando revisão',
          mensagem: `Formulário aguarda revisão há ${horas}h. Toque para revisar.`,
          severidade: horas >= 48 ? 'critico' : 'atencao',
          data: { tipo: 'lembrete_aguardando_rh_admissao', solicitacaoId: sol.id },
          url: '/pre-admissao',
        });

      }
    }
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar pré-admissões paradas:', error);
  }
}

// =====================================================
// LEMBRETES DE ASO NÃO ANEXADO
// Enviado ao candidato 1h, 24h, 36h e 48h após o exame,
// caso o status ainda seja 'aso_solicitado' (não 'aso_recebido').
// 36h e 48h também notificam gestores/admins.
// Cache com TTL de 7 dias impede reenvio do mesmo lembrete.
// =====================================================

const ASO_LEMBRETE_TTL = 7 * 24 * 3600; // 7 dias

const ASO_INTERVALOS: Array<{ horas: number; key: string; notificarAdmin: boolean }> = [
  { horas: 1,  key: '1h',  notificarAdmin: false },
  { horas: 24, key: '24h', notificarAdmin: false },
  { horas: 36, key: '36h', notificarAdmin: true  },
  { horas: 48, key: '48h', notificarAdmin: true  },
];

async function lembrarAsoNaoAnexado(): Promise<void> {
  try {
    // data_exame_aso é TIMESTAMPTZ (migration 016) — já contém data+hora do exame.
    // Janela máxima de 49h para não reprocessar exames antigos.
    const result = await query<{
      id: string;
      usuario_provisorio_id: number | null;
      onesignal_subscription_id: string | null;
      horas_desde_exame: number;
    }>(`
      SELECT
        id,
        usuario_provisorio_id,
        onesignal_subscription_id,
        EXTRACT(EPOCH FROM (NOW() - data_exame_aso)) / 3600 AS horas_desde_exame
      FROM people.solicitacoes_admissao
      WHERE status = 'aso_solicitado'
        AND data_exame_aso IS NOT NULL
        AND data_exame_aso BETWEEN NOW() - INTERVAL '49 hours' AND NOW()
    `);

    if (result.rows.length === 0) return;

    let adminIds: number[] = [];

    for (const sol of result.rows) {
      const horas = sol.horas_desde_exame;

      for (const iv of ASO_INTERVALOS) {
        if (horas < iv.horas) continue;

        const cacheKey = `lembrete_aso:${sol.id}:${iv.key}`;
        if (await jaEnviou(cacheKey)) continue;
        await cacheSet(cacheKey, true, ASO_LEMBRETE_TTL);

        const severidade = iv.horas >= 36 ? 'critico' : 'atencao';
        const titulo = 'Envie seu ASO';
        const mensagem = iv.horas === 1
          ? 'Não esqueça de enviar uma foto do seu ASO pelo app.'
          : `Seu exame foi há ${Math.round(iv.horas)}h e o ASO ainda não foi enviado. Por favor, anexe pelo app.`;

        // Push ao candidato (usuário provisório)
        if (sol.usuario_provisorio_id) {
          enviarPushParaProvisorio(
            sol.usuario_provisorio_id,
            {
              titulo,
              mensagem,
              severidade,
              data: { tipo: 'lembrete_aso', solicitacaoId: sol.id, horasDesdeExame: Math.round(iv.horas) },
              url: '/aso-envio',
            },
            sol.onesignal_subscription_id,
          ).catch(err => console.error('[Alertas Periodicos] Erro ao enviar push lembrete ASO:', err));
        }

        // A partir de 36h, notifica também gestores/admins
        if (iv.notificarAdmin) {
          if (adminIds.length === 0) {
            const r = await query<{ id: number }>(
              `SELECT id FROM people.colaboradores WHERE tipo IN ('admin', 'gestor') AND status = 'ativo'`
            );
            adminIds = r.rows.map(row => row.id);
          }

          for (const adminId of adminIds) {
            criarNotificacao({
              usuarioId: adminId,
              tipo: 'lembrete',
              titulo: 'Candidato sem ASO enviado',
              mensagem: `Um candidato realizou o exame há ${Math.round(iv.horas)}h e ainda não enviou o ASO.`,
              link: '/pre-admissao',
              metadados: { acao: 'lembrete_aso_admin', solicitacaoId: sol.id, horas: Math.round(iv.horas) },
            }).catch(err => console.error('[Alertas Periodicos] Erro ao criar notificação gestor ASO:', err));
          }

          if (adminIds.length > 0) {
            await enviarPushParaColaboradores(adminIds, {
              titulo: 'Candidato sem ASO enviado',
              mensagem: `Um candidato realizou o exame há ${Math.round(iv.horas)}h sem enviar o ASO.`,
              severidade,
              data: { tipo: 'lembrete_aso_admin', solicitacaoId: sol.id },
              url: '/pre-admissao',
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar ASO não anexado:', error);
  }
}

// =====================================================
// 1. DOCUMENTOS PRESTES A VENCER
// Colaborador: avisos em 30d, 15d, 7d.
// Admins/gestores: aviso adicional no intervalo crítico de 7d.
// =====================================================

async function notificarDocumentosVencendo(): Promise<void> {
  try {
    const result = await query<{
      doc_id: number;
      colaborador_id: number;
      tipo_nome: string;
      data_validade: string;
      dias_restantes: number;
    }>(`
      SELECT
        d.id                                    AS doc_id,
        d.colaborador_id,
        COALESCE(t.nome_exibicao, d.tipo)       AS tipo_nome,
        d.data_validade::text,
        (d.data_validade - CURRENT_DATE)::int   AS dias_restantes
      FROM people.documentos_colaborador d
      LEFT JOIN people.tipos_documento_colaborador t ON t.id = d.tipo_documento_id
      JOIN people.colaboradores c ON c.id = d.colaborador_id
      WHERE c.status = 'ativo'
        AND d.data_validade IS NOT NULL
        AND d.data_validade BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
    `);

    if (result.rows.length === 0) return;

    const intervalos = [
      { maxDias: 7,  key: '7d',  severidade: 'critico' as const, notificarAdmin: true  },
      { maxDias: 15, key: '15d', severidade: 'atencao' as const, notificarAdmin: false },
      { maxDias: 30, key: '30d', severidade: 'info'    as const, notificarAdmin: false },
    ];

    let adminIds: number[] = [];

    for (const doc of result.rows) {
      const dias = doc.dias_restantes;

      for (const iv of intervalos) {
        if (dias > iv.maxDias) continue;

        const cacheKey = `doc_vencendo:${doc.doc_id}:${iv.key}`;
        if (await jaEnviou(cacheKey)) continue;
        await cacheSet(cacheKey, true, LEMBRETE_TTL);

        const diasStr = dias === 0 ? 'hoje' : dias === 1 ? 'amanhã' : `em ${dias} dias`;
        const titulo = `Documento vence ${diasStr}`;
        const mensagem = `"${doc.tipo_nome}" vence ${diasStr} (${formatarDataBr(doc.data_validade)}). Providencie a renovação.`;

        criarNotificacao({
          usuarioId: doc.colaborador_id,
          tipo: 'alerta',
          titulo,
          mensagem,
          link: '/documentos',
          metadados: { acao: 'documento_vencendo', documentoId: doc.doc_id, diasRestantes: dias },
        }).catch(err => console.error('[Alertas Periodicos] Erro notif doc vencendo:', err));

        enviarPushParaColaboradores([doc.colaborador_id], {
          titulo,
          mensagem,
          severidade: iv.severidade,
          data: { tipo: 'documento_vencendo', documentoId: doc.doc_id, diasRestantes: dias },
          url: '/documentos',
        }).catch(err => console.error('[Alertas Periodicos] Erro push doc vencendo:', err));

        if (iv.notificarAdmin) {
          if (adminIds.length === 0) {
            const r = await query<{ id: number }>(
              `SELECT id FROM people.colaboradores WHERE tipo IN ('admin', 'gestor') AND status = 'ativo'`
            );
            adminIds = r.rows.map(row => row.id);
          }
          for (const adminId of adminIds) {
            criarNotificacao({
              usuarioId: adminId,
              tipo: 'alerta',
              titulo: `Doc. vencendo em ${dias}d — ${doc.tipo_nome}`,
              mensagem: `Documento "${doc.tipo_nome}" de colaborador vence em ${dias} dias. Verifique o painel.`,
              link: '/documentos',
              metadados: { acao: 'doc_vencendo_admin', documentoId: doc.doc_id, colaboradorId: doc.colaborador_id, diasRestantes: dias },
            }).catch(err => console.error('[Alertas Periodicos] Erro notif admin doc vencendo:', err));
          }
          if (adminIds.length > 0) {
            await enviarPushParaColaboradores(adminIds, {
              titulo: `Doc. vencendo — ${doc.tipo_nome}`,
              mensagem: `Documento de colaborador vence em ${dias} dias.`,
              severidade: 'critico',
              data: { tipo: 'doc_vencendo_admin', documentoId: doc.doc_id },
              url: '/documentos',
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar documentos vencendo:', error);
  }
}

// =====================================================
// 2. FÉRIAS PRESTES A INICIAR
// Lembra o colaborador 7d, 3d e 1d antes das férias começarem.
// =====================================================

async function notificarFeriasProximas(): Promise<void> {
  try {
    const result = await query<{
      ferias_id: number;
      colaborador_id: number;
      data_inicio: string;
      data_fim: string;
      dias_restantes: number;
    }>(`
      SELECT
        pf.id                                   AS ferias_id,
        pf.colaborador_id,
        pf.data_inicio::text,
        pf.data_fim::text,
        (pf.data_inicio - CURRENT_DATE)::int    AS dias_restantes
      FROM people.periodos_ferias pf
      JOIN people.colaboradores c ON c.id = pf.colaborador_id
      WHERE c.status = 'ativo'
        AND pf.data_inicio BETWEEN CURRENT_DATE + 1 AND CURRENT_DATE + 7
    `);

    if (result.rows.length === 0) return;

    const intervalos = [
      { maxDias: 1, key: '1d' },
      { maxDias: 3, key: '3d' },
      { maxDias: 7, key: '7d' },
    ];

    for (const f of result.rows) {
      const dias = f.dias_restantes;

      for (const iv of intervalos) {
        if (dias > iv.maxDias) continue;

        const cacheKey = `ferias_proximas:${f.ferias_id}:${iv.key}`;
        if (await jaEnviou(cacheKey)) continue;
        await cacheSet(cacheKey, true, LEMBRETE_TTL);

        const diasStr = dias === 1 ? 'amanhã' : `em ${dias} dias`;
        const titulo = `Férias começam ${diasStr}!`;
        const mensagem = `Suas férias começam ${diasStr} (${formatarDataBr(f.data_inicio)}) e vão até ${formatarDataBr(f.data_fim)}.`;

        criarNotificacao({
          usuarioId: f.colaborador_id,
          tipo: 'lembrete',
          titulo,
          mensagem,
          link: '/ferias',
          metadados: { acao: 'ferias_proximas', feriasId: f.ferias_id, diasRestantes: dias },
        }).catch(err => console.error('[Alertas Periodicos] Erro notif férias próximas:', err));

        await enviarPushParaColaboradores([f.colaborador_id], {
          titulo,
          mensagem,
          severidade: dias <= 1 ? 'atencao' : 'info',
          data: { tipo: 'ferias_proximas', feriasId: f.ferias_id, diasRestantes: dias },
          url: '/ferias',
        });
      }
    }
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar férias próximas:', error);
  }
}

// =====================================================
// 3. FÉRIAS VENCENDO — PASSIVO TRABALHISTA
// Avisa admins/gestores (1x/dia) sobre colaboradores com 12+ meses de empresa
// sem férias futuras e sem férias nos últimos 11 meses.
// =====================================================

async function notificarFeriasVencendo(): Promise<void> {
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const cacheKey = `ferias_vencendo:${hoje}`;
    if (await jaEnviou(cacheKey)) return;

    const result = await query<{
      colaborador_id: number;
      nome: string;
    }>(`
      SELECT c.id AS colaborador_id, c.nome
      FROM people.colaboradores c
      WHERE c.status = 'ativo'
        AND c.data_admissao <= CURRENT_DATE - INTERVAL '12 months'
        AND (
          SELECT COUNT(*) FROM people.periodos_ferias pf
          WHERE pf.colaborador_id = c.id AND pf.data_inicio > CURRENT_DATE
        ) = 0
        AND (
          (SELECT MAX(pf2.data_fim) FROM people.periodos_ferias pf2 WHERE pf2.colaborador_id = c.id) IS NULL
          OR
          (SELECT MAX(pf2.data_fim) FROM people.periodos_ferias pf2 WHERE pf2.colaborador_id = c.id)
            <= CURRENT_DATE - INTERVAL '11 months'
        )
    `);

    if (result.rows.length === 0) return;

    const adminResult = await query<{ id: number }>(
      `SELECT id FROM people.colaboradores WHERE tipo IN ('admin', 'gestor') AND status = 'ativo'`
    );
    const adminIds = adminResult.rows.map(row => row.id);
    if (adminIds.length === 0) return;

    await cacheSet(cacheKey, true, ALERTA_TTL);

    const total = result.rows.length;
    const nomes = result.rows.map(r => r.nome).join(', ');
    const titulo = `${total} colaborador${total > 1 ? 'es' : ''} sem férias programadas`;
    const mensagem = `${total} colaborador${total > 1 ? 'es' : ''} com 12+ meses sem férias futuras: ${nomes.slice(0, 180)}${nomes.length > 180 ? '…' : ''}. Risco trabalhista.`;

    for (const adminId of adminIds) {
      criarNotificacao({
        usuarioId: adminId,
        tipo: 'alerta',
        titulo,
        mensagem,
        link: '/ferias',
        metadados: { acao: 'ferias_vencendo', total, colaboradorIds: result.rows.map(r => r.colaborador_id) },
      }).catch(err => console.error('[Alertas Periodicos] Erro notif férias vencendo:', err));
    }

    await enviarPushParaColaboradores(adminIds, {
      titulo,
      mensagem: `${total} colaborador${total > 1 ? 'es' : ''} sem férias programadas. Verifique.`,
      severidade: 'atencao',
      data: { tipo: 'ferias_vencendo', total },
      url: '/ferias',
    });
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar férias vencendo:', error);
  }
}

// =====================================================
// 4. PRAZO DE CONTESTAÇÃO DE RELATÓRIO MENSAL
// Lembra o colaborador de assinar ou contestar o relatório
// 3 dias e 5 dias após a publicação, enquanto estiver pendente.
// =====================================================

async function notificarPrazoContestacao(): Promise<void> {
  try {
    const result = await query<{
      relatorio_id: number;
      colaborador_id: number;
      mes: number;
      ano: number;
      dias_pendente: number;
    }>(`
      SELECT
        rm.id                                                  AS relatorio_id,
        rm.colaborador_id,
        rm.mes,
        rm.ano,
        (EXTRACT(EPOCH FROM (NOW() - rm.criado_em)) / 86400)::int AS dias_pendente
      FROM people.relatorios_mensais rm
      LEFT JOIN people.colaboradores c ON c.id = rm.colaborador_id
      LEFT JOIN people.cargos cg       ON cg.id = c.cargo_id
      WHERE rm.status = 'pendente'
        AND rm.criado_em < NOW() - INTERVAL '3 days'
        AND rm.criado_em > NOW() - INTERVAL '30 days'
        -- Cargos de confiança não recebem lembrete (não há contestação a fazer).
        AND COALESCE(cg.cargo_confianca, FALSE) = FALSE
    `);

    if (result.rows.length === 0) return;

    const mesesNome = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    for (const rel of result.rows) {
      const dias = rel.dias_pendente;
      const periodo = `${mesesNome[rel.mes - 1]}/${rel.ano}`;

      // Notifica no slot de 5 dias (mais urgente) e no de 3 dias
      for (const slot of [5, 3]) {
        if (dias < slot) continue;

        const cacheKey = `relatorio_contestacao:${rel.relatorio_id}:${slot}d`;
        if (await jaEnviou(cacheKey)) continue;
        await cacheSet(cacheKey, true, ALERTA_TTL);

        const titulo = 'Relatório mensal aguardando revisão';
        const mensagem = slot >= 5
          ? `Seu relatório de ${periodo} está há ${dias} dias sem assinatura. Assine ou conteste o quanto antes.`
          : `Seu relatório de ${periodo} foi publicado há ${dias} dias. Revise, assine ou conteste pelo app.`;

        criarNotificacao({
          usuarioId: rel.colaborador_id,
          tipo: 'lembrete',
          titulo,
          mensagem,
          link: '/relatorio',
          metadados: { acao: 'lembrete_contestacao', relatorioId: rel.relatorio_id, mes: rel.mes, ano: rel.ano, diasPendente: dias },
        }).catch(err => console.error('[Alertas Periodicos] Erro notif contestação relatório:', err));

        await enviarPushParaColaboradores([rel.colaborador_id], {
          titulo,
          mensagem,
          severidade: slot >= 5 ? 'atencao' : 'info',
          data: { tipo: 'lembrete_contestacao', relatorioId: rel.relatorio_id },
          url: '/relatorio',
        });

        break; // só o slot mais urgente ainda não enviado
      }
    }
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar prazo de contestação:', error);
  }
}

// =====================================================
// 4b. GERAÇÃO MENSAL DOS RELATÓRIOS (DIA 1º)
// No dia 1º de cada mês, cria o registro `relatorios_mensais` (status=pendente)
// para cada colaborador ATIVO admitido até o último dia do mês anterior, e
// dispara o push "Relatório de ponto disponível". Idempotente — pode rodar
// várias vezes no dia (ON CONFLICT DO NOTHING + cache de 30d para o push).
// =====================================================

async function gerarRelatoriosMensaisDia1(): Promise<void> {
  try {
    const hojeSP = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    );
    if (hojeSP.getDate() !== 1) return;

    // Mês de referência = mês anterior ao corrente
    const mesRef = hojeSP.getMonth() === 0 ? 12 : hojeSP.getMonth();
    const anoRef = hojeSP.getMonth() === 0 ? hojeSP.getFullYear() - 1 : hojeSP.getFullYear();
    const ultimoDiaMesRef = new Date(anoRef, mesRef, 0).getDate();
    const ultimoDiaMesRefStr = `${anoRef}-${String(mesRef).padStart(2, '0')}-${String(ultimoDiaMesRef).padStart(2, '0')}`;

    // Exclui colaboradores em cargos de confiança — não batem ponto, não
    // têm relatório mensal pra assinar, não recebem o push.
    const colabResult = await query<{ id: number }>(
      `SELECT c.id
       FROM people.colaboradores c
       LEFT JOIN people.cargos cg ON cg.id = c.cargo_id
       WHERE c.status = 'ativo'
         AND c.data_admissao <= $1::date
         AND COALESCE(cg.cargo_confianca, FALSE) = FALSE`,
      [ultimoDiaMesRefStr]
    );

    if (colabResult.rows.length === 0) return;

    const mesesNome = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    const nomeMes = mesesNome[mesRef - 1];

    for (const { id: colaboradorId } of colabResult.rows) {
      // Cria o registro do relatório (pendente, valores zerados — serão
      // preenchidos no primeiro GET do endpoint /api/v1/relatorio-mensal/[id]).
      await query(
        `INSERT INTO people.relatorios_mensais
           (colaborador_id, mes, ano, status)
         VALUES ($1, $2, $3, 'pendente')
         ON CONFLICT (colaborador_id, mes, ano) DO NOTHING`,
        [colaboradorId, mesRef, anoRef]
      );

      // Dispara push só uma vez por (colaborador, mês, ano).
      const cacheKey = `notif_relatorio:${colaboradorId}:${mesRef}:${anoRef}`;
      if (await jaEnviou(cacheKey)) continue;
      await cacheSet(cacheKey, true, 30 * 24 * 3600);

      const titulo = 'Relatório de ponto disponível';
      const mensagem = `Seu relatório de ponto de ${nomeMes} de ${anoRef} está disponível para assinatura. Acesse o app para assinar.`;

      criarNotificacao({
        usuarioId: colaboradorId,
        tipo: 'sistema',
        titulo,
        mensagem,
        link: '/relatorios',
        metadados: { acao: 'relatorio_disponivel', mes: mesRef, ano: anoRef },
      }).catch(err => console.error('[Alertas Periodicos] Erro notif relatório dia 1º:', err));

      await enviarPushParaColaboradores([colaboradorId], {
        titulo,
        mensagem,
        severidade: 'info',
        data: { tipo: 'relatorio_disponivel', mes: mesRef, ano: anoRef },
        url: '/relatorios',
      });
    }
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao gerar relatórios mensais dia 1º:', error);
  }
}

// =====================================================
// 5. REUNIÃO EM BREVE
// Avisa todos os participantes 30 minutos antes.
// Usa a flag notificacao_enviada no banco para garantir envio único.
// =====================================================

async function notificarReunioesProximas(): Promise<void> {
  try {
    const result = await query<{
      reuniao_id: number;
      titulo: string;
      data_inicio: string;
      anfitriao_id: number;
      participante_ids: number[];
    }>(`
      SELECT
        r.id            AS reuniao_id,
        r.titulo,
        r.data_inicio::text,
        r.anfitriao_id,
        COALESCE(
          array_agg(rp.colaborador_id) FILTER (WHERE rp.colaborador_id IS NOT NULL),
          '{}'
        ) AS participante_ids
      FROM people.reunioes r
      LEFT JOIN people.reunioes_participantes rp ON rp.reuniao_id = r.id
      WHERE r.status = 'agendada'
        AND r.notificacao_enviada = false
        AND r.data_inicio BETWEEN NOW() AND NOW() + INTERVAL '31 minutes'
      GROUP BY r.id, r.titulo, r.data_inicio, r.anfitriao_id
    `);

    if (result.rows.length === 0) return;

    for (const reuniao of result.rows) {
      // Atualiza o flag primeiro para evitar double-send em caso de ciclo concurrent
      await query(
        'UPDATE people.reunioes SET notificacao_enviada = true WHERE id = $1 AND notificacao_enviada = false',
        [reuniao.reuniao_id]
      );

      const todosIds = [...new Set([reuniao.anfitriao_id, ...reuniao.participante_ids])];
      if (todosIds.length === 0) continue;

      const hora = formatarHoraSP(reuniao.data_inicio);
      const titulo = 'Reunião em 30 minutos';
      const mensagem = `"${reuniao.titulo}" começa às ${hora}. Prepare-se!`;

      for (const colab of todosIds) {
        criarNotificacao({
          usuarioId: colab,
          tipo: 'lembrete',
          titulo,
          mensagem,
          link: '/reunioes',
          metadados: { acao: 'reuniao_proxima', reuniaoId: reuniao.reuniao_id, hora },
        }).catch(err => console.error('[Alertas Periodicos] Erro notif reunião próxima:', err));
      }

      await enviarPushParaColaboradores(todosIds, {
        titulo,
        mensagem,
        severidade: 'atencao',
        data: { tipo: 'reuniao_proxima', reuniaoId: reuniao.reuniao_id },
        url: '/reunioes',
      });
    }
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar reuniões próximas:', error);
  }
}

// =====================================================
// 6. ADMISSÃO TRAVADA EM CONTRATO ASSINADO
// Notifica admins/gestores (1x/dia) quando uma pré-admissão fica em
// contrato_assinado por mais de 24h sem ser finalizada como 'admitido'.
// =====================================================

async function notificarAdmissaoContratoAssinado(): Promise<void> {
  try {
    const result = await query<{
      id: string;
      horas_parada: number;
    }>(`
      SELECT id,
        EXTRACT(EPOCH FROM (NOW() - atualizado_em)) / 3600 AS horas_parada
      FROM people.solicitacoes_admissao
      WHERE status = 'contrato_assinado'
        AND atualizado_em < NOW() - INTERVAL '24 hours'
    `);

    if (result.rows.length === 0) return;

    const hoje = new Date().toISOString().split('T')[0];
    let adminIds: number[] = [];

    for (const sol of result.rows) {
      const cacheKey = `admissao_contrato_assinado:${sol.id}:${hoje}`;
      if (await jaEnviou(cacheKey)) continue;
      await cacheSet(cacheKey, true, ALERTA_TTL);

      const horas = Math.round(sol.horas_parada);

      if (adminIds.length === 0) {
        const r = await query<{ id: number }>(
          `SELECT id FROM people.colaboradores WHERE tipo IN ('admin', 'gestor') AND status = 'ativo'`
        );
        adminIds = r.rows.map(row => row.id);
      }

      for (const adminId of adminIds) {
        criarNotificacao({
          usuarioId: adminId,
          tipo: 'lembrete',
          titulo: 'Admissão pendente de conclusão',
          mensagem: `Um candidato assinou o contrato há ${horas}h e ainda não foi admitido. Acesse o painel para finalizar.`,
          link: '/pre-admissao',
          metadados: { acao: 'admissao_contrato_assinado', solicitacaoId: sol.id, horasParada: horas },
        }).catch(err => console.error('[Alertas Periodicos] Erro notif admissão contrato assinado:', err));
      }

      if (adminIds.length > 0) {
        await enviarPushParaColaboradores(adminIds, {
          titulo: 'Admissão pendente de conclusão',
          mensagem: `Candidato com contrato assinado há ${horas}h. Finalize a admissão.`,
          severidade: horas >= 48 ? 'critico' : 'atencao',
          data: { tipo: 'admissao_contrato_assinado', solicitacaoId: sol.id },
          url: '/pre-admissao',
        });
      }
    }
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar admissões em contrato assinado:', error);
  }
}

// =====================================================
// 7. SOLICITAÇÃO DE ATRASO SEM RESPOSTA
// Notifica admins/gestores sobre solicitações de atraso pendentes há mais de
// 4 horas. Repete o lembrete a cada janela de 4h enquanto continuar pendente.
// =====================================================

async function notificarSolicitacoesAtrasoPendentes(): Promise<void> {
  try {
    const result = await query<{
      id: number;
      horas_pendente: number;
    }>(`
      SELECT id,
        EXTRACT(EPOCH FROM (NOW() - criado_em)) / 3600 AS horas_pendente
      FROM people.solicitacoes
      WHERE tipo = 'atraso'
        AND status = 'pendente'
        AND criado_em < NOW() - INTERVAL '4 hours'
    `);

    if (result.rows.length === 0) return;

    const slot4h = Math.floor(Date.now() / (4 * 60 * 60 * 1000));
    let adminIds: number[] = [];

    for (const sol of result.rows) {
      const cacheKey = `sol_atraso_pendente:${sol.id}:${slot4h}`;
      if (await jaEnviou(cacheKey)) continue;
      await cacheSet(cacheKey, true, 4 * 3600);

      const horas = Math.round(sol.horas_pendente);

      if (adminIds.length === 0) {
        const r = await query<{ id: number }>(
          `SELECT id FROM people.colaboradores WHERE tipo IN ('admin', 'gestor') AND status = 'ativo'`
        );
        adminIds = r.rows.map(row => row.id);
      }

      for (const adminId of adminIds) {
        criarNotificacao({
          usuarioId: adminId,
          tipo: 'lembrete',
          titulo: 'Solicitação de atraso sem resposta',
          mensagem: `Uma justificativa de atraso está pendente há ${horas}h. Acesse para aprovar ou rejeitar.`,
          link: '/solicitacoes',
          metadados: { acao: 'atraso_pendente', solicitacaoId: sol.id, horasPendente: horas },
        }).catch(err => console.error('[Alertas Periodicos] Erro notif atraso pendente:', err));
      }

      if (adminIds.length > 0) {
        await enviarPushParaColaboradores(adminIds, {
          titulo: 'Solicitação de atraso sem resposta',
          mensagem: `Justificativa pendente há ${horas}h. Acesse para responder.`,
          severidade: horas >= 8 ? 'atencao' : 'info',
          data: { tipo: 'sol_atraso_pendente', solicitacaoId: sol.id },
          url: '/solicitacoes',
        });
      }
    }
  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar solicitações de atraso pendentes:', error);
  }
}

// =====================================================
// NOTIFICAÇÃO DE ESPORTES
// Notifica colaboradores inscritos quando há sessão hoje.
// Enviada uma vez por dia, no primeiro ciclo após as 07h00 (horário SP).
// =====================================================

async function notificarEsportesHoje(): Promise<void> {
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
  const horaAtualSP = parseInt(
    new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }),
    10,
  );

  // Só envia entre 07h e 10h para não acordar ninguém no meio da madrugada
  if (horaAtualSP < 7 || horaAtualSP >= 10) return;

  const chave = 'notif_esportes_hoje:' + hoje;
  if (await jaEnviou(chave)) return;

  try {
    const sessaoResult = await query(
      `SELECT id, hora_inicio, local FROM people.esportes_sessoes WHERE data_sessao = $1`,
      [hoje],
    );
    if (sessaoResult.rows.length === 0) return;

    const sessao = sessaoResult.rows[0];
    const horaFormatada = String(sessao.hora_inicio).slice(0, 5); // HH:MM

    const inscritosResult = await query(
      `SELECT ei.colaborador_id
       FROM people.esportes_inscricoes ei
       WHERE ei.sessao_id = $1`,
      [sessao.id],
    );
    if (inscritosResult.rows.length === 0) return;

    await marcarEnviado(chave);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const colaboradorIds: number[] = inscritosResult.rows.map((r: any) => r.colaborador_id as number);

    // Notificação DB para cada inscrito
    for (const colaboradorId of colaboradorIds) {
      criarNotificacao({
        usuarioId: colaboradorId,
        tipo: 'lembrete',
        titulo: 'Futebol hoje!',
        mensagem: `A sessão de futebol começa às ${horaFormatada} em ${sessao.local}. Você está inscrito!`,
        link: '/esportes',
        metadados: { acao: 'esportes_hoje', sessaoId: sessao.id, horaInicio: horaFormatada, local: sessao.local },
      }).catch((err) => console.error('[Alertas Periodicos] Erro ao criar notificação de esportes:', err));
    }

    // Push em lote para todos os inscritos de uma vez
    await enviarPushParaColaboradores(colaboradorIds, {
      titulo: 'Futebol hoje!',
      mensagem: `Começa às ${horaFormatada} em ${sessao.local}. Você está na lista!`,
      severidade: 'atencao',
      data: { tipo: 'esportes_hoje', sessaoId: sessao.id },
      url: '/esportes',
    });

  } catch (error) {
    console.error('[Alertas Periodicos] Erro ao verificar esportes:', error);
  }
}

async function executarCiclo(): Promise<void> {
  try {
    const inicio = Date.now();

    const alertasRegras = await analisarEmpresas();
    const alertasIA = await analisarComGemini();
    const todos = [...alertasRegras, ...alertasIA];

    for (const a of todos) {
      await salvarAlerta(a);
    }

    await notificarAdmins(todos);

    // Lembretes de pré-admissão parada
    await lembrarPreAdmissoesParadas();

    // Lembretes de ASO não anexado (1h, 24h, 36h, 48h após o exame)
    await lembrarAsoNaoAnexado();

    // Documentos prestes a vencer (30d, 15d, 7d)
    await notificarDocumentosVencendo();

    // Férias prestes a iniciar (7d, 3d, 1d)
    await notificarFeriasProximas();

    // Colaboradores sem férias futuras há 12+ meses (passivo trabalhista)
    await notificarFeriasVencendo();

    // Geração mensal dos relatórios — dispara apenas no dia 1º
    await gerarRelatoriosMensaisDia1();

    // Relatórios mensais sem assinatura/contestação (3d e 5d)
    await notificarPrazoContestacao();

    // Reuniões começando em 30 minutos
    await notificarReunioesProximas();

    // Admissões travadas em contrato_assinado há 24h+
    await notificarAdmissaoContratoAssinado();

    // Solicitações de atraso pendentes há 4h+ (repete a cada 4h)
    await notificarSolicitacoesAtrasoPendentes();

    // Notificações para colaboradores (esportes, etc.)
    await notificarEsportesHoje();

    const duracao = Date.now() - inicio;
    const criticos = todos.filter(a => a.severidade === 'critico').length;
    void duracao;
    void criticos;
  } catch (error) {
    console.error('[Alertas Periodicos] Erro no ciclo:', error);
  }
}

export function iniciarAlertasPeriodicos(): void {
  if (timerRef) return;

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
  }
}

export { executarCiclo as executarAnaliseManual };
