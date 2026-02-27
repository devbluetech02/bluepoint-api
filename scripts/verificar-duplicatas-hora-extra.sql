-- =====================================================
-- Verificação de duplicatas em solicitações de hora extra
-- Execute no banco para identificar possíveis duplicações
-- =====================================================
SET search_path TO bluepoint;

-- 1) Solicitações em bt_solicitacoes (tipo hora_extra): mesmo colaborador + mesma data
SELECT
  'bt_solicitacoes: mesmo colaborador e data' AS tipo_verificacao,
  colaborador_id,
  data_evento,
  COUNT(*) AS qtd,
  array_agg(id ORDER BY id) AS ids,
  array_agg(origem ORDER BY id) AS origens,
  array_agg(status ORDER BY id) AS status_list
FROM bt_solicitacoes
WHERE tipo = 'hora_extra'
GROUP BY colaborador_id, data_evento
HAVING COUNT(*) > 1
ORDER BY data_evento DESC, colaborador_id;

-- 2) Possível duplicata exata: mesmo colaborador + data + horaInicio + horaFim (dados_adicionais)
SELECT
  'bt_solicitacoes: mesmo colaborador, data e horário' AS tipo_verificacao,
  colaborador_id,
  data_evento,
  dados_adicionais->>'horaInicio' AS hora_inicio,
  dados_adicionais->>'horaFim' AS hora_fim,
  COUNT(*) AS qtd,
  array_agg(id ORDER BY id) AS ids
FROM bt_solicitacoes
WHERE tipo = 'hora_extra'
  AND dados_adicionais IS NOT NULL
  AND dados_adicionais ? 'horaInicio'
  AND dados_adicionais ? 'horaFim'
GROUP BY colaborador_id, data_evento, dados_adicionais->>'horaInicio', dados_adicionais->>'horaFim'
HAVING COUNT(*) > 1
ORDER BY data_evento DESC, colaborador_id;

-- 3) Resumo: total de HE por colaborador/data (incluindo canceladas/rejeitadas)
SELECT
  colaborador_id,
  data_evento,
  COUNT(*) AS total_solicitacoes,
  COUNT(*) FILTER (WHERE status = 'pendente') AS pendentes,
  COUNT(*) FILTER (WHERE status = 'aprovada') AS aprovadas,
  COUNT(*) FILTER (WHERE origem = 'automatica') AS automaticas,
  COUNT(*) FILTER (WHERE origem = 'manual') AS manuais
FROM bt_solicitacoes
WHERE tipo = 'hora_extra'
GROUP BY colaborador_id, data_evento
HAVING COUNT(*) > 1
ORDER BY data_evento DESC, colaborador_id
LIMIT 50;

-- 4) Solicitações na tabela legada bt_solicitacoes_horas_extras (outro fluxo)
SELECT
  'bt_solicitacoes_horas_extras: mesmo colaborador e data' AS tipo_verificacao,
  colaborador_id,
  data,
  COUNT(*) AS qtd,
  array_agg(id ORDER BY id) AS ids
FROM bt_solicitacoes_horas_extras
WHERE colaborador_id IS NOT NULL
GROUP BY colaborador_id, data
HAVING COUNT(*) > 1
ORDER BY data DESC, colaborador_id;
