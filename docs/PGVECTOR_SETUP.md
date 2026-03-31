# Banco de dados vetorizado (PostgreSQL + pgvector)

Este guia descreve como criar uma cópia do banco atual do BluePoint em um PostgreSQL com a extensão **pgvector** no servidor (ex.: 10.1.3.216), com as mesmas tabelas, colunas e dados.

## Visão geral

1. **No servidor**: instalar PostgreSQL, extensão pgvector, criar o banco e o usuário.
2. **Clone dos dados**: fazer dump do banco atual (schema `people`) e restaurar no novo banco.

## Pré-requisitos

- Acesso SSH ao servidor (ex.: `bluserverco@10.1.3.216`).
- O banco de origem (variáveis `DB_*` do `.env`) acessível de onde você for rodar o script de clone (por exemplo, do próprio servidor, se a API e o PgBouncer estiverem na mesma rede).

---

## Passo 1: Instalar PostgreSQL + pgvector no servidor

Conecte no servidor e rode o script de setup (como root ou com `sudo`):

```bash
ssh bluserverco@10.1.3.216
cd /caminho/para/people_api   # ou clone o repositório

# Senha do usuário do banco (padrão no script: Bluetech*9090; pode sobrescrever)
# export VECTOR_DB_PASSWORD="Bluetech*9090"

# Versão do PostgreSQL (16 ou 17)
export PG_VERSION=16

# Nome do banco e usuário (opcional)
export VECTOR_DB_NAME=people_vector
export VECTOR_DB_USER=people

sudo bash scripts/setup-pgvector-server.sh
```

Se aparecer `command not found`, confira se o arquivo existe: `ls scripts/setup-pgvector-server.sh`. Use o caminho completo se precisar: `sudo bash /home/bluserverco/people_api/scripts/setup-pgvector-server.sh`.

O script:

- Instala PostgreSQL e o pacote `postgresql-{version}-pgvector`.
- Cria o usuário `people` (ou o valor de `DB_USER`).
- Cria o banco `people_vector` (ou o valor de `DB_NAME`).
- Cria a extensão `vector` no banco.

**Se o pacote pgvector não existir no repositório padrão**, use o repositório oficial:

```bash
# Exemplo para Ubuntu 22.04 e PostgreSQL 16
sudo apt install -y postgresql-16 postgresql-16-pgvector
# ou build from source: https://github.com/pgvector/pgvector#installation
```

---

## Passo 2: Clonar dados do banco atual para o vetorizado

O script `clone-db-to-vector.sh` faz **dump** do schema `people` do banco atual (usando `DB_*` do `.env`) e **restore** no banco vetorizado (usando `VECTOR_DB_*`).

### Rodar no próprio servidor (recomendado)

Se no servidor você tiver acesso ao banco de origem (por exemplo, host do PgBouncer na rede interna):

```bash
ssh bluserverco@10.1.3.216
cd /caminho/para/people_api

# .env já contém DB_* (origem)
export VECTOR_DB_HOST=localhost
export VECTOR_DB_PORT=5432
export VECTOR_DB_NAME=people_vector
export VECTOR_DB_USER=people
export VECTOR_DB_PASSWORD="Bluetech*9090"

./scripts/clone-db-to-vector.sh
```

### Rodar de outra máquina

Se você rodar de outro PC que tenha acesso aos dois bancos (origem e 10.1.3.216):

```bash
cd people_api

# Origem: já vem do .env (DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE)
# Destino: banco no servidor
export VECTOR_DB_HOST=10.1.3.216
export VECTOR_DB_PORT=5432
export VECTOR_DB_NAME=people_vector
export VECTOR_DB_USER=people
export VECTOR_DB_PASSWORD="Bluetech*9090"

./scripts/clone-db-to-vector.sh
```

No servidor, o PostgreSQL precisa aceitar conexões remotas (`listen_addresses`, `pg_hba.conf`) e a porta 5432 liberada no firewall.

---

## Variáveis de ambiente

### Origem (já usadas pela API)

| Variável      | Uso                          |
|---------------|------------------------------|
| `DB_HOST`     | Host do banco atual           |
| `DB_PORT`     | Porta                         |
| `DB_USERNAME` | Usuário                       |
| `DB_PASSWORD` | Senha                         |
| `DB_DATABASE` | Nome do banco                 |

### Destino (banco vetorizado)

| Variável             | Padrão             | Uso                    |
|----------------------|--------------------|------------------------|
| `VECTOR_DB_HOST`     | `localhost`        | Host do Postgres       |
| `VECTOR_DB_PORT`     | `5432`             | Porta                  |
| `VECTOR_DB_NAME`     | `people_vector` | Nome do banco         |
| `VECTOR_DB_USER`     | `people`       | Usuário                |
| `VECTOR_DB_PASSWORD` | —                  | Senha (recomendado)    |

---

## Usar o banco vetorizado na API

Para apontar a API para o banco vetorizado, altere o `.env`:

```env
DB_HOST=10.1.3.216
DB_PORT=5432
DB_DATABASE=people_vector
DB_USERNAME=people
DB_PASSWORD=Bluetech*9090
```

Ou, se a API rodar no mesmo servidor:

```env
DB_HOST=localhost
DB_PORT=5432
DB_DATABASE=people_vector
DB_USERNAME=people
DB_PASSWORD=Bluetech*9090
```

Reinicie a aplicação após alterar o `.env`.

---

## Popular embeddings (vetorizar todas as tabelas)

As colunas `embedding` (vector 1536) já existem em todas as tabelas do schema `people` (migration 007). Para preenchê-las com vetores reais (OpenAI text-embedding-3-small):

1. **Chave da OpenAI** no `.env`:
   ```env
   OPENAI_API_KEY=sk-...
   ```

2. **Conexão com o banco**: use o mesmo `.env` (DB_HOST, DB_PORT, etc.). Se rodar **fora do Docker** (ex.: no seu PC), use `DB_HOST=10.1.3.216` para alcançar o servidor. Se rodar **no servidor**, `DB_HOST=localhost` ou `10.1.3.216`.

3. **Executar o job** (na pasta do projeto):
   ```bash
   node scripts/populate-embeddings.mjs
   ```
   O script percorre todas as tabelas com coluna `embedding`, monta um texto por linha (a partir das colunas de texto/numéricas), chama a API de embeddings da OpenAI e grava o vetor no banco. Processa em lotes de 50 linhas; pode levar vários minutos conforme o volume de dados.

4. **Custo**: a API de embeddings da OpenAI é cobrada por token; consulte o plano da sua conta.

---

## Usar pgvector (embeddings / busca vetorial)

Com a extensão instalada, você pode criar colunas do tipo `vector` e índices para busca por similaridade:

```sql
-- Exemplo: coluna de embedding em uma tabela
ALTER TABLE people.colaboradores
ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Índice IVFFlat (ajuste lists conforme volume de dados)
CREATE INDEX ON people.colaboradores
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

Consulte a documentação do [pgvector](https://github.com/pgvector/pgvector) para funções (`<=>`, `<->`, etc.) e tipos de índice.

---

## Resumo dos arquivos

| Arquivo | Descrição |
|---------|-----------|
| `scripts/setup-pgvector-server.sh` | Instala Postgres + pgvector no servidor e cria banco/usuário. |
| `scripts/clone-db-to-vector.sh`    | Dump do schema `people` da origem e restore no banco vetorizado. |
| `scripts/populate-embeddings.mjs`   | Popula a coluna `embedding` em todas as tabelas (OpenAI text-embedding-3-small). |
| `docs/PGVECTOR_SETUP.md`           | Este guia. |
