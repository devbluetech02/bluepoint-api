# Acesso ao Banco de Dados

## Regra OBRIGATÓRIA

**Sempre que o usuário pedir uma alteração no banco de dados, perguntar primeiro:**
> "Quer que eu faça isso no banco **AWS (produção)** ou no banco **local**?"

Só executar após a confirmação.

---

## Tooling local (já instalado)

A máquina já tem AWS CLI v2 e psql 16 instalados (via winget) com credenciais configuradas em `~/.aws/`. Em sessões novas, ambos estão no `PATH`. Caso a sessão atual tenha sido aberta antes da instalação, usar caminhos absolutos:

| Ferramenta | Caminho absoluto | Versão |
|---|---|---|
| `aws` | `C:\Program Files\Amazon\AWSCLIV2\aws.exe` | aws-cli/2.34.38 |
| `psql` | `C:\Program Files\PostgreSQL\16\bin\psql.exe` | PostgreSQL 16.13 |

Verificar credenciais com:
```bash
aws sts get-caller-identity --region us-east-1
# Account: 873153257687, user: Christofer
```

---

## Banco AWS (Aurora PostgreSQL — Produção)

O banco está dentro de uma VPC privada. Para acessar da máquina local, é necessário:

1. **Abrir acesso público temporariamente**
2. **Liberar o IP no Security Group**
3. **Aguardar o RDS aplicar** (status `available` + `PubliclyAccessible=True`)
4. **Resolver o IP público da instância** (DNS muda a cada modify)
5. **Executar o SQL**
6. **Fechar o acesso público**
7. **Revogar o IP do Security Group**
8. **Reiniciar o container ECS** (pool de conexões fica com conexões mortas)

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
| RDS instance ID | `people-vpc-instance-1` |
| Security Group | `sg-0675a3872bc414070` |
| Região | `us-east-1` |

### Fluxo completo (testado em 2026-04-28)

Os comandos abaixo assumem PowerShell. Em Bash, basta substituir `$env:PGPASSWORD = "..."` por `export PGPASSWORD=...` e os blocos `& "C:\Program Files\..."` por `aws`/`psql` direto se o `PATH` estiver atualizado.

```powershell
# === 1. IP atual da máquina ===
$MEU_IP = (Invoke-WebRequest -Uri "https://checkip.amazonaws.com" -UseBasicParsing).Content.Trim()
Write-Output "IP local: $MEU_IP"

# === 2. Liberar IP no Security Group ===
aws ec2 authorize-security-group-ingress `
  --group-id sg-0675a3872bc414070 `
  --protocol tcp --port 5432 `
  --cidr "$MEU_IP/32" `
  --region us-east-1

# === 3. Abrir RDS para acesso público ===
aws rds modify-db-instance `
  --db-instance-identifier people-vpc-instance-1 `
  --publicly-accessible `
  --apply-immediately `
  --region us-east-1

# === 4. Polling até PubliclyAccessible=True ===
# IMPORTANTE: o status volta para "available" rapidamente, mas
# PubliclyAccessible só vira True após a propagação. Polling até confirmar.
for ($i=1; $i -le 30; $i++) {
  $info = aws rds describe-db-instances `
    --db-instance-identifier people-vpc-instance-1 `
    --region us-east-1 `
    --query "DBInstances[0].[DBInstanceStatus,PubliclyAccessible]" `
    --output text
  Write-Output "[$i/30] $info"
  if ($info -match "available\s+True") { break }
  Start-Sleep -Seconds 15
}

# === 5. Resolver IP público da instância ===
# (o DNS muda a cada modify — sempre resolver na hora)
$RDS_HOST = "people-vpc-instance-1.c2leeo4yeno6.us-east-1.rds.amazonaws.com"
$RDS_IP = (Resolve-DnsName -Name $RDS_HOST -Type A | Where-Object { $_.Type -eq "A" } | Select-Object -ExpandProperty IPAddress -First 1)
Write-Output "RDS IP: $RDS_IP"

# === 6. Executar SQL ===
$env:PGPASSWORD = "postgres123"
psql -h $RDS_IP -U postgres -d postgres -c "SELECT current_database(), current_user;"
# Para arquivos grandes:
# psql -h $RDS_IP -U postgres -d postgres -f caminho/script.sql

# === 7. Fechar acesso público do RDS ===
aws rds modify-db-instance `
  --db-instance-identifier people-vpc-instance-1 `
  --no-publicly-accessible `
  --apply-immediately `
  --region us-east-1

# === 8. Revogar IP do Security Group ===
aws ec2 revoke-security-group-ingress `
  --group-id sg-0675a3872bc414070 `
  --protocol tcp --port 5432 `
  --cidr "$MEU_IP/32" `
  --region us-east-1

# === 9. Reiniciar ECS (rolling, zero-downtime) ===
aws ecs update-service `
  --cluster valeris-people `
  --service valeris-people-api `
  --force-new-deployment `
  --region us-east-1

# === 10. Validar saúde da API ===
Invoke-WebRequest -Uri "https://people-api.valerisapp.com.br/api/v1/health" -UseBasicParsing | Select-Object -ExpandProperty Content
```

### Por que reiniciar o ECS?

Após qualquer modify-db-instance que afete acesso/network do RDS, o pool de conexões do container ECS fica com conexões mortas e a API começa a retornar 500. O `force-new-deployment` cria um task novo, espera ele ficar healthy, e só então mata o antigo — rolling deploy sem downtime.

---

## Banco Local (desenvolvimento)

| Campo | Valor |
|---|---|
| Host | `172.17.0.1` |
| Porta | `5437` |
| Banco | `bluepoint_vector` |
| Usuário | `bluepoint` |
| Senha | `Bluetech*9090` |

```powershell
$env:PGPASSWORD = "Bluetech*9090"
psql -h 172.17.0.1 -p 5437 -U bluepoint -d bluepoint_vector -c "SEU SQL AQUI"
```

---

## Migrations

Ficam em `database/migrations/`. Sempre criar arquivo novo numerado (ex: `040_...sql`) e aplicar no banco AWS via processo acima. Migrations devem ser idempotentes (`CREATE TABLE IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`) para tolerar reaplicação.

Para aplicar uma migration nova:
```powershell
psql -h $RDS_IP -U postgres -d postgres -f database/migrations/040_nome.sql
```
