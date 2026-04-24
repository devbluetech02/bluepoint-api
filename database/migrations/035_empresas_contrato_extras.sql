-- Migration: 035_empresas_contrato_extras
-- Campos por empresa consumidos pelo _AdmissaoContratoDialog. Ficam em
-- people.empresas pra permitir empresas em UFs diferentes dentro da mesma
-- instalação (cada uma com seu foro, signatário, dados bancários).
--
-- - cidade_foro: cidade/UF da comarca do foro (cláusula de eleição de foro).
-- - signatario_nome, signatario_cargo: quem assina o contrato PELA empresa.
-- - banco_pagador, agencia_pagadora, conta_pagadora: conta usada pro
--   pagamento de salário (quando o template menciona depósito).
--
-- Todos TEXT/VARCHAR, todos nullable — empresa pode não ter tudo configurado.

BEGIN;

ALTER TABLE people.empresas
  ADD COLUMN IF NOT EXISTS cidade_foro         VARCHAR(120),
  ADD COLUMN IF NOT EXISTS signatario_nome     VARCHAR(180),
  ADD COLUMN IF NOT EXISTS signatario_cargo    VARCHAR(120),
  ADD COLUMN IF NOT EXISTS banco_pagador       VARCHAR(120),
  ADD COLUMN IF NOT EXISTS agencia_pagadora    VARCHAR(20),
  ADD COLUMN IF NOT EXISTS conta_pagadora      VARCHAR(30);

COMMENT ON COLUMN people.empresas.cidade_foro IS
  'Cidade da comarca do foro. Alimenta {{CIDADE_FORO}} nos contratos desta empresa.';
COMMENT ON COLUMN people.empresas.signatario_nome IS
  'Nome da pessoa que assina os contratos pela empresa (gestor DP, sócio etc.).';
COMMENT ON COLUMN people.empresas.signatario_cargo IS
  'Cargo do signatário (Gerente de DP, Sócio-administrador, etc.).';
COMMENT ON COLUMN people.empresas.banco_pagador IS
  'Banco usado pelo pagamento de salário — alimenta {{BANCO_EMPRESA}}.';
COMMENT ON COLUMN people.empresas.agencia_pagadora IS
  'Agência da conta pagadora — alimenta {{AGENCIA_EMPRESA}}.';
COMMENT ON COLUMN people.empresas.conta_pagadora IS
  'Conta corrente pagadora — alimenta {{CONTA_EMPRESA}}.';

COMMIT;
