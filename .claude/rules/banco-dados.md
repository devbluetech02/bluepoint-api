# Regra — Alterações no banco de dados

**Sempre executar no banco AWS (produção).** O banco local (fallback) não existe mais e deve ser ignorado — não perguntar ao usuário qual banco usar.

Procedimento completo de acesso (incluindo abrir/fechar RDS, polling de status, reinício do ECS) está em `.claude/commands/db.md`.

## Pontos de atenção

- **Banco local/fallback não existe.** O `db.ts` tem um pool fallback (`172.17.0.1:5437`) que é legado e não funciona na AWS. Ignorar completamente — toda operação de banco é no Aurora (produção).
- **Após qualquer operação que abra/feche o acesso público do RDS Aurora**, sempre reiniciar o container ECS — o pool de conexões fica com conexões mortas e a API para de responder.
- Migrations ficam em `database/migrations/` e devem ser numeradas sequencialmente (`040_...sql`, `041_...sql`).
- Toda migration deve ser **idempotente** (`CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`).
- A função `people.atualizar_timestamp()` existe no banco e é usada por triggers de `atualizado_em`.
