# Stack — People API

| Camada | Tecnologia |
|---|---|
| Framework | Next.js 16 (TypeScript, App Router, API Routes) |
| Banco | Aurora PostgreSQL 16 (schema `people`) |
| Deploy | ECS Fargate + ECR (us-east-1) |
| Storage | MinIO (em EC2 externo) |
| Cache | ElastiCache Redis (TLS obrigatório) |
| Push | OneSignal |
| Tipos compartilhados | `src/types/index.ts` |
| Auth | JWT com `tipo` (admin/gestor/colaborador/etc.) + API Keys |

URL pública: `https://people-api.valerisapp.com.br`
