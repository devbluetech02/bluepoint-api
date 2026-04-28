# Infraestrutura AWS — People API

## Recursos

| Recurso | Valor |
|---|---|
| URL pública | `https://people-api.valerisapp.com.br` |
| Health check | `https://people-api.valerisapp.com.br/api/v1/health` |
| ECR | `873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api` |
| ECS Cluster | `valeris-people` |
| ECS Service | `valeris-people-api` |
| RDS instance | `people-vpc-instance-1` |
| RDS host (writer) | `people-vpc.cluster-c2leeo4yeno6.us-east-1.rds.amazonaws.com` |
| RDS Security Group | `sg-0675a3872bc414070` |
| Região | `us-east-1` |
| Account | `873153257687` |

## Banco de dados (AWS Produção)

- **Host writer**: `people-vpc.cluster-c2leeo4yeno6.us-east-1.rds.amazonaws.com`
- **Usuário/Senha/Banco**: `postgres` / `postgres123` / `postgres`
- **Schema**: `people`
- **Acesso**: só dentro da VPC. Para acessar de fora, usar fluxo em `.claude/commands/db.md` (abrir publicly-accessible temporariamente).

## Banco local (desenvolvimento)

| Campo | Valor |
|---|---|
| Host | `172.17.0.1` |
| Porta | `5437` |
| Banco | `bluepoint_vector` |
| Usuário | `bluepoint` |
| Senha | `Bluetech*9090` |
