# Documentação do Banco de Dados — BluePoint

Sistema de gestão de ponto eletrônico. Schema principal: **`people`**.

---

## Índice

1. [Tipos enumerados (ENUMs)](#tipos-enumerados-enums)
2. [Tabelas principais](#tabelas-principais)
3. [Tabelas de apoio e configuração](#tabelas-de-apoio-e-configuração)
4. [Tabelas de módulos (migrations/scripts)](#tabelas-de-módulos-migrationsscripts)
5. [Views](#views)
6. [Outras tabelas referenciadas no código](#outras-tabelas-referenciadas-no-código)

---

## Tipos enumerados (ENUMs)

| Tipo | Valores |
|------|---------|
| `tipo_usuario` | `colaborador`, `gestor`, `gerente`, `supervisor`, `coordenador`, `admin` |
| `status_registro` | `ativo`, `inativo` |
| `tipo_marcacao` | `entrada`, `saida`, `almoco`, `retorno` |
| `metodo_marcacao` | `app`, `web`, `biometria` |
| `tipo_movimentacao_horas` | `credito`, `debito`, `compensacao`, `ajuste` |
| `status_solicitacao` | `pendente`, `aprovada`, `rejeitada`, `cancelada` |
| `tipo_solicitacao` | `ajuste_ponto`, `ferias`, `atestado`, `ausencia`, `outros` |
| `tipo_anexo` | `atestado`, `comprovante`, `documento`, `foto`, `outros` |
| `tipo_localizacao` | `matriz`, `filial`, `obra`, `cliente`, `outros` |
| `tipo_feriado` | `nacional`, `estadual`, `municipal`, `empresa` |
| `tipo_notificacao` | `sistema`, `solicitacao`, `marcacao`, `alerta`, `lembrete` |

---

## Tabelas principais

### departamentos

Departamentos da empresa.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| nome | VARCHAR(100) | NOT NULL | Nome do departamento |
| descricao | TEXT | | Descrição |
| gestor_id | INTEGER | FK → colaboradores(id) | Gestor responsável |
| status | status_registro | DEFAULT 'ativo' | ativo/inativo |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índices:** `status`, `gestor_id`.

---

### jornadas

Jornadas de trabalho (simples por dia da semana ou circular, ex.: 12x36).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| nome | VARCHAR(100) | NOT NULL | Nome da jornada |
| descricao | TEXT | | Descrição |
| carga_horaria_semanal | DECIMAL(5,2) | DEFAULT 44.00 | Carga em horas |
| tolerancia_entrada | INTEGER | DEFAULT 10 | Minutos de tolerância para entrada |
| tolerancia_saida | INTEGER | DEFAULT 10 | Minutos de tolerância para saída |
| status | status_registro | DEFAULT 'ativo' | ativo/inativo |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índice:** `status`.  
**Observação:** O código também usa `excluido_em` (soft delete) em algumas queries.

---

### jornada_horarios

Horários de cada dia (ou sequência) da jornada.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| jornada_id | INTEGER | NOT NULL, FK → jornadas(id) ON DELETE CASCADE | Jornada |
| dia_semana | SMALLINT | CHECK (0–6) | 0=domingo, 6=sábado (jornada simples) |
| sequencia | SMALLINT | | Ordem no ciclo (jornada circular) |
| quantidade_dias | SMALLINT | DEFAULT 1 | Dias do bloco (circular) |
| dias_semana | JSONB | DEFAULT '[]' | Ex.: [1,2,3,4,5] seg–sex (circular) |
| folga | BOOLEAN | DEFAULT FALSE | Dia de folga |
| periodos | JSONB | DEFAULT '[]' | Ex.: [{"entrada":"08:00","saida":"12:00"}, ...] |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índice:** `jornada_id`.

---

### colaboradores

Colaboradores/usuários do sistema.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| nome | VARCHAR(255) | NOT NULL | Nome completo |
| email | VARCHAR(255) | NOT NULL UNIQUE | E-mail de login |
| senha_hash | VARCHAR(255) | NOT NULL | Hash da senha |
| cpf | VARCHAR(14) | NOT NULL UNIQUE | CPF |
| rg | VARCHAR(20) | | RG |
| telefone | VARCHAR(20) | | Telefone |
| cargo_id | INTEGER | FK → cargos(id) | Cargo |
| tipo | tipo_usuario | DEFAULT 'colaborador' | Papel no sistema |
| departamento_id | INTEGER | FK → departamentos(id) | Departamento |
| jornada_id | INTEGER | FK → jornadas(id) | Jornada de trabalho |
| data_admissao | DATE | NOT NULL | Data de admissão |
| data_nascimento | DATE | | Data de nascimento |
| status | status_registro | DEFAULT 'ativo' | ativo/inativo |
| foto_url | TEXT | | URL da foto |
| face_registrada | BOOLEAN | DEFAULT FALSE | Biometria facial cadastrada |
| endereco_cep | VARCHAR(10) | | CEP |
| endereco_logradouro | VARCHAR(255) | | Logradouro |
| endereco_numero | VARCHAR(20) | | Número |
| endereco_complemento | VARCHAR(100) | | Complemento |
| endereco_bairro | VARCHAR(100) | | Bairro |
| endereco_cidade | VARCHAR(100) | | Cidade |
| endereco_estado | VARCHAR(2) | | UF |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índices:** `email`, `cpf`, `departamento_id`, `jornada_id`, `cargo_id`, `status`, `tipo`.  
**Observação:** O código também usa `empresa_id`, `vale_alimentacao`, `vale_transporte`, `permite_ponto_mobile` em várias rotas (colunas possivelmente adicionadas por migration).

---

### documentos_colaborador

Documentos anexados ao colaborador.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Colaborador |
| tipo | VARCHAR(50) | NOT NULL | Tipo do documento |
| nome | VARCHAR(255) | NOT NULL | Nome do arquivo |
| url | TEXT | NOT NULL | URL do arquivo |
| tamanho | INTEGER | | Tamanho em bytes |
| data_upload | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índice:** `colaborador_id`.

---

### marcacoes

Marcações de ponto.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Colaborador |
| data_hora | TIMESTAMP | NOT NULL | Data/hora da marcação |
| tipo | tipo_marcacao | NOT NULL | entrada, saida, almoco, retorno |
| latitude | DECIMAL(10,8) | | Latitude |
| longitude | DECIMAL(11,8) | | Longitude |
| endereco | TEXT | | Endereço textual |
| metodo | metodo_marcacao | DEFAULT 'web' | app, web, biometria |
| foto_url | TEXT | | URL da foto (se houver) |
| observacao | TEXT | | Observação |
| justificativa | TEXT | | Justificativa (ajustes) |
| criado_por | INTEGER | FK → colaboradores(id) | Quem criou (marcação manual) |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índices:** `colaborador_id`, `data_hora`, `tipo`, `(data_hora::date)`.  
**Observação:** O código também usa `empresa_id`, `foi_ajustada`, `data_hora_original`, `ajustada_por`, `ajustada_em` em listagens (colunas possivelmente adicionadas por migration).

---

### banco_horas

Movimentações do banco de horas (crédito/débito/compensação/ajuste).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Colaborador |
| data | DATE | NOT NULL | Data da movimentação |
| tipo | tipo_movimentacao_horas | NOT NULL | credito, debito, compensacao, ajuste |
| descricao | TEXT | | Descrição |
| horas | DECIMAL(5,2) | NOT NULL | Horas (positivo=crédito, negativo=débito) |
| saldo_anterior | DECIMAL(6,2) | NOT NULL DEFAULT 0 | Saldo antes |
| saldo_atual | DECIMAL(6,2) | NOT NULL DEFAULT 0 | Saldo depois |
| observacao | TEXT | | Observação |
| criado_por | INTEGER | FK → colaboradores(id) | Quem registrou |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índices:** `colaborador_id`, `data`, `tipo`.

---

### solicitacoes

Solicitações (ajuste de ponto, férias, atestado, ausência, etc.).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Solicitante |
| tipo | tipo_solicitacao | NOT NULL | Tipo da solicitação |
| status | status_solicitacao | DEFAULT 'pendente' | pendente, aprovada, rejeitada, cancelada |
| data_solicitacao | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| data_evento | DATE | | Data do evento |
| data_evento_fim | DATE | | Fim do período (férias, atestado) |
| descricao | TEXT | | Descrição |
| justificativa | TEXT | | Justificativa |
| dados_adicionais | JSONB | | Dados específicos por tipo |
| gestor_id | INTEGER | FK → colaboradores(id) | Gestor responsável (ex.: HE) |
| aprovador_id | INTEGER | FK → colaboradores(id) | Quem aprovou/rejeitou |
| data_aprovacao | TIMESTAMP | | Data da aprovação/rejeição |
| motivo_rejeicao | TEXT | | Motivo da rejeição |
| origem | VARCHAR(20) | DEFAULT 'manual' | Origem da solicitação |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índices:** `colaborador_id`, `tipo`, `status`, `data_solicitacao`, `aprovador_id`, `gestor_id`, `origem`.

---

### solicitacoes_historico

Histórico de alteração de status das solicitações.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| solicitacao_id | INTEGER | NOT NULL, FK → solicitacoes(id) ON DELETE CASCADE | Solicitação |
| status_anterior | status_solicitacao | | Status anterior |
| status_novo | status_solicitacao | NOT NULL | Novo status |
| usuario_id | INTEGER | FK → colaboradores(id) | Quem alterou |
| observacao | TEXT | | Observação |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índice:** `solicitacao_id`.

---

### anexos

Arquivos anexados (solicitações ou colaborador).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | FK → colaboradores(id) ON DELETE CASCADE | Colaborador (opcional) |
| solicitacao_id | INTEGER | FK → solicitacoes(id) ON DELETE CASCADE | Solicitação (opcional) |
| tipo | tipo_anexo | DEFAULT 'documento' | atestado, comprovante, documento, foto, outros |
| nome | VARCHAR(255) | NOT NULL | Nome do arquivo |
| url | TEXT | NOT NULL | URL do arquivo |
| tamanho | INTEGER | | Tamanho em bytes |
| descricao | TEXT | | Descrição |
| data_upload | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índices:** `colaborador_id`, `solicitacao_id`.

---

### localizacoes

Localizações permitidas para registro de ponto (geofence).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| nome | VARCHAR(100) | NOT NULL | Nome do local |
| tipo | tipo_localizacao | DEFAULT 'matriz' | matriz, filial, obra, cliente, outros |
| endereco_* | VARCHAR | | CEP, logradouro, número, complemento, bairro, cidade, estado |
| latitude | DECIMAL(10,8) | NOT NULL | Latitude |
| longitude | DECIMAL(11,8) | NOT NULL | Longitude |
| raio_permitido | INTEGER | DEFAULT 100 | Raio em metros |
| horarios_funcionamento | JSONB | | Horários de funcionamento |
| status | status_registro | DEFAULT 'ativo' | ativo/inativo |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índices:** `status`, `tipo`.

---

### localizacao_departamentos

Vinculação localização ↔ departamento (quais departamentos podem bater ponto em qual local).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| localizacao_id | INTEGER | NOT NULL, FK → localizacoes(id) ON DELETE CASCADE | Localização |
| departamento_id | INTEGER | NOT NULL, FK → departamentos(id) ON DELETE CASCADE | Departamento |
| UNIQUE(localizacao_id, departamento_id) | | | |

---

### feriados

Feriados (nacional, estadual, municipal, empresa).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| nome | VARCHAR(100) | NOT NULL | Nome do feriado |
| data | DATE | NOT NULL | Data |
| tipo | tipo_feriado | DEFAULT 'nacional' | nacional, estadual, municipal, empresa |
| recorrente | BOOLEAN | DEFAULT FALSE | Repete todo ano |
| abrangencia | VARCHAR(100) | | Ex.: "SP", "São Paulo" |
| descricao | TEXT | | Descrição |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índices:** `data`, `tipo`, `recorrente`.

---

### notificacoes

Notificações enviadas aos usuários.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| usuario_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Destinatário |
| tipo | tipo_notificacao | DEFAULT 'sistema' | sistema, solicitacao, marcacao, alerta, lembrete |
| titulo | VARCHAR(255) | NOT NULL | Título |
| mensagem | TEXT | NOT NULL | Corpo da mensagem |
| lida | BOOLEAN | DEFAULT FALSE | Se foi lida |
| data_envio | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| data_leitura | TIMESTAMP | | Quando foi lida |
| link | TEXT | | Link opcional |
| metadados | JSONB | | Dados extras |

**Índices:** `usuario_id`, `lida`, `data_envio`.

---

### refresh_tokens

Tokens de refresh para renovação do JWT.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| usuario_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Usuário |
| token | VARCHAR(500) | NOT NULL UNIQUE | Token |
| data_criacao | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| data_expiracao | TIMESTAMP | NOT NULL | Expiração |
| revogado | BOOLEAN | DEFAULT FALSE | Se foi revogado |
| revogado_em | TIMESTAMP | | Quando foi revogado |

**Índices:** `usuario_id`, `token`.

---

### tokens_recuperacao

Tokens para recuperação de senha (envio por e-mail).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| usuario_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Usuário |
| token | VARCHAR(255) | NOT NULL UNIQUE | Token de uso único |
| data_criacao | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| data_expiracao | TIMESTAMP | NOT NULL | Expiração |
| usado | BOOLEAN | DEFAULT FALSE | Se já foi utilizado |
| usado_em | TIMESTAMP | | Quando foi usado |

**Índices:** `token`, `usuario_id`.

---

### configuracoes_empresa

Dados cadastrais da empresa (um registro principal).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| razao_social | VARCHAR(255) | | Razão social |
| nome_fantasia | VARCHAR(255) | | Nome fantasia |
| cnpj | VARCHAR(18) | | CNPJ |
| endereco_* | VARCHAR | | CEP, logradouro, número, complemento, bairro, cidade, estado |
| telefone | VARCHAR(20) | | Telefone |
| email | VARCHAR(255) | | E-mail |
| logo_url | TEXT | | URL do logo |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

---

### configuracoes

Configurações gerais do sistema (chave/valor por categoria).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| categoria | VARCHAR(50) | NOT NULL | Ex.: ponto, notificacoes, geral |
| chave | VARCHAR(100) | NOT NULL | Chave (UNIQUE com categoria) |
| valor | TEXT | | Valor |
| descricao | TEXT | | Descrição |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índice:** `categoria`. **UNIQUE:** `(categoria, chave)`.

---

### biometria_facial

Dados de biometria facial (encoding e qualidade).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Colaborador |
| encoding | BYTEA | | Dados do encoding facial |
| qualidade | DECIMAL(3,2) | | 0.00 a 1.00 |
| foto_referencia_url | TEXT | | URL da foto de referência |
| data_cadastro | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índice UNIQUE:** `colaborador_id` (um registro por colaborador).

---

### auditoria

Logs de auditoria (ações no sistema).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| data_hora | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| usuario_id | INTEGER | FK → colaboradores(id) ON DELETE SET NULL | Quem executou |
| acao | VARCHAR(50) | NOT NULL | CREATE, UPDATE, DELETE, LOGIN, LOGOUT, etc. |
| modulo | VARCHAR(50) | NOT NULL | colaboradores, marcacoes, solicitacoes, etc. |
| descricao | TEXT | | Descrição |
| ip | VARCHAR(45) | | IP do cliente |
| user_agent | TEXT | | User-Agent |
| dados_anteriores | JSONB | | Estado anterior (se aplicável) |
| dados_novos | JSONB | | Estado novo (se aplicável) |
| metadados | JSONB | | Metadados extras |

**Índices:** `data_hora`, `usuario_id`, `acao`, `modulo`.  
**Observação:** O código também usa `entidade_id`, `entidade_tipo`, `colaborador_id`, `colaborador_nome` em algumas rotas (colunas possivelmente adicionadas por migration).

---

### colaborador_jornadas_historico

Histórico de jornadas atribuídas ao colaborador.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Colaborador |
| jornada_id | INTEGER | NOT NULL, FK → jornadas(id) ON DELETE CASCADE | Jornada |
| data_inicio | DATE | NOT NULL | Início da vigência |
| data_fim | DATE | | Fim da vigência (NULL = atual) |
| criado_por | INTEGER | FK → colaboradores(id) | Quem atribuiu |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

**Índices:** `colaborador_id`, `jornada_id`.

---

### tipos_solicitacao

Tipos de solicitação configuráveis (ajuste_ponto, ferias, atestado, etc.).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| codigo | VARCHAR(50) | NOT NULL UNIQUE | Código interno |
| nome | VARCHAR(100) | NOT NULL | Nome exibido |
| descricao | TEXT | | Descrição |
| requer_anexo | BOOLEAN | DEFAULT FALSE | Se exige anexo |
| campos_adicionais | JSONB | | Definição de campos extras |
| ativo | BOOLEAN | DEFAULT TRUE | Se está ativo |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |

---

## Tabelas de apoio e configuração

### parametros_hora_extra

Parâmetros globais de tolerância de hora extra.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| minutos_tolerancia | INTEGER | NOT NULL DEFAULT 10 | Minutos de tolerância |
| dias_permitidos_por_mes | INTEGER | NOT NULL DEFAULT 2 | Dias com tolerância por mês |
| ativo | BOOLEAN | DEFAULT TRUE | Parâmetro ativo |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_por | INTEGER | FK → colaboradores(id) | Quem atualizou |

---

### historico_tolerancia_hora_extra

Histórico de dias em que a tolerância de HE foi consumida por colaborador.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | NOT NULL, FK → colaboradores(id) ON DELETE CASCADE | Colaborador |
| data | DATE | NOT NULL | Data |
| minutos_hora_extra | INTEGER | NOT NULL | Minutos de HE no dia |
| consumiu_tolerancia | BOOLEAN | DEFAULT TRUE | Se consumiu a cota de tolerância |
| parametro_id | INTEGER | FK → parametros_hora_extra(id) | Parâmetro vigente |
| criado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| UNIQUE(colaborador_id, data) | | | Uma linha por colaborador/dia |

**Índices:** `colaborador_id`, `data`, `(colaborador_id, data)`.

---

### config_sistema

Configurações do sistema por empresa (geral, ponto, notificações, segurança, aparência).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| empresa_id | INTEGER | NOT NULL, FK → empresas(id) ON DELETE CASCADE, UNIQUE | Empresa |
| geral | JSONB | NOT NULL | nomeEmpresa, fusoHorario, formatoData, idioma, etc. |
| ponto | JSONB | NOT NULL | toleranciaEntrada, toleranciaSaida, permitirMarcacaoOffline, etc. |
| notificacoes | JSONB | NOT NULL | notificarAtrasos, emailNotificacoes, etc. |
| seguranca | JSONB | NOT NULL | tempoSessao, exigirSenhaForte, autenticacaoDoisFatores, etc. |
| aparencia | JSONB | NOT NULL | tema, corPrimaria, mostrarLogoSidebar, etc. |
| atualizado_em | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | |
| atualizado_por | INTEGER | FK → colaboradores(id) | Quem atualizou |

**Índice:** `empresa_id`.

---

## Tabelas de módulos (migrations/scripts)

### Gestão de Pessoas (`scripts/migrate-gestao-pessoas.sql`)

#### gestao_pessoas

Registros de gestão de pessoas (advertência, feedback, demissão, etc.).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | NOT NULL, FK → colaboradores(id) | Colaborador |
| tipo | VARCHAR(50) | NOT NULL, CHECK | advertencia, demissao, feedback_positivo, feedback_negativo |
| status | VARCHAR(50) | NOT NULL DEFAULT 'pendente', CHECK | pendente, em_andamento, concluido, cancelado |
| titulo | VARCHAR(255) | NOT NULL | Título |
| descricao | TEXT | NOT NULL | Descrição |
| responsavel_id | INTEGER | NOT NULL | Responsável pelo registro |
| data_registro | DATE | DEFAULT CURRENT_DATE | |
| data_conclusao | DATE | | Data de conclusão |
| criado_em | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | |
| atualizado_em | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | |

#### gestao_pessoas_reunioes

Reuniões vinculadas (1:1) a um registro de gestão de pessoas.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| gestao_pessoa_id | INTEGER | NOT NULL UNIQUE, FK → gestao_pessoas(id) ON DELETE CASCADE | Registro |
| data | DATE | NOT NULL | Data da reunião |
| hora | VARCHAR(5) | NOT NULL | Hora (HH:MM) |
| status | VARCHAR(20) | DEFAULT 'agendada', CHECK | agendada, realizada, cancelada |
| observacoes | TEXT | | Observações |
| criado_em | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | |
| atualizado_em | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | |

#### gestao_pessoas_participantes

Participantes de uma reunião de gestão de pessoas.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| reuniao_id | INTEGER | NOT NULL, FK → gestao_pessoas_reunioes(id) ON DELETE CASCADE | Reunião |
| colaborador_id | INTEGER | NOT NULL, FK → colaboradores(id) | Participante |
| UNIQUE(reuniao_id, colaborador_id) | | | |

#### gestao_pessoas_anexos

Anexos dos registros de gestão de pessoas.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| gestao_pessoa_id | INTEGER | NOT NULL, FK → gestao_pessoas(id) ON DELETE CASCADE | Registro |
| nome | VARCHAR(255) | NOT NULL | Nome do arquivo |
| tipo | VARCHAR(20) | NOT NULL | Tipo MIME ou categoria |
| tamanho | BIGINT | NOT NULL | Tamanho em bytes |
| url | TEXT | NOT NULL | URL de acesso |
| caminho_storage | TEXT | NOT NULL | Caminho no storage |
| criado_em | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() | |

---

### Exportação (`sql/modelos-exportacao.sql`)

#### modelos_exportacao

Modelos de exportação (folha, relatório, etc.).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| nome | VARCHAR(255) | NOT NULL | Nome do modelo |
| descricao | TEXT | | Descrição |
| ativo | BOOLEAN | NOT NULL DEFAULT true | Ativo |
| criado_em | TIMESTAMP | NOT NULL DEFAULT NOW() | |
| atualizado_em | TIMESTAMP | NOT NULL DEFAULT NOW() | |

#### codigos_exportacao

Códigos vinculados a um modelo de exportação.

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| modelo_id | INTEGER | NOT NULL, FK → modelos_exportacao(id) ON DELETE CASCADE | Modelo |
| codigo | VARCHAR(10) | NOT NULL | Código |
| descricao | TEXT | | Descrição |
| status_arquivo | VARCHAR(20) | NOT NULL DEFAULT 'valido' | Status no arquivo |
| status_econtador | VARCHAR(20) | NOT NULL DEFAULT 'valido' | Status e-contador |
| criado_em | TIMESTAMP | NOT NULL DEFAULT NOW() | |
| atualizado_em | TIMESTAMP | NOT NULL DEFAULT NOW() | |

**Índices:** `modelo_id`, `ativo` (em modelos_exportacao).

---

### Relatório mensal (criada via código em `relatorio-mensal/[id]/route.ts`)

#### relatorios_mensais

Relatórios mensais por colaborador (espelho de ponto mensal, assinatura, etc.).

| Coluna | Tipo | Restrições | Descrição |
|--------|------|------------|-----------|
| id | SERIAL | PK | Identificador |
| colaborador_id | INTEGER | NOT NULL | Colaborador |
| mes | INTEGER | NOT NULL, CHECK (1–12) | Mês |
| ano | INTEGER | NOT NULL, CHECK (2020–2100) | Ano |
| status | VARCHAR(20) | NOT NULL DEFAULT 'pendente' | Status do relatório |
| dias_trabalhados | INTEGER | DEFAULT 0 | Dias trabalhados |
| horas_trabalhadas | VARCHAR(10) | DEFAULT '00:00' | Total horas trabalhadas |
| horas_extras | VARCHAR(10) | DEFAULT '00:00' | Horas extras |
| banco_horas | VARCHAR(10) | DEFAULT '+00:00' | Saldo banco de horas |
| faltas | INTEGER | DEFAULT 0 | Número de faltas |
| atrasos | INTEGER | DEFAULT 0 | Número de atrasos |
| total_atrasos | VARCHAR(10) | DEFAULT '00:00' | Total tempo de atrasos |
| assinado_em | TIMESTAMP | | Data/hora da assinatura |
| dispositivo | VARCHAR(255) | | Dispositivo usado na assinatura |
| localizacao_gps | VARCHAR(60) | | Localização na assinatura |
| assinatura_imagem | TEXT | | Imagem da assinatura |
| ip_address | VARCHAR(45) | | IP na assinatura |
| criado_em | TIMESTAMP | DEFAULT NOW() | |
| atualizado_em | TIMESTAMP | DEFAULT NOW() | |
| UNIQUE(colaborador_id, mes, ano) | | | Um relatório por colaborador/mês/ano |

---

## Views

- **vw_colaboradores_completo** — Colaboradores com departamento, cargo e jornada (JOIN em cargos, departamentos, jornadas).
- **vw_marcacoes_hoje** — Marcações do dia atual com nome do colaborador e departamento.
- **vw_solicitacoes_pendentes** — Solicitações com status `pendente` com dados do colaborador e departamento.
- **vw_saldo_banco_horas** — Saldo atual de banco de horas por colaborador ativo.

---

## Outras tabelas referenciadas no código

Estas tabelas são usadas pela API em várias rotas; a definição pode estar em migrations ou scripts não listados neste documento. Para estrutura exata, consulte as migrations ou o código em `src/app/api/v1/`.

| Tabela | Uso resumido |
|--------|----------------|
| **empresas** | Empresas (razao_social, nome_fantasia, cnpj, celular, endereço). Colaboradores e dispositivos podem ter `empresa_id`. |
| **cargos** | Cargos (nome, cbo, descricao; opcional: salario_medio, valor_hora_extra_75, created_at, updated_at). Referenciado por colaboradores. |
| **dispositivos** | Dispositivos de ponto (codigo, nome, descricao, empresa_id, localizacao_id, total_registros, etc.). |
| **permissoes** | Permissões por código (codigo). Usado com tipo_usuario_permissoes para RBAC. |
| **tipo_usuario_permissoes** | Vincula tipo_usuario a permissao_id (concedido). |
| **api_keys** | Chaves de API para integrações (admin, write, read). |
| **api_keys_log** | Log de uso de API keys. |
| **prestadores** | Prestadores de serviço (PJ): razao_social, nome_fantasia, cnpj_cpf, tipo, email, telefone, status, etc. |
| **contratos_prestador** | Contratos vinculados a prestador (numero, descricao, data_inicio, data_fim, valor, forma_pagamento, status). |
| **nfes_prestador** | NFes de prestador (prestador_id, contrato_id, numero, serie, chave_acesso, data_emissao, valor, status, arquivo_url). |
| **alertas_inteligentes** | Alertas (regras + IA/Gemini) para ausências, atrasos, HE, pendências. |
| **limites_he_empresas** | Limites de hora extra por empresa. |
| **limites_he_departamentos** | Limites de HE por departamento. |
| **limites_he_gestores** | Limites de HE por gestor. |
| **solicitacoes_horas_extras** | Solicitações específicas de horas extras. |
| **custo_horas_extras** | Custos de HE. |
| **horas_extras_consolidado** | Dados consolidados de HE. |
| **liderancas_departamento** | Lideranças por departamento. |
| **periodos_ferias** | Períodos de férias. |
| **parametros_beneficios** | Parâmetros de benefícios (ex.: horas_minimas_para_vale_alimentacao). |
| **parametros_assiduidade** | Parâmetros de assiduidade. |
| **parametros_tolerancia_atraso** | Parâmetros de tolerância de atraso. |
| **atrasos_tolerados** | Registro de atrasos tolerados. |
| **historico_assiduidade** | Histórico de assiduidade. |
| **config_relatorio_personalizado** | Configuração de relatório personalizado. |
| **mapeamento_tabelas_colunas** | Mapeamento para embeddings/IA. |
| **fotos_reconhecimento** | Fotos usadas em reconhecimento (ex.: facial). |

---

## Triggers

O schema define a função `people.atualizar_timestamp()` e triggers **BEFORE UPDATE** que setam `atualizado_em = CURRENT_TIMESTAMP` nas tabelas: colaboradores, departamentos, jornadas, marcacoes, solicitacoes, localizacoes, feriados, configuracoes, configuracoes_empresa, biometria_facial, parametros_hora_extra, config_sistema.

---

## Dados iniciais (schema.sql)

- **configuracoes:** entradas padrão para categoria `ponto` (tolerâncias), `notificacoes`, `geral` (fuso, formato data/hora).
- **tipos_solicitacao:** ajuste_ponto, ferias, atestado, ausencia, outros.
- **feriados:** feriados nacionais 2026.
- **configuracoes_empresa:** um registro inicial (id = 1) vazio para preenchimento.

---

Para scripts SQL executados por endpoint, veja **[docs/SQL-QUERIES.md](SQL-QUERIES.md)**. Para criar/alterar schema, use os arquivos em `database/`, `scripts/` e `sql/`.
