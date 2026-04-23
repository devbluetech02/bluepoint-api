-- Migration: 028_admissao_historico_solicitacoes
--
-- A coluna solicitacoes_admissao.usuario_provisorio_id é INTENCIONALMENTE
-- não-UNIQUE: queremos manter histórico de múltiplas tentativas de admissão
-- por provisório (rejeições, readmissões, reconsiderações).
--
-- No estado atual do banco já é apenas BTREE simples (idx_solicitacoes_admissao_usuario_provisorio).
-- Este script é defensivo: remove qualquer índice UNIQUE sobre essa coluna
-- caso tenha sido adicionado em outro ambiente. Idempotente.

DO $$
DECLARE
  v_dropped INTEGER := 0;
  uniq_idx  TEXT;
BEGIN
  FOR uniq_idx IN
    SELECT i.relname
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE n.nspname = 'people'
      AND t.relname = 'solicitacoes_admissao'
      AND ix.indisunique
      AND NOT ix.indisprimary
      AND a.attname = 'usuario_provisorio_id'
      AND array_length(ix.indkey::int[], 1) = 1
  LOOP
    EXECUTE format('DROP INDEX people.%I', uniq_idx);
    v_dropped := v_dropped + 1;
    RAISE NOTICE 'Dropped UNIQUE index em usuario_provisorio_id: %', uniq_idx;
  END LOOP;
  RAISE NOTICE '028: % UNIQUE index(es) removido(s) de usuario_provisorio_id (esperado: 0 após primeira execução)', v_dropped;
END;
$$;
