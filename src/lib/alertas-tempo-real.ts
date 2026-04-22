import { query } from '@/lib/db';
import { criarNotificacao } from '@/lib/notificacoes';
import { enviarPushParaColaboradores } from '@/lib/push-colaborador';
import { sendEmail } from '@/lib/email';
import { cacheGet, cacheSet } from '@/lib/cache';

const ALERTA_TTL = 86400; // 24h - evita duplicata no mesmo dia
const GEMINI_COOLDOWN = 3600; // 1h entre analises de IA por empresa

function alertaKey(tipo: string, empresaId: number, extra?: string): string {
  const dia = new Date().toISOString().split('T')[0];
  return 'alerta_rt:' + tipo + ':' + empresaId + ':' + dia + (extra ? ':' + extra : '');
}

async function jaEnviouAlerta(key: string): Promise<boolean> {
  const cached = await cacheGet<boolean>(key);
  return cached === true;
}

async function marcarAlertaEnviado(key: string): Promise<void> {
  await cacheSet(key, true, ALERTA_TTL);
}

interface DadosAlerta {
  empresaId: number;
  categoria: string;
  severidade: 'info' | 'atencao' | 'critico';
  titulo: string;
  mensagem: string;
  dados: Record<string, unknown>;
  origem: 'ia' | 'regra';
}

async function dispararAlerta(alerta: DadosAlerta): Promise<void> {
  try {
    await query(
      'INSERT INTO people.alertas_inteligentes (empresa_id, categoria, severidade, titulo, mensagem, dados, origem) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [alerta.empresaId, alerta.categoria, alerta.severidade, alerta.titulo, alerta.mensagem, JSON.stringify(alerta.dados), alerta.origem]
    );

    const admins = await query(
      'SELECT id, email, nome FROM people.colaboradores WHERE tipo = \'admin\' AND status = \'ativo\''
    );

    const adminIds = admins.rows.map((a) => (a as { id: number }).id);

    for (const admin of admins.rows) {
      await criarNotificacao({
        usuarioId: admin.id,
        tipo: 'alerta',
        titulo: alerta.titulo,
        mensagem: alerta.mensagem,
        link: '/alertas-inteligentes',
        metadados: { categoria: alerta.categoria, severidade: alerta.severidade, empresaId: alerta.empresaId },
      });

      if (alerta.severidade === 'critico' && admin.email) {
        const cor = '#dc2626';
        const base = process.env.BASE_URL || 'http://localhost:3000';
        await sendEmail({
          to: admin.email,
          subject: 'BluePoint ALERTA: ' + alerta.titulo,
          html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;color:#333;line-height:1.6"><div style="max-width:600px;margin:0 auto;padding:20px"><div style="background:' + cor + ';color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0"><h2 style="margin:0">ALERTA CRITICO</h2></div><div style="background:#f9fafb;padding:30px;border-radius:0 0 8px 8px"><h3>' + alerta.titulo + '</h3><p>' + alerta.mensagem + '</p><p style="text-align:center;margin-top:20px"><a href="' + base + '/alertas-inteligentes" style="display:inline-block;background:#1e40af;color:white;padding:12px 30px;text-decoration:none;border-radius:6px">Ver Detalhes</a></p></div></div></body></html>',
        });
      }
    }

    if (adminIds.length > 0) {
      enviarPushParaColaboradores(adminIds, {
        titulo: alerta.titulo,
        mensagem: alerta.mensagem,
        severidade: alerta.severidade,
        data: { tipo: 'alerta_tempo_real', categoria: alerta.categoria, empresaId: alerta.empresaId },
        url: '/alertas-inteligentes',
      }).catch(err => console.error('[Alerta Tempo Real] Erro ao enviar push para admins:', err));
    }
  } catch (error) {
    console.error('[Alerta Tempo Real] Erro ao disparar:', error);
  }
}

