# Regra — Commit + push automático no GitHub

**Sempre que finalizar uma alteração de código que tenha passado no type-check/build**, fazer commit e push para `origin/main` automaticamente, sem precisar o usuário pedir. Vale tanto antes quanto depois do deploy — o objetivo é manter `main` sempre coerente com o que está em produção.

## Regras

- Não commitar arquivos com segredos (`.env`, credenciais).
- Mensagem de commit no padrão **Conventional Commits**, descrevendo o "porquê" da mudança.
- Nunca usar `--no-verify` nem desabilitar hooks.
- Nunca usar `git push --force` no `main`.
- Sempre incluir trailer:

  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
