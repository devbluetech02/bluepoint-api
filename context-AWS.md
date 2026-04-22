# Contexto de Infraestrutura AWS — valeris-people-api

## Status Atual

**A API está online e funcionando em produção.**

- **URL pública:** `https://people-api.valerisapp.com.br`
- **Health check:** `https://people-api.valerisapp.com.br/api/v1/health`
- **Região AWS:** `us-east-1` (N. Virginia) — escolhida por ser a região padrão da conta AWS e por ter o menor custo médio nos serviços utilizados (ECS, Aurora, ElastiCache, ECR). O ECR já existia em `us-east-1` antes desta sessão.

---

## Stack

- **Framework:** Next.js 16.1.5 (modo standalone — principalmente API, mas inclui a página `/docs` com documentação interativa servida como frontend)
- **Linguagem:** TypeScript
- **Porta interna:** `3003`
- **Runtime:** Node.js 20 Alpine (Docker)
- **Repositório ECR (API):** `873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api`
- **Repositório ECR (Face):** `873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-face-service`

---

## Arquitetura de Produção

```
Internet
   │
   ▼
Cloudflare (proxy + SSL) — people-api.valerisapp.com.br
   │ HTTPS 443
   ▼
ALB — valeris-people-alb-906760859.us-east-1.elb.amazonaws.com
   │  Listener 443 → ACM cert (people-api.valerisapp.com.br)
   │  Listener 80  → redirect 301 para HTTPS
   ▼
ECS Fargate — cluster: valeris-people / service: valeris-people-api
   │  2 vCPU / 4 GB RAM
   │  VPC: vpc-0be0173f52277b0fa (172.31.0.0/16)
   │
   ├── Container: api (porta 3003)
   │     Next.js — serve todas as rotas /api/v1/*
   │
   └── Container: face-service (porta 5000, sidecar)
         Python/FastAPI + InsightFace (buffalo_l)
         Acessado pela API em http://localhost:5000
         Env: FACE_SERVICE_URL=http://localhost:5000
```

---

## Banco de Dados — Aurora PostgreSQL

| Campo | Valor |
|---|---|
| **Cluster** | `people-vpc` |
| **Endpoint (writer)** | `people-vpc.cluster-c2leeo4yeno6.us-east-1.rds.amazonaws.com` |
| **Engine** | Aurora PostgreSQL 16.6 (Serverless v2) |
| **Capacidade** | 0.5–4 ACUs |
| **Porta** | `5432` |
| **Usuário** | `postgres` |
| **Senha** | `postgres123` |
| **Banco** | `postgres` |
| **Schema** | `people` |
| **IAM Auth** | Desabilitada (`DB_USE_IAM_AUTH=false`) |
| **Subnet group** | `people-subnet-group` (VPC interna) |
| **Security group** | `sg-0675a3872bc414070` (rds-people-sg) |
| **Acesso externo** | Desabilitado — só acessível de dentro da VPC |

**Observação:** O banco antigo (`people.cluster-c2leeo4yeno6.us-east-1.rds.amazonaws.com`) foi criado sem VPC e está inacessível. O novo cluster `people-vpc` foi criado dentro da VPC com todos os dados migrados (666 colaboradores, 17 empresas).

Para acessar o banco temporariamente pela máquina local (necessário para migrations/dumps):
1. `aws rds modify-db-instance --db-instance-identifier people-vpc-instance-1 --publicly-accessible --apply-immediately --region us-east-1`
2. `aws ec2 authorize-security-group-ingress --group-id sg-0675a3872bc414070 --protocol tcp --port 5432 --cidr <SEU_IP>/32 --region us-east-1`
3. Conectar em `people-vpc-instance-1.c2leeo4yeno6.us-east-1.rds.amazonaws.com:5432`
4. Após uso: reverter `--no-publicly-accessible` e revogar a regra do SG

---

## Redis — ElastiCache Serverless

| Campo | Valor |
|---|---|
| **Nome** | `people-redis` |
| **Endpoint** | `people-redis-ogduzk.serverless.use1.cache.amazonaws.com` |
| **Porta** | `6379` |
| **TLS** | Obrigatório (`REDIS_TLS=true`) |
| **Autenticação** | Sem senha |
| **Security group** | `sg-04b43c728b1d09c4b` (redis-people-sg) |

**Importante:** ElastiCache Serverless usa TLS obrigatório na porta 6379. Conectar sem TLS estabelece TCP mas trava no `ping()` indefinidamente (sem TLS handshake). Sempre usar `REDIS_TLS=true`.

---

## MinIO — Object Storage

| Campo | Valor |
|---|---|
| **Endpoint** | `ec2-54-83-103-18.compute-1.amazonaws.com` |
| **Porta** | `9000` |
| **Access Key** | `admin` |
| **Secret Key** | `SenhaForte123!` |
| **SSL** | `false` |
| **Bucket** | `people` |
| **Hospedagem** | EC2 (IP público fixo) |

---

## Face Service (Reconhecimento Facial)

- **Tecnologia:** Python 3.11 + FastAPI + InsightFace (modelo `buffalo_l`)
- **Deploy:** Sidecar no mesmo ECS task da API principal
- **Porta:** `5000` (acessível via `localhost` pela API)
- **Comunicação:** `FACE_SERVICE_URL=http://localhost:5000`
- **Health check:** `http://localhost:5000/health` (startPeriod: 90s para carregar modelos)
- **ECR:** `873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-face-service:latest`

