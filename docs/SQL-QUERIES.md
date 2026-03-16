# Queries SQL por Endpoint

Este documento lista os **scripts SQL** executados no banco de dados por cada endpoint da API. O schema utilizado é `bluepoint` (ou tabelas no schema padrão quando não prefixado). Parâmetros dinâmicos são indicados como `$1`, `$2`, etc.

---

## Autenticação

### POST /autenticar

**1. Buscar usuário por email**
```sql
SELECT id, nome, email, cpf, senha_hash, tipo, status, foto_url, permite_ponto_mobile
FROM bluepoint.bt_colaboradores
WHERE email = $1;
```

**2. Buscar permissões do tipo do usuário**
```sql
SELECT p.codigo
FROM bt_tipo_usuario_permissoes tp
JOIN bt_permissoes p ON tp.permissao_id = p.id
WHERE tp.tipo_usuario = $1 AND tp.concedido = true
ORDER BY p.codigo;
```

---

## Empresas

### GET /listar-empresas

**Contagem (WHERE opcional: busca em nome_fantasia, razao_social, cnpj)**
```sql
SELECT COUNT(*) as total FROM bluepoint.bt_empresas
-- WHERE (nome_fantasia ILIKE $1 OR razao_social ILIKE $1 OR cnpj ILIKE $1)
;
```

**Listagem**
```sql
SELECT id, razao_social, nome_fantasia, cnpj, celular, cep, estado, cidade, bairro, rua, numero, created_at, updated_at
FROM bluepoint.bt_empresas
-- WHERE (nome_fantasia ILIKE $1 OR ...)
ORDER BY nome_fantasia ASC
LIMIT $n OFFSET $n+1;
```

### GET /obter-empresa/{id}

```sql
SELECT id, razao_social, nome_fantasia, cnpj, celular, cep, estado, cidade, bairro, rua, numero, created_at, updated_at
FROM bluepoint.bt_empresas
WHERE id = $1;
```

### POST /criar-empresa

**Verificar CNPJ existente**
```sql
SELECT id FROM bluepoint.bt_empresas WHERE cnpj = $1;
```

**Inserir**
```sql
INSERT INTO bluepoint.bt_empresas (
  razao_social, nome_fantasia, cnpj, celular, cep, estado, cidade, bairro, rua, numero
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id, razao_social, nome_fantasia, cnpj;
```

---

## Cargos

### GET /listar-cargos

**Contagem (WHERE opcional: busca em nome, cbo, descrição)**
```sql
SELECT COUNT(*) as total FROM bluepoint.bt_cargos
-- WHERE (LOWER(nome) LIKE $1 OR LOWER(cbo) LIKE $1 OR LOWER(descricao) LIKE $1)
;
```

**Listagem**
```sql
SELECT id, nome, cbo, descricao, salario_medio, valor_hora_extra_75, created_at, updated_at
FROM bluepoint.bt_cargos
-- WHERE ...
ORDER BY nome ASC
LIMIT $n OFFSET $n+1;
```

---

## Colaboradores

### GET /listar-colaboradores

**Contagem (WHERE montado dinamicamente: busca, departamento_id, status)**
```sql
SELECT COUNT(*) as total FROM bluepoint.bt_colaboradores c
-- WHERE (c.nome ILIKE $1 OR c.email ILIKE $1 OR c.cpf ILIKE $1)
--   AND c.departamento_id = $2 AND c.status = $3
;
```

**Listagem**
```sql
SELECT c.id, c.nome, c.email, c.cpf, c.tipo, c.cargo_id, cg.nome as cargo_nome, c.status, c.foto_url, c.data_admissao,
       c.empresa_id, c.vale_alimentacao, c.vale_transporte,
       d.id as departamento_id, d.nome as departamento_nome,
       j.id as jornada_id, j.nome as jornada_nome,
       e.nome_fantasia as empresa_nome_fantasia,
       CASE WHEN bf.id IS NOT NULL THEN true ELSE false END as tem_biometria,
       bf.data_cadastro as biometria_cadastrada_em
FROM bluepoint.bt_colaboradores c
LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
LEFT JOIN bluepoint.bt_jornadas j ON c.jornada_id = j.id
LEFT JOIN bluepoint.bt_empresas e ON c.empresa_id = e.id
LEFT JOIN bluepoint.bt_biometria_facial bf ON c.id = bf.colaborador_id
-- WHERE ... (dinâmico)
ORDER BY c.<orderBy> <orderDir>
LIMIT $n OFFSET $n+1;
```

