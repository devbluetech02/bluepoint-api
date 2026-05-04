-- Migration: 055_pagamento_pix
-- Persiste pagamentos PIX dos candidatos em dia de teste integrados via
-- API Sicoob (https://pix-sicoob-recebimento.bluetechfilms.com.br).
--
-- Fluxo: gestor aprova/reprova candidato -> handler grava valor_a_pagar.
-- Em seguida (UI mobile) gestor abre tela "Pagar candidato":
--   1. /pagamento/preview chama API.iniciar -> grava registro em
--      pagamento_pix com status='iniciado' + endToEndId + dest snapshot.
--   2. Gestor confirma -> /pagamento/confirmar chama API.confirmar
--      -> status='enviado' (ou 'falha' com ultimo_erro).
-- Webhook async pode atualizar pra 'sucesso' depois.
--
-- Idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS people.pagamento_pix (
  id                  BIGSERIAL PRIMARY KEY,
  agendamento_id      BIGINT      NOT NULL REFERENCES people.dia_teste_agendamento(id) ON DELETE RESTRICT,
  valor               NUMERIC(10,2) NOT NULL CHECK (valor > 0),
  chave_pix           TEXT        NOT NULL,
  tipo_chave          TEXT,                          -- cpf|cnpj|email|telefone|aleatoria
  cnpj_pagador        TEXT,                          -- CNPJ da empresa do agendamento (origem)
  end_to_end_id       TEXT,                          -- vem do iniciar/confirmar Sicoob
  idempotency_key     TEXT        NOT NULL UNIQUE,   -- previne dupla tentativa por agendamento
  status              VARCHAR(20) NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','iniciado','enviado','sucesso','falha','cancelado')),
  tentativas          INTEGER     NOT NULL DEFAULT 0,
  ultimo_erro         TEXT,
  iniciado_por        BIGINT,                        -- colaborador.id que abriu preview
  iniciado_em         TIMESTAMPTZ,
  confirmado_por      BIGINT,                        -- colaborador.id que clicou Confirmar
  confirmado_em       TIMESTAMPTZ,
  destino_nome        TEXT,                          -- snapshot do nome do beneficiario
  destino_documento   TEXT,                          -- CPF/CNPJ do destino
  destino_banco_ispb  TEXT,
  destino_agencia     TEXT,
  destino_conta       TEXT,
  resposta_iniciar    JSONB,
  resposta_confirmar  JSONB,
  criado_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pagamento_pix_agendamento
  ON people.pagamento_pix(agendamento_id);
CREATE INDEX IF NOT EXISTS idx_pagamento_pix_status
  ON people.pagamento_pix(status);
CREATE INDEX IF NOT EXISTS idx_pagamento_pix_e2e
  ON people.pagamento_pix(end_to_end_id) WHERE end_to_end_id IS NOT NULL;

-- 1 pagamento NÃO-FALHO por agendamento (evita pagar duas vezes).
-- Falhas podem ter retentativas (multiplos registros).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagamento_pix_agendamento_ativo
  ON people.pagamento_pix(agendamento_id)
  WHERE status IN ('iniciado','enviado','sucesso');

COMMENT ON TABLE  people.pagamento_pix IS
  'Pagamentos PIX dos candidatos em dia de teste via API Sicoob (BT). 1 registro por tentativa de pagamento; UNIQUE parcial impede 2 pagamentos vivos no mesmo agendamento.';
COMMENT ON COLUMN people.pagamento_pix.idempotency_key IS
  'UUID enviado no header Idempotency-Key da API Sicoob. Reutilizado entre /iniciar e /confirmar pra ligar os 2 passos do fluxo.';
COMMENT ON COLUMN people.pagamento_pix.status IS
  'pendente=record criado mas API.iniciar não chamada; iniciado=API.iniciar OK (endToEndId disponivel); enviado=API.confirmar OK (debito feito); sucesso=webhook confirmou liquidacao; falha=erro irrecuperavel; cancelado=admin cancelou.';

COMMIT;
