BEGIN;

-- Rename tables inside schema bluepoint by removing bt_ prefix.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'bluepoint'
      AND tablename LIKE 'bt\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I RENAME TO %I',
      'bluepoint',
      rec.tablename,
      regexp_replace(rec.tablename, '^bt_', '')
    );
  END LOOP;
END $$;

-- Rename schema after table rename.
ALTER SCHEMA bluepoint RENAME TO people;

COMMIT;
