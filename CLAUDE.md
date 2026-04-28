# BluePoint API — Instruções para Claude

## Stack

- **Framework:** Next.js 16 TypeScript (API Routes)
- **Banco:** Aurora PostgreSQL 16 (schema `people`)
- **Deploy:** ECS Fargate + ECR (região `us-east-1`)
- **Storage:** MinIO (EC2 externo)
- **Cache:** ElastiCache Redis (TLS obrigatório)
- **Push:** OneSignal

---

## ⚠️ Ambiente local — LEIA ANTES DE OPERAR

A máquina é **Windows 11**. Bash e PowerShell estão disponíveis. As ferramentas necessárias para operar AWS estão instaladas **NATIVAMENTE** — **não use Docker** para rodar `aws` CLI nem `psql`, e **não peça ao usuário para instalar/colar credenciais**. Se você está prestes a dizer "X não existe", **verifique antes** com os comandos abaixo.

### Tooling pré-instalado

| Ferramenta | Caminho absoluto | Versão |
|---|---|---|
| `aws` CLI v2 | `C:\Program Files\Amazon\AWSCLIV2\aws.exe` | aws-cli/2.34.38 |
| `psql` | `C:\Program Files\PostgreSQL\16\bin\psql.exe` | PostgreSQL 16.13 |

Em terminais novos, ambos estão no `PATH` (basta `aws ...` e `psql ...`). Se a sessão atual foi aberta antes da instalação, use o caminho absoluto entre aspas.

### Credenciais AWS

Já configuradas em:
- `C:\Users\Christofer\.aws\credentials` (perfil `[default]`)
- `C:\Users\Christofer\.aws\config` (region `us-east-1`)

**Não peça** Access Key/Secret de novo. Para verificar:
```bash
aws sts get-caller-identity --region us-east-1
# Esperado: Account 873153257687, user Christofer
```

### Teste obrigatório antes de qualquer suposição

```powershell
& "C:\Program Files\Amazon\AWSCLIV2\aws.exe" --version
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" --version
& "C:\Program Files\Amazon\AWSCLIV2\aws.exe" sts get-caller-identity --region us-east-1
```

Se todos passarem, **siga em frente** — não invente que precisa de Docker pra rodar AWS CLI, não sugira `winget install`, não peça credenciais.

### Recursos AWS deste projeto

| Recurso | Valor |
|---|---|
| Account | `873153257687` |
| Região | `us-east-1` |
| RDS instance | `people-vpc-instance-1` |
| RDS host (writer) | `people-vpc.cluster-c2leeo4yeno6.us-east-1.rds.amazonaws.com` |
| Security Group | `sg-0675a3872bc414070` |
| ECS Cluster | `valeris-people` |
| ECS Service | `valeris-people-api` |
| ECR | `873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api` |
| API pública | `https://people-api.valerisapp.com.br` |
| Health | `https://people-api.valerisapp.com.br/api/v1/health` |

Procedimentos completos (com polling, fluxo de abrir/fechar RDS, troubleshooting):
- Banco: `.claude/commands/db.md`
- Deploy: `.claude/commands/deploy.md`

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
