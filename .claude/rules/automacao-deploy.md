# Regra — Deploy automático

**Sempre que fizer qualquer alteração de código** que tenha passado no type-check/build, executar o deploy na AWS automaticamente, **sem precisar o usuário pedir**.

Passos completos do deploy estão em `.claude/commands/deploy.md` (build → ECR push → ECS force-new-deployment → health check).

## Resumo rápido

```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 873153257687.dkr.ecr.us-east-1.amazonaws.com
docker build -t valeris-people-api . && \
docker tag valeris-people-api:latest 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest && \
docker push 873153257687.dkr.ecr.us-east-1.amazonaws.com/valeris-people-api:latest && \
aws ecs update-service --cluster valeris-people --service valeris-people-api --force-new-deployment --region us-east-1
```

Pré-requisito: **Docker Desktop precisa estar rodando**. AWS CLI já está instalado nativamente — ver `People/.claude/rules/ambiente-aws.md`.
