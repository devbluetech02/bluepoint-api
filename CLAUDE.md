# BluePoint API — Instruções para Claude

## Stack

- **Framework:** Next.js 16 TypeScript (API Routes)
- **Banco:** Aurora PostgreSQL 16 (schema `people`)
- **Deploy:** ECS Fargate + ECR (região `us-east-1`)
- **Storage:** MinIO (EC2 externo)
- **Cache:** ElastiCache Redis (TLS obrigatório)
- **Push:** OneSignal

---

## Regra 1 — Deploy automático

**Sempre que fizer qualquer alteração de código**, executar o deploy na AWS automaticamente, sem precisar o usuário pedir.

Ver o passo a passo completo em `.claude/commands/deploy.md`.

Resumo rápido:
```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 873153257687.dkr.ecr.us-east-1.amazonaws.com
docker build -t valeris-people-api . && \
docker tag valeris-people-api:latest 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest && \
docker push 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest && \
aws ecs update-service --cluster valeris-people --service valeris-people-api --force-new-deployment --region us-east-1
```

---

## Regra 1.1 — Commit + push automático no GitHub

**Sempre que finalizar uma alteração de código que tenha passado no type-check/build**, fazer commit e push para `origin/main` automaticamente, sem precisar o usuário pedir. Vale tanto antes quanto depois do deploy — o objetivo é manter `main` sempre coerente com o que está em produção.

Regras:
- Não commitar arquivos com segredos (`.env`, credenciais).
- Mensagem de commit no padrão Conventional Commits, descrevendo o "porquê" da mudança.
- Nunca usar `--no-verify` nem desabilitar hooks.
- Nunca usar `git push --force` no `main`.

---

## Regra 2 — Alterações no banco de dados

**Sempre perguntar ao usuário** se a alteração é no banco **AWS (produção)** ou no banco **local** antes de executar qualquer SQL.

Ver credenciais e script completo de acesso em `.claude/commands/db.md`.

**IMPORTANTE:** Após qualquer operação que abra/feche o acesso público do RDS Aurora, **sempre reiniciar o container ECS** — o pool de conexões fica com conexões mortas e a API para de responder.

---

## Infraestrutura AWS

| Recurso | Valor |
|---|---|
| URL pública | `https://people-api.valerisapp.com.br` |
| ECR | `873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api` |
| ECS Cluster | `valeris-people` |
| ECS Service | `valeris-people-api` |
| RDS instância | `people-vpc-instance-1` |
| RDS Security Group | `sg-0675a3872bc414070` |
| Região | `us-east-1` |

---

## Banco de Dados (AWS Produção)

- **Host writer:** `people-vpc.cluster-c2leeo4yeno6.us-east-1.rds.amazonaws.com`
- **Usuário:** `postgres` / **Senha:** `postgres123` / **Banco:** `postgres`
- **Schema:** `people`
- Só acessível dentro da VPC — ver `.claude/commands/db.md` para o processo completo

---

## Migrations

Ficam em `database/migrations/`. Sempre criar arquivo novo numerado (ex: `011_...sql`) e aplicar no banco AWS conforme processo em `.claude/commands/db.md`.

---

## Padrões de código

- Respostas da API via helpers em `src/lib/api-response.ts`
- Autenticação via `withRole`, `withGestor`, `withAdmissao` em `src/lib/middleware.ts`
- Usuários provisórios usam JWT com `tipo: 'provisorio'` (8h, sem refresh)
- Push notifications via `src/lib/push-colaborador.ts` e `src/lib/push-provisorio.ts`
- Auditoria via `registrarAuditoria` em `src/lib/audit.ts` — não passar `colaboradorId` para usuários provisórios (não existem na tabela `colaboradores`)