**Parâmetros de benefícios (quando filtro mesReferencia)**  
```sql
SELECT horas_minimas_para_vale_alimentacao FROM bluepoint.bt_parametros_beneficios ORDER BY id DESC LIMIT 1;
```

### GET /obter-colaborador/{id}

**Colaborador**
```sql
SELECT c.*,
  cg.id as cargo_id, cg.nome as cargo_nome,
  d.id as departamento_id, d.nome as departamento_nome,
  j.id as jornada_id, j.nome as jornada_nome,
  e.nome_fantasia as empresa_nome_fantasia, e.cnpj as empresa_cnpj, e.estado as empresa_estado, e.cidade as empresa_cidade
FROM bluepoint.bt_colaboradores c
LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
LEFT JOIN bluepoint.bt_jornadas j ON c.jornada_id = j.id
LEFT JOIN bluepoint.bt_empresas e ON c.empresa_id = e.id
WHERE c.id = $1;
```

**Documentos do colaborador**
```sql
SELECT id, tipo, nome, url, data_upload
FROM bt_documentos_colaborador
WHERE colaborador_id = $1
ORDER BY data_upload DESC;
```

---

## Departamentos

### GET /listar-departamentos

**Contagem (WHERE opcional: status)**
```sql
SELECT COUNT(*) as total FROM bt_departamentos d
-- WHERE d.status = $1
;
```

**Listagem**
```sql
SELECT d.id, d.nome, d.descricao, d.status,
  g.id as gestor_id, g.nome as gestor_nome,
  (SELECT COUNT(*) FROM bluepoint.bt_colaboradores WHERE departamento_id = d.id AND status = 'ativo') as total_colaboradores
FROM bt_departamentos d
LEFT JOIN bluepoint.bt_colaboradores g ON d.gestor_id = g.id
-- WHERE ...
ORDER BY d.nome ASC
LIMIT $n OFFSET $n+1;
```

---

## Jornadas

### GET /listar-jornadas

**Contagem**
```sql
SELECT COUNT(*) as total FROM bluepoint.bt_jornadas j
WHERE j.excluido_em IS NULL
-- AND j.status = $1
;
```

**Listagem de jornadas**
```sql
SELECT j.* FROM bluepoint.bt_jornadas j
WHERE j.excluido_em IS NULL
-- AND j.status = $1
ORDER BY j.nome ASC
LIMIT $n OFFSET $n+1;
```

**Horários das jornadas (em lote)**
```sql
SELECT jornada_id, dia_semana, sequencia, quantidade_dias, dias_semana, periodos, folga
FROM bluepoint.bt_jornada_horarios
WHERE jornada_id = ANY($1)
ORDER BY jornada_id, sequencia NULLS LAST, dia_semana NULLS LAST;
```

---

## Marcações de Ponto

### GET /listar-marcacoes

**Contagem (WHERE dinâmico: colaborador_id, data_hora, tipo, departamento_id)**
```sql
SELECT COUNT(*) as total
FROM bluepoint.bt_marcacoes m
JOIN bluepoint.bt_colaboradores c ON m.colaborador_id = c.id
-- WHERE m.colaborador_id = $1 AND m.data_hora >= $2 AND m.data_hora <= $3::date + interval '1 day' AND m.tipo = $4 AND c.departamento_id = $5
;
```

