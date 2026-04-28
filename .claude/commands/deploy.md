# Deploy na AWS

Build da imagem Docker, push para o ECR e force-new-deployment no ECS.

## Pré-requisitos

| Requisito | Verificação |
|---|---|
| Docker Desktop **rodando** | `docker version` retorna server version |
| AWS CLI v2 instalado | `C:\Program Files\Amazon\AWSCLIV2\aws.exe --version` |
| Credenciais AWS válidas | `aws sts get-caller-identity --region us-east-1` retorna Account `873153257687` |

Se o Docker daemon não estiver rodando, abrir o Docker Desktop e aguardar o ícone ficar verde (~30-60s).

## Recursos

| Recurso | Valor |
|---|---|
| ECR | `873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api` |
| ECS Cluster | `valeris-people` |
| ECS Service | `valeris-people-api` |
| URL pública | `https://people-api.valerisapp.com.br` |
| Health check | `https://people-api.valerisapp.com.br/api/v1/health` |
| Região | `us-east-1` |

## Como fazer o deploy

```bash
# 1. Login no ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 873153257687.dkr.ecr.us-east-1.amazonaws.com

# 2. Build
docker build -t valeris-people-api .

# 3. Tag e push
docker tag valeris-people-api:latest 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest
docker push 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest

# 4. Force new deployment
aws ecs update-service --cluster valeris-people --service valeris-people-api --force-new-deployment --region us-east-1

# 5. Aguardar estabilizar e testar
aws ecs wait services-stable --cluster valeris-people --services valeris-people-api --region us-east-1
curl -s https://people-api.valerisapp.com.br/api/v1/health
```

## Regra

**Sempre que fizer qualquer alteração de código** (que tenha passado no type-check/build), rodar o deploy completo acima sem precisar o usuário pedir.

## Troubleshooting

**Docker daemon não está rodando**
```
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
```
→ Abrir Docker Desktop pelo menu Iniciar e aguardar ficar verde.

**Push do ECR falhando com `no basic auth credentials`**
→ Refazer o passo 1 (`aws ecr get-login-password ... | docker login ...`).

**Health check com 500 após deploy**
→ Pool de conexões do container pode estar com conexões mortas se houve mexida recente em RDS. Rodar mais um `force-new-deployment`.