---

## SSL / Cloudflare

| Campo | Valor |
|---|---|
| **Domínio** | `people-api.valerisapp.com.br` |
| **Proxy** | Cloudflare (modo: **Full**) |
| **Certificado origem** | ACM — `arn:aws:acm:us-east-1:873153257687:certificate/9b786995-34ad-454f-a470-9f07b0c5f8d8` |
| **ALB listener 443** | HTTPS com cert ACM |
| **ALB listener 80** | Redirect 301 → HTTPS |

**Cloudflare deve estar em modo Full** (não Flexible, não Full Strict). Flexible causa 521 porque nosso listener 80 redireciona para 443.

---

## Rede / VPC

| Recurso | ID |
|---|---|
| VPC | `vpc-0be0173f52277b0fa` (172.31.0.0/16) |
| ALB SG | `sg-0accd5d1441ca75f6` (alb-people-sg) — 80/443 abertos |
| ECS SG | `sg-0862bd076f75924dd` (ecs-people-sg) — porta 3003 do ALB SG + 172.31.0.0/16 |
| RDS SG | `sg-0675a3872bc414070` (rds-people-sg) — 5432 da VPC + ECS SG |
| Redis SG | `sg-04b43c728b1d09c4b` (redis-people-sg) — 6379/6380 da VPC + ECS SG |
| Subnets | 5 subnets públicas em us-east-1a/b/c/d/f |

---

## IAM

| Role | Uso |
|---|---|
| `ecsTaskExecutionRole` | Pull de imagem ECR + logs CloudWatch |
| `ecsTaskRole-valeris-people` | Permissões da aplicação (RDS, CloudWatch Logs) |

---

## Variáveis de Ambiente (ECS — task def atual: v5)

```
NODE_ENV=production
PORT=3003
AWS_REGION=us-east-1
DB_HOST=people-vpc.cluster-c2leeo4yeno6.us-east-1.rds.amazonaws.com
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres123
DB_DATABASE=postgres
DB_USE_IAM_AUTH=false
REDIS_HOST=people-redis-ogduzk.serverless.use1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_TLS=true
FACE_SERVICE_URL=http://localhost:5000
MINIO_ENDPOINT=ec2-54-83-103-18.compute-1.amazonaws.com
MINIO_PORT=9000
MINIO_ACCESS_KEY=admin
MINIO_SECRET_KEY=SenhaForte123!
MINIO_USE_SSL=false
OPENAI_API_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=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
OPENAI_MODEL=google/gemini-2.0-flash-001
```

---

## Logs

```bash
# Tail em tempo real
aws logs tail /ecs/valeris-people-api --follow --region us-east-1

# Só da API
aws logs tail /ecs/valeris-people-api --follow --region us-east-1 --log-stream-name-prefix "api/"

# Só do face service
aws logs tail /ecs/valeris-people-api --follow --region us-east-1 --log-stream-name-prefix "face/"
```

---

## Deploy — Como publicar nova versão

```bash
# 1. Build
docker build -t valeris-people-api .

# 2. Login ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 873153257687.dkr.ecr.us-east-1.amazonaws.com

# 3. Tag e push
docker tag valeris-people-api:latest \
  873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest
docker push 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest

# 4. Novo deploy (usa a task def atual)
aws ecs update-service \
  --cluster valeris-people \
  --service valeris-people-api \
  --force-new-deployment \
  --region us-east-1
```

Para o face-service, substituir `valeris-people-api` por `valeris-face-service` nos passos 1–3 (build dentro de `./face-service`).

---

## Problemas Resolvidos (histórico desta sessão)

| Problema | Causa | Solução |
|---|---|---|
| App Runner health check falhando | Pool pg sem `error` handler — process crashava ao tentar conexão com DB inacessível | Adicionado `pool.on('error')`, `min:0`, `allowExitOnIdle:false`, circuit breaker 60s |
| `password authentication failed` | Código usava IAM auth em produção, Aurora novo sem IAM habilitado | Adicionado env `DB_USE_IAM_AUTH=false` para controlar via env |
| Redis travando `ping()` por 60s+ | ElastiCache Serverless exige TLS; conexão sem TLS estabelece TCP mas trava | Adicionado `REDIS_TLS=true` e opção `tls: {rejectUnauthorized:false}` no ioredis |
| `/api/v1/health` retornando 504 | Endpoint faz DB check — timeout do ALB era 5s, menor que o tempo da conexão inicial | Aumentado timeout ALB para 10s; health check do ALB mudado para `/docs` (static) |
| ALB health check `Target.Timeout` | SG do ECS só permitia tráfego do ALB SG, mas faltava regra para VPC CIDR | Adicionado `172.31.0.0/16` no ECS SG |
| Aurora inacessível da VPC | Cluster antigo criado sem VPC (EC2-Classic) | Criado novo cluster `people-vpc` dentro da VPC com subnet group |
| 521 no Cloudflare | Cloudflare em modo Full tentando HTTPS, ALB só tinha porta 80 | Emitido cert ACM, adicionado listener 443 no ALB, redirect 80→443 |
| Migração de dados | Schema `people` inexistente no Aurora novo | Dump do banco local (`localhost:5437`) restaurado via acesso público temporário |
| App Runner descontinuado | AWS encerrando App Runner em 30/04/2026 | Migrado para ECS Fargate + ALB |