// =====================================================
// VERIFICACAO: AUSENCIAS
// Chamado apos registrar-entrada / registrar-ponto
// =====================================================

export async function verificarAlertaAusencias(empresaId: number): Promise<void> {
  const key50 = alertaKey('ausencia_50', empresaId);
  const key30 = alertaKey('ausencia_30pct', empresaId);

  if (await jaEnviouAlerta(key50) && await jaEnviouAlerta(key30)) return;

  const res = await query(
    'SELECT COUNT(*) as total FROM people.colaboradores WHERE empresa_id = $1 AND status = \'ativo\'',
    [empresaId]
  );
  const total = parseInt(res.rows[0]?.total || '0');
  if (total === 0) return;

  const presRes = await query(
    'SELECT COUNT(DISTINCT m.colaborador_id) as presentes FROM people.marcacoes m JOIN people.colaboradores c ON m.colaborador_id = c.id WHERE c.empresa_id = $1 AND DATE(m.data_hora) = CURRENT_DATE',
    [empresaId]
  );
  const presentes = parseInt(presRes.rows[0]?.presentes || '0');
  const ausentes = total - presentes;
  const pct = Math.round((ausentes / total) * 100);

  const empRes = await query('SELECT nome_fantasia FROM people.empresas WHERE id = $1', [empresaId]);
  const nome = empRes.rows[0]?.nome_fantasia || 'Empresa #' + empresaId;

  if (ausentes >= 50 && !(await jaEnviouAlerta(key50))) {
    await marcarAlertaEnviado(key50);
    await dispararAlerta({
      empresaId, categoria: 'ausencia', severidade: 'critico',
      titulo: nome + ': ' + ausentes + ' colaboradores ausentes hoje!',
      mensagem: nome + ' tem ' + ausentes + ' de ' + total + ' colaboradores ausentes (' + pct + '%). Impacto operacional provavel.',
      dados: { ausentes, total, pct }, origem: 'regra',
    });
  } else if (pct >= 30 && !(await jaEnviouAlerta(key30))) {
    await marcarAlertaEnviado(key30);
    await dispararAlerta({
      empresaId, categoria: 'ausencia', severidade: 'atencao',
      titulo: nome + ': ' + pct + '% de ausencia hoje (' + ausentes + ' pessoas)',
      mensagem: ausentes + ' de ' + total + ' colaboradores estao ausentes em ' + nome + '.',
      dados: { ausentes, total, pct }, origem: 'regra',
    });
  }
}

// =====================================================
// VERIFICACAO: ATRASOS
// Chamado apos registrar-entrada com status=atrasado
// =====================================================

export async function verificarAlertaAtrasos(empresaId: number): Promise<void> {
  const key5 = alertaKey('atraso_5', empresaId);
  const key20 = alertaKey('atraso_20', empresaId);

  if (await jaEnviouAlerta(key5) && await jaEnviouAlerta(key20)) return;

  const res = await query(
    'SELECT COUNT(DISTINCT s.colaborador_id) as total FROM people.solicitacoes s JOIN people.colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.tipo = \'atraso\' AND DATE(s.data_evento) = CURRENT_DATE',
    [empresaId]
  );
  const atrasados = parseInt(res.rows[0]?.total || '0');

  const empRes = await query('SELECT nome_fantasia FROM people.empresas WHERE id = $1', [empresaId]);
  const nome = empRes.rows[0]?.nome_fantasia || 'Empresa #' + empresaId;

  if (atrasados >= 20 && !(await jaEnviouAlerta(key20))) {
    await marcarAlertaEnviado(key20);
    await marcarAlertaEnviado(key5);
    await dispararAlerta({
      empresaId, categoria: 'atraso', severidade: 'critico',
      titulo: nome + ': ' + atrasados + ' pessoas se atrasaram hoje!',
      mensagem: 'Numero muito acima do normal. ' + atrasados + ' colaboradores registraram atraso em ' + nome + ' hoje.',
      dados: { atrasados }, origem: 'regra',
    });
  } else if (atrasados >= 5 && !(await jaEnviouAlerta(key5))) {
    await marcarAlertaEnviado(key5);
    await dispararAlerta({
      empresaId, categoria: 'atraso', severidade: 'atencao',
      titulo: nome + ': ' + atrasados + ' pessoas se atrasaram hoje',
      mensagem: atrasados + ' colaboradores registraram atraso em ' + nome + ' hoje. Recomenda-se investigar.',
      dados: { atrasados }, origem: 'regra',
    });
  }
}

