-- =====================================================
-- 047 — Garantir que tipos de documento aceitam 'admissao'
-- =====================================================
-- O endpoint POST /api/v1/admissao/documentos só permite upload se o
-- tipo escolhido tiver 'admissao' no array `categorias`. Sem isso, o
-- formulário de pré-admissão não consegue persistir nada além dos tipos
-- já configurados (geralmente apenas ASO).
--
-- Esta migration garante que TODOS os 6 tipos padrão da tabela
-- (aso, epi, direcao_defensiva, cnh, nr35, outros) aceitem documentos
-- da pré-admissão. A reclassificação por IA acontece DEPOIS do upload
-- (ver `src/lib/admissao-classificar-doc.ts`), mas o upload precisa
-- ocorrer primeiro.
--
-- Idempotente: usa array_append condicional + DO blocks com checagem
-- de schema (defensivo contra databases que ainda têm coluna `categoria`
-- singular em vez de `categorias` array).
-- =====================================================

SET search_path TO people;

-- Se a coluna `categorias` (TEXT[]) não existir mas a antiga `categoria`
-- (VARCHAR) existir, migra os dados antes de continuar.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'people'
      AND table_name = 'tipos_documento_colaborador'
      AND column_name = 'categorias'
  ) THEN
    ALTER TABLE people.tipos_documento_colaborador
      ADD COLUMN categorias TEXT[] DEFAULT ARRAY['operacional']::TEXT[] NOT NULL;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'people'
        AND table_name = 'tipos_documento_colaborador'
        AND column_name = 'categoria'
    ) THEN
      UPDATE people.tipos_documento_colaborador
         SET categorias = ARRAY[categoria]::TEXT[]
       WHERE categoria IS NOT NULL;
    END IF;
  END IF;
END$$;

-- Adiciona 'admissao' nas categorias dos 6 tipos padrão se ainda não tiverem.
UPDATE people.tipos_documento_colaborador
   SET categorias = array_append(categorias, 'admissao')
 WHERE codigo IN ('aso', 'epi', 'direcao_defensiva', 'cnh', 'nr35', 'outros')
   AND NOT ('admissao' = ANY(categorias));

-- Diagnóstico: lista o estado final dos tipos relevantes (NOTICE no log do psql).
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT codigo, categorias
      FROM people.tipos_documento_colaborador
     WHERE codigo IN ('aso', 'epi', 'direcao_defensiva', 'cnh', 'nr35', 'outros')
     ORDER BY codigo
  LOOP
    RAISE NOTICE 'tipo=% categorias=%', rec.codigo, rec.categorias;
  END LOOP;
END$$;
