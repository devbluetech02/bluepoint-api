# Regra — Deploy automático

**Sempre que fizer qualquer alteração de código** que tenha passado no type-check/build, executar o deploy na AWS automaticamente, **sem precisar o usuário pedir**.

Passos completos do deploy estão em `.claude/commands/deploy.md` (build → ECR push → ECS force-new-deployment → health check).

## ⚠️ Regra crítica — não rode deploy concorrente

**Antes de iniciar qualquer deploy do `valeris-people-api`, verifique se já existe um deployment em andamento.** Múltiplos `force-new-deployment` simultâneos no mesmo serviço podem cancelar o anterior, causar tasks órfãs e deixar a imagem do ECR fora de sincronia com o que está rodando.

```bash
aws ecs describe-services \
  --cluster valeris-people \
  --services valeris-people-api \
  --region us-east-1 \
  --query "services[0].deployments[?rolloutState=='IN_PROGRESS'].[id,createdAt]" \
  --output text
```

Se a saída tiver **qualquer linha**, há deploy em curso — **não inicie outro**. Aguarde até ficar vazia (ou faça polling até `services[0].deployments | length(@) == 1` com `rolloutState == 'COMPLETED'`) e só então prossiga. Se for urgente e o deploy anterior estiver travado por muito tempo, reportar ao usuário em vez de forçar.

> **Importante:** este bloqueio é **só** para deploy do api. Pode rodar deploy de outros serviços (ex.: web) em paralelo — eles são independentes.

## Resumo rápido

```bash
# 0. Pré-checagem: nenhum deploy IN_PROGRESS no api
[ -z "$(aws ecs describe-services --cluster valeris-people --services valeris-people-api --region us-east-1 --query "services[0].deployments[?rolloutState=='IN_PROGRESS'].id" --output text)" ] || { echo "Deploy em andamento — abortando"; exit 1; }

# 1-4. Build → push → deploy
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 873153257687.dkr.ecr.us-east-1.amazonaws.com
docker build -t valeris-people-api . && \
docker tag valeris-people-api:latest 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest && \
docker push 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest && \
aws ecs update-service --cluster valeris-people --service valeris-people-api --force-new-deployment --region us-east-1
```

Pré-requisito: **Docker Desktop precisa estar rodando**. AWS CLI já está instalado nativamente — ver `People/.claude/rules/ambiente-aws.md`.