// =====================================================
// VERIFICACAO: LIMITE DE HORA EXTRA
// Chamado apos aprovar solicitacao de hora extra
// =====================================================

export async function verificarAlertaHoraExtra(empresaId: number): Promise<void> {
  const key100 = alertaKey('he_100', empresaId);
  const key80 = alertaKey('he_80', empresaId);

  if (await jaEnviouAlerta(key100) && await jaEnviouAlerta(key80)) return;

  const limRes = await query('SELECT limite_mensal FROM people.limites_he_empresas WHERE empresa_id = $1', [empresaId]);
  if (limRes.rows.length === 0) return;
  const limite = parseFloat(limRes.rows[0].limite_mensal);

  const heRes = await query(
    'SELECT COALESCE(SUM(CASE WHEN bh.horas > 0 THEN bh.horas ELSE 0 END), 0) as total FROM people.banco_horas bh JOIN people.colaboradores c ON bh.colaborador_id = c.id WHERE c.empresa_id = $1 AND EXTRACT(MONTH FROM bh.data) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM bh.data) = EXTRACT(YEAR FROM CURRENT_DATE)',
    [empresaId]
  );
  const horasUsadas = parseFloat(heRes.rows[0]?.total || '0');
  const pct = Math.round((horasUsadas / limite) * 100);

  const empRes = await query('SELECT nome_fantasia FROM people.empresas WHERE id = $1', [empresaId]);
  const nome = empRes.rows[0]?.nome_fantasia || 'Empresa #' + empresaId;

  if (pct >= 100 && !(await jaEnviouAlerta(key100))) {
    await marcarAlertaEnviado(key100);
    await marcarAlertaEnviado(key80);
    await dispararAlerta({
      empresaId, categoria: 'hora_extra', severidade: 'critico',
      titulo: nome + ': Limite de hora extra ATINGIDO!',
      mensagem: nome + ' atingiu ' + pct + '% do limite mensal de HE (' + horasUsadas.toFixed(1) + 'h de ' + limite + 'h). Evitar novas horas extras.',
      dados: { horasUsadas, limite, pct }, origem: 'regra',
    });
  } else if (pct >= 80 && !(await jaEnviouAlerta(key80))) {
    await marcarAlertaEnviado(key80);
    await dispararAlerta({
      empresaId, categoria: 'hora_extra', severidade: 'atencao',
      titulo: nome + ': ' + pct + '% do limite de hora extra',
      mensagem: nome + ' consumiu ' + pct + '% do limite mensal (' + horasUsadas.toFixed(1) + 'h de ' + limite + 'h). Atencao com novas aprovacoes.',
      dados: { horasUsadas, limite, pct }, origem: 'regra',
    });
  }
}

// =====================================================
// VERIFICACAO: SOLICITACOES PENDENTES ACUMULADAS
// Chamado apos criar-solicitacao / solicitar-hora-extra
// =====================================================

