#!/bin/bash
# =====================================================
# Setup PostgreSQL + pgvector no servidor (10.1.3.216)
# Rode este script NO SERVIDOR onde deve ficar o banco vetorizado.
# Uso (na pasta do projeto):
#   sudo bash scripts/setup-pgvector-server.sh
# ou: chmod +x scripts/setup-pgvector-server.sh && sudo ./scripts/setup-pgvector-server.sh
# =====================================================
set -e

PG_VERSION="${PG_VERSION:-16}"
DB_NAME="${VECTOR_DB_NAME:-people_vector}"
DB_USER="${VECTOR_DB_USER:-people}"
DB_PASSWORD="${VECTOR_DB_PASSWORD:-Bluetech*9090}"

echo ">>> Instalando dependências e repositório PostgreSQL..."
apt-get update -qq
apt-get install -y -qq wget ca-certificates

# Repositório oficial PostgreSQL (pgdg)
if ! grep -q pgdg /etc/apt/sources.list.d/*.list 2>/dev/null; then
  wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
fi

echo ">>> Instalando PostgreSQL ${PG_VERSION} e pgvector..."
apt-get install -y -qq "postgresql-${PG_VERSION}" "postgresql-${PG_VERSION}-pgvector" postgresql-client

systemctl enable postgresql
systemctl start postgresql || true

# Detectar porta do cluster ativo (ex.: 5437 após upgrade para 18)
PG_PORT=$(pg_lsclusters 2>/dev/null | awk '/online/ {print $3; exit}')
if [ -z "$PG_PORT" ]; then
  PG_PORT=5432
fi
echo ">>> Usando cluster PostgreSQL na porta ${PG_PORT}"

# Se o cluster ativo for 18, instalar pgvector para 18
RUNNING_VER=$(pg_lsclusters 2>/dev/null | awk '/online/ {print $1; exit}')
if [ -n "$RUNNING_VER" ] && [ "$RUNNING_VER" != "$PG_VERSION" ]; then
  echo ">>> Instalando pgvector para a versão em execução (${RUNNING_VER})..."
  apt-get install -y -qq "postgresql-${RUNNING_VER}-pgvector" 2>/dev/null || true
fi

echo ">>> Criando usuário (se não existir)..."
if [ -n "$DB_PASSWORD" ]; then
  sudo -u postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'; END IF; END \$\$;" 2>/dev/null || true
else
  sudo -u postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN CREATE ROLE ${DB_USER} WITH LOGIN; END IF; END \$\$;" 2>/dev/null || true
fi

echo ">>> Criando banco ${DB_NAME} (se não existir)..."
sudo -u postgres psql -p "$PG_PORT" -t -A -c "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" 2>/dev/null | grep -q 1 || \
  sudo -u postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

sudo -u postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"

echo ">>> Habilitando extensão pgvector no banco ${DB_NAME}..."
sudo -u postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 -d "${DB_NAME}" -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"

echo ""
echo ">>> Concluído. PostgreSQL com pgvector está pronto."
echo ">>> Banco: ${DB_NAME} | Usuário: ${DB_USER} | Porta: ${PG_PORT}"
echo ">>> Para conectar (no próprio servidor): psql -h localhost -p ${PG_PORT} -U ${DB_USER} -d ${DB_NAME}"
echo ">>> Próximo passo: rodar o script de clone com VECTOR_DB_PORT=${PG_PORT}"
