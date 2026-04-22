# Acesso ao Banco de Dados

## Regra OBRIGATÓRIA

**Sempre que o usuário pedir uma alteração no banco de dados, perguntar primeiro:**
> "Quer que eu faça isso no banco **AWS (produção)** ou no banco **local**?"

Só executar após a confirmação.

---

## Banco AWS (Aurora PostgreSQL — Produção)

O banco está dentro de uma VPC privada. Para acessar da máquina local, é necessário:

1. **Abrir acesso público temporariamente**
2. **Liberar o IP no Security Group**
3. **Executar o SQL**
4. **Fechar tudo**
5. **Reiniciar o container ECS** (o pool de conexões fica com conexões mortas após modificar o RDS)

### Credenciais

| Campo | Valor |
|---|---|
| Host (writer) | `people-vpc.cluster-c2leeo4yeno6.us-east-1.rds.amazonaws.com` |
| Host (instância) | `people-vpc-instance-1.c2leeo4yeno6.us-east-1.rds.amazonaws.com` |
| Porta | `5432` |
| Banco | `postgres` |
| Usuário | `postgres` |
| Senha | `postgres123` |
| Schema | `people` |
| Security Group | `sg-0675a3872bc414070` |

### Script completo de acesso

```bash
# 1. Pegar IP atual da máquina
MEU_IP=$(curl -s https://checkip.amazonaws.com)

# 2. Abrir RDS para acesso público
aws rds modify-db-instance \
  --db-instance-identifier people-vpc-instance-1 \
  --publicly-accessible \
  --apply-immediately \
  --region us-east-1

# 3. Liberar IP no Security Group
aws ec2 authorize-security-group-ingress \
  --group-id sg-0675a3872bc414070 \
  --protocol tcp --port 5432 \
  --cidr ${MEU_IP}/32 \
  --region us-east-1

# 4. Aguardar ficar disponível e resolver IP público da instância
aws rds wait db-instance-available --db-instance-identifier people-vpc-instance-1 --region us-east-1
RDS_IP=$(dig +short people-vpc-instance-1.c2leeo4yeno6.us-east-1.rds.amazonaws.com | grep -v amazonaws | tail -1)

# 5. Executar SQL
PGPASSWORD=postgres123 psql -h $RDS_IP -U postgres -d postgres -c "SEU SQL AQUI"

# 6. Fechar acesso público
aws rds modify-db-instance \
  --db-instance-identifier people-vpc-instance-1 \
  --no-publicly-accessible \
  --apply-immediately \
  --region us-east-1

# 7. Revogar IP do Security Group
aws ec2 revoke-security-group-ingress \
  --group-id sg-0675a3872bc414070 \
  --protocol tcp --port 5432 \
  --cidr ${MEU_IP}/32 \
  --region us-east-1

# 8. IMPORTANTE: Reiniciar o container ECS para limpar o pool de conexões
aws ecs update-service \
  --cluster valeris-people \
  --service valeris-people-api \
  --force-new-deployment \
  --region us-east-1
```

### Atenção

- O DNS da instância muda de IP a cada vez que o RDS é modificado — sempre resolver com `dig` na hora
- Após abrir/fechar o RDS, o pool de conexões do ECS fica com conexões mortas → **sempre reiniciar o container ECS depois**

---

## Banco Local (desenvolvimento)

| Campo | Valor |
|---|---|
| Host | `172.17.0.1` |
| Porta | `5437` |
| Banco | `bluepoint_vector` |
| Usuário | `bluepoint` |
| Senha | `Bluetech*9090` |

```bash
PGPASSWORD='Bluetech*9090' psql -h 172.17.0.1 -p 5437 -U bluepoint -d bluepoint_vector -c "SEU SQL AQUI"
```