export async function verificarAlertaSolicitacoesPendentes(empresaId: number): Promise<void> {
  const key20 = alertaKey('pend_20', empresaId);
  const key50 = alertaKey('pend_50', empresaId);

  if (await jaEnviouAlerta(key20) && await jaEnviouAlerta(key50)) return;

  const res = await query(
    'SELECT COUNT(*) as total FROM people.solicitacoes s JOIN people.colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.status = \'pendente\'',
    [empresaId]
  );
  const pendentes = parseInt(res.rows[0]?.total || '0');

  const empRes = await query('SELECT nome_fantasia FROM people.empresas WHERE id = $1', [empresaId]);
  const nome = empRes.rows[0]?.nome_fantasia || 'Empresa #' + empresaId;

  if (pendentes >= 50 && !(await jaEnviouAlerta(key50))) {
    await marcarAlertaEnviado(key50);
    await marcarAlertaEnviado(key20);
    await dispararAlerta({
      empresaId, categoria: 'geral', severidade: 'critico',
      titulo: nome + ': ' + pendentes + ' solicitacoes pendentes!',
      mensagem: 'Acumulo critico de ' + pendentes + ' solicitacoes aguardando aprovacao em ' + nome + '. Acao imediata recomendada.',
      dados: { pendentes }, origem: 'regra',
    });
  } else if (pendentes >= 20 && !(await jaEnviouAlerta(key20))) {
    await marcarAlertaEnviado(key20);
    await dispararAlerta({
      empresaId, categoria: 'geral', severidade: 'atencao',
      titulo: nome + ': ' + pendentes + ' solicitacoes pendentes',
      mensagem: pendentes + ' solicitacoes aguardam aprovacao em ' + nome + '.',
      dados: { pendentes }, origem: 'regra',
    });
  }
}

// =====================================================
// ANALISE IA SOB DEMANDA (Gemini)
// Pode ser chamado pelo endpoint /executar ou apos
// eventos criticos. Tem cooldown de 1h por empresa.
// =====================================================

export async function verificarInsightsIA(empresaId: number): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  const cooldownKey = 'alerta_rt:ia_cooldown:' + empresaId;
  if (await jaEnviouAlerta(cooldownKey)) return;
  await cacheSet(cooldownKey, true, GEMINI_COOLDOWN);

  try {
    const empRes = await query('SELECT nome_fantasia FROM people.empresas WHERE id = $1', [empresaId]);
    const nome = empRes.rows[0]?.nome_fantasia || 'Empresa';

    const [totalRes, presRes, atrasoRes, heRes, pendRes, tend7d] = await Promise.all([
      query('SELECT COUNT(*) as t FROM people.colaboradores WHERE empresa_id = $1 AND status = \'ativo\'', [empresaId]),
      query('SELECT COUNT(DISTINCT m.colaborador_id) as t FROM people.marcacoes m JOIN people.colaboradores c ON m.colaborador_id = c.id WHERE c.empresa_id = $1 AND DATE(m.data_hora) = CURRENT_DATE', [empresaId]),
      query('SELECT COUNT(DISTINCT s.colaborador_id) as t FROM people.solicitacoes s JOIN people.colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.tipo = \'atraso\' AND DATE(s.data_evento) = CURRENT_DATE', [empresaId]),
      query('SELECT COALESCE(SUM(CASE WHEN bh.horas > 0 THEN bh.horas ELSE 0 END), 0) as t FROM people.banco_horas bh JOIN people.colaboradores c ON bh.colaborador_id = c.id WHERE c.empresa_id = $1 AND EXTRACT(MONTH FROM bh.data) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM bh.data) = EXTRACT(YEAR FROM CURRENT_DATE)', [empresaId]),
      query('SELECT COUNT(*) as t FROM people.solicitacoes s JOIN people.colaboradores c ON s.colaborador_id = c.id WHERE c.empresa_id = $1 AND s.status = \'pendente\'', [empresaId]),
      query('SELECT d.dia::date as dia, (SELECT COUNT(*) FROM people.colaboradores c2 WHERE c2.empresa_id = $1 AND c2.status = \'ativo\' AND c2.id NOT IN (SELECT DISTINCT colaborador_id FROM people.marcacoes WHERE DATE(data_hora) = d.dia::date)) as ausentes FROM generate_series(CURRENT_DATE - INTERVAL \'6 days\', CURRENT_DATE, \'1 day\') d(dia) ORDER BY d.dia', [empresaId]),
    ]);

    const total = parseInt(totalRes.rows[0]?.t || '0');
    const presentes = parseInt(presRes.rows[0]?.t || '0');

    const dados = {
      empresa: nome, colaboradores: total, presentes, ausentes: total - presentes,
      atrasados: parseInt(atrasoRes.rows[0]?.t || '0'),
      hesMes: parseFloat(heRes.rows[0]?.t || '0'),
      pendencias: parseInt(pendRes.rows[0]?.t || '0'),
      ausencias7d: tend7d.rows.map((r: Record<string, string>) => parseInt(r.ausentes || '0')),
    };

    const prompt = 'Analise rapida de RH para ' + nome + '. Dados de hoje:\n' + JSON.stringify(dados, null, 2) + '\n\nIdentifique APENAS tendencias ou anomalias NAO obvias. Responda JSON array: [{"categoria":"tendencia|anomalia|recomendacao","severidade":"info|atencao|critico","titulo":"max 80 chars","mensagem":"max 300 chars"}]. Se nada relevante, retorne [].';

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

    if (!resp.ok) return;
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return;

    const insights: Array<{ categoria: string; severidade: 'info' | 'atencao' | 'critico'; titulo: string; mensagem: string }> = JSON.parse(text);
    if (!Array.isArray(insights) || insights.length === 0) return;

    for (const i of insights) {
      const iaKey = alertaKey('ia_' + i.categoria, empresaId, (i.titulo || '').slice(0, 30));
      if (await jaEnviouAlerta(iaKey)) continue;
      await marcarAlertaEnviado(iaKey);

      await dispararAlerta({
        empresaId, categoria: i.categoria || 'geral',
        severidade: i.severidade || 'info',
        titulo: (i.titulo || '').slice(0, 500),
        mensagem: (i.mensagem || '').slice(0, 2000),
        dados: { fonte: 'gemini' }, origem: 'ia',
      });
    }
  } catch (error) {
    console.error('[Alerta IA] Erro Gemini:', error);
  }
}

