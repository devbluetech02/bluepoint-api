#!/bin/bash
# Aplica a migration 007: coluna embedding vector(1536) em todas as tabelas do schema people.
# Conexão com o banco vetorizado (mesmo do clone).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
MIGRATION="$ROOT_DIR/database/migrations/007_add_embedding_vector_all_tables.sql"

VECTOR_HOST="localhost"
VECTOR_PORT="5437"
VECTOR_USER="people"
VECTOR_DB="people_vector"
VECTOR_PASS="Bluetech*9090"

export PGPASSWORD="$VECTOR_PASS"

echo ">>> Aplicando migration: coluna embedding em todas as tabelas (schema people)..."
psql -h "$VECTOR_HOST" -p "$VECTOR_PORT" -U "$VECTOR_USER" -d "$VECTOR_DB" -v ON_ERROR_STOP=1 -f "$MIGRATION"

unset PGPASSWORD
echo ">>> Concluído. Todas as tabelas do schema people têm agora a coluna embedding vector(1536)."
echo ">>> Próximo passo: popular os embeddings (ex.: job que gera vetores a partir do texto de cada linha)."