**Listagem**
```sql
SELECT m.id, m.data_hora, m.tipo, m.latitude, m.longitude, m.endereco, m.metodo, m.foto_url, m.observacao,
  m.empresa_id, m.foi_ajustada, m.data_hora_original, m.ajustada_em,
  aj.id as ajustada_por_id, aj.nome as ajustada_por_nome,
  c.id as colaborador_id, c.nome as colaborador_nome,
  e.nome_fantasia as empresa_nome
FROM bluepoint.bt_marcacoes m
JOIN bluepoint.bt_colaboradores c ON m.colaborador_id = c.id
LEFT JOIN bluepoint.bt_empresas e ON m.empresa_id = e.id
LEFT JOIN bluepoint.bt_colaboradores aj ON m.ajustada_por = aj.id
-- WHERE ... (dinâmico)
ORDER BY m.data_hora DESC
LIMIT $n OFFSET $n+1;
```

---

## Solicitações

### GET /listar-solicitacoes

**Contagem (WHERE dinâmico: colaborador_id, tipo, status, data_solicitacao, gestor_id)**
```sql
SELECT COUNT(*) as total FROM bt_solicitacoes s
-- WHERE s.colaborador_id = $1 AND s.tipo = $2 AND s.status = $3 ...
;
```

**Listagem**
```sql
SELECT s.id, s.tipo, s.status, s.data_solicitacao, s.data_evento, s.descricao, s.data_aprovacao, s.criado_em,
  c.id as colaborador_id, c.nome as colaborador_nome,
  a.id as aprovador_id, a.nome as aprovador_nome,
  g.id as gestor_id, g.nome as gestor_nome,
  COALESCE(anx.total, 0) as anexos
FROM bt_solicitacoes s
JOIN bluepoint.bt_colaboradores c ON s.colaborador_id = c.id
LEFT JOIN bluepoint.bt_colaboradores a ON s.aprovador_id = a.id
LEFT JOIN bluepoint.bt_colaboradores g ON s.gestor_id = g.id
LEFT JOIN (
  SELECT solicitacao_id, COUNT(*) as total FROM bt_anexos GROUP BY solicitacao_id
) anx ON s.id = anx.solicitacao_id
-- WHERE ... (dinâmico)
ORDER BY s.data_solicitacao DESC
LIMIT $n OFFSET $n+1;
```

---

## Auditoria

### GET /auditoria/logs

**Contagem e listagem** (WHERE dinâmico: data_hora, modulo, acao, colaborador_id, busca)
```sql
SELECT COUNT(*) as total FROM bt_auditoria a LEFT JOIN bt_colaboradores c ON a.usuario_id = c.id
-- WHERE a.data_hora >= $1 AND a.data_hora < $2 AND a.modulo = $3 ...
;

SELECT a.id, a.data_hora AS "dataHora", a.usuario_id AS "usuarioId", c.nome AS "usuarioNome", c.email AS "usuarioEmail",
  a.acao, a.modulo, a.descricao AS "detalhes", a.ip, a.user_agent AS "userAgent",
  a.entidade_id AS "entidadeId", a.entidade_tipo AS "entidadeTipo", a.colaborador_id AS "colaboradorId", a.colaborador_nome AS "colaboradorNome"
FROM bt_auditoria a
LEFT JOIN bt_colaboradores c ON a.usuario_id = c.id
-- WHERE ...
ORDER BY a.data_hora DESC
LIMIT $n OFFSET $n+1;
```

---

## Convenções

- **Parâmetros:** `$1`, `$2`, ... são passados em array na ordem pelo cliente `query()` do `@/lib/db`.
- **WHERE dinâmico:** Várias listagens montam as cláusulas `WHERE` em código conforme filtros (busca, datas, status, etc.). O SQL acima mostra a estrutura; os filtros opcionais são aplicados com `conditions.push(...)` e `params.push(...)`.
- **Schema:** Tabelas estão em `bluepoint.bt_*` quando o código usa o prefixo `bluepoint.`; caso contrário pode ser schema padrão (ex.: `bt_departamentos`, `bt_solicitacoes`).

Para ver o SQL exato de qualquer endpoint, consulte o arquivo em `src/app/api/v1/<recurso>/route.ts` e procure por `query(` ou `await query(`.