// =====================================================
// FUNCAO HELPER: obter empresa_id do colaborador
// =====================================================

export async function obterEmpresaDoColaborador(colaboradorId: number): Promise<number | null> {
  const res = await query('SELECT empresa_id FROM people.colaboradores WHERE id = $1', [colaboradorId]);
  return res.rows[0]?.empresa_id || null;
}

// =====================================================
// HOOKS PRONTOS PARA OS ENDPOINTS
// Todas sao async fire-and-forget (nao bloqueiam)
// =====================================================

export function hookRegistrarEntrada(colaboradorId: number, empresaId: number | null, statusAtraso: boolean): void {
  if (!empresaId) return;
  verificarAlertaAusencias(empresaId).catch(e => console.error('[Alerta RT] ausencia:', e));
  if (statusAtraso) {
    verificarAlertaAtrasos(empresaId).catch(e => console.error('[Alerta RT] atraso:', e));
  }
  verificarInsightsIA(empresaId).catch(e => console.error('[Alerta RT] ia:', e));
}

export function hookRegistrarSaida(empresaId: number | null): void {
  if (!empresaId) return;
  verificarAlertaHoraExtra(empresaId).catch(e => console.error('[Alerta RT] he saida:', e));
}

export function hookAprovarSolicitacao(empresaId: number | null, tipoSolicitacao: string): void {
  if (!empresaId) return;
  if (tipoSolicitacao === 'hora_extra') {
    verificarAlertaHoraExtra(empresaId).catch(e => console.error('[Alerta RT] he aprovacao:', e));
  }
}

export function hookCriarSolicitacao(empresaId: number | null): void {
  if (!empresaId) return;
  verificarAlertaSolicitacoesPendentes(empresaId).catch(e => console.error('[Alerta RT] pendentes:', e));
}
