# Regra — Alterações no banco de dados

**Sempre perguntar ao usuário** se a alteração é no banco **AWS (produção)** ou no banco **local** antes de executar qualquer SQL.

Procedimento completo de acesso (incluindo abrir/fechar RDS, polling de status, reinício do ECS) está em `.claude/commands/db.md`.

## Pontos de atenção

- **Após qualquer operação que abra/feche o acesso público do RDS Aurora**, sempre reiniciar o container ECS — o pool de conexões fica com conexões mortas e a API para de responder.
- Migrations ficam em `database/migrations/` e devem ser numeradas sequencialmente (`040_...sql`, `041_...sql`).
- Toda migration deve ser **idempotente** (`CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`).
- A função `people.atualizar_timestamp()` existe no banco e é usada por triggers de `atualizado_em`.
