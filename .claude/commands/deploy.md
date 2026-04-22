# Deploy na AWS

Executa o build, push para o ECR e force-new-deployment no ECS.

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

**Sempre que fizer qualquer alteração de código**, rodar o deploy completo acima sem precisar o usuário pedir.
