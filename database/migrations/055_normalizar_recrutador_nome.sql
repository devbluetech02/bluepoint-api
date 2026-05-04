-- 055_normalizar_recrutador_nome.sql
--
-- Normaliza retroativamente o campo recrutador_nome em
-- people.recrutador_avaliacao_ia para o mesmo formato canônico que o
-- código TS usa em writes novos (UPPER + accent-strip + collapse-spaces).
--
-- Sem isso, avaliações antigas (ex.: "BÁRBARA OLIVEIRA") não bateriam
-- com o JWT normalizado do recrutador (que vira "BARBARA OLIVEIRA").
--
-- Idempotente: re-executar não muda nada após primeira aplicação.

UPDATE people.recrutador_avaliacao_ia
   SET recrutador_nome = TRANSLATE(
         UPPER(REGEXP_REPLACE(TRIM(recrutador_nome), '\s+', ' ', 'g')),
         'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
         'AAAAAEEEEIIIIOOOOOUUUUCAAAAAEEEEIIIIOOOOOUUUUC'
       )
 WHERE recrutador_nome <> TRANSLATE(
         UPPER(REGEXP_REPLACE(TRIM(recrutador_nome), '\s+', ' ', 'g')),
         'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
         'AAAAAEEEEIIIIOOOOOUUUUCAAAAAEEEEIIIIOOOOOUUUUC'
       );
