# BluePoint API

API REST para sistema de gestão de ponto eletrônico.

## Tecnologias

- **Next.js 16** - Framework React com API Routes
- **React 19** - Interface e componentes
- **TypeScript** - Tipagem estática
- **PostgreSQL** - Banco de dados
- **Redis** - Cache e sessões
- **MinIO** - Object storage (anexos, fotos)
- **Docker** - Containerização
- **Face Service (Python/InsightFace)** - Reconhecimento facial (microserviço opcional)
- **OneSignal** - Push notifications
- **Google Gemini** - IA para alertas inteligentes (opcional)
- **Cloudflare Tunnel** - Exposição segura (opcional)

## URLs

| Ambiente | URL |
|----------|-----|
| Produção | https://bluepoint-api.bluetechfilms.com.br |
| Local | http://localhost:3003 |

## Instalação

### Pré-requisitos

- Docker e Docker Compose
- Node.js 20+ (apenas para desenvolvimento local)

### Configuração

1. Clone o repositório
2. Copie o arquivo de ambiente:
```bash
cp .env.example .env
```

3. Configure as variáveis no `.env`

4. Suba os containers:
```bash
docker compose up -d --build
```

**Desenvolvimento local (sem Docker):** instale dependências com `npm install`, configure o `.env` com banco e Redis acessíveis, e execute `npm run dev`. A API sobe na porta definida em `API_PORT` (ex.: 3003) ou 3000.

### Variáveis de Ambiente

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `API_PORT` | Porta da API | `3003` |
| `DB_HOST` | Host do PostgreSQL/PgBouncer | `pgbouncer` ou `localhost` |
| `DB_PORT` | Porta do PostgreSQL | `6432` ou `5432` |
| `DB_USERNAME` | Usuário do banco | `bluepoint` |
| `DB_PASSWORD` | Senha do banco | `***` |
| `DB_DATABASE` | Nome do banco | `bluepoint` |
| `DB_SSLMODE` | SSL do banco | `disable` |
| `REDIS_HOST` | Host do Redis (cache) | `redis` ou `localhost` |
| `REDIS_PORT` | Porta do Redis | `6379` |
| `REDIS_PASSWORD` | Senha do Redis (opcional) | `` |
| `JWT_SECRET` | Chave secreta JWT | `chave-secreta-forte` |
| `JWT_EXPIRES_IN` | Expiração do token | `24h` |
| `JWT_REFRESH_EXPIRES_IN` | Expiração do refresh | `7d` |
| `SMTP_*`, `EMAIL_FROM` | Email (recuperação de senha, alertas) | - |
| `BASE_URL` | URL base da aplicação | `http://localhost:3003` |
| `MINIO_*` | MinIO (endpoint, porta, chaves, bucket) | - |
| `BIOMETRIA_API_TOKEN` | Token fixo para biometria (sistemas externos) | `bp_bio_...` |
| `PORTAL_COLABORADOR_URL`, `PORTAL_COLABORADOR_API_KEY` | Integração Portal do Colaborador | - |
| `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY` | OneSignal (push) | - |
| `GEMINI_API_KEY` | Google Gemini (alertas inteligentes) | - |
| `FACE_SERVICE_URL` | Microserviço de reconhecimento facial (Docker) | `http://face-service:5000` |

## Cache (Redis)

A API utiliza Redis para cacheamento de dados, melhorando significativamente a performance.

### TTLs Configurados

| Tipo | Duração | Uso |
|------|---------|-----|
| SHORT | 1 minuto | Dados frequentemente alterados |
| MEDIUM | 5 minutos | Dados moderadamente estáveis |
| LONG | 1 hora | Dados estáveis (cargos, empresas) |
| VERY_LONG | 24 horas | Dados raramente alterados |

### Endpoints com Cache

- `GET /listar-cargos` - Cache de 1 hora
- `GET /listar-jornadas` - Cache de 5 minutos
- `GET /listar-empresas` - Cache de 1 hora
- Outros listagens estáveis utilizam cache quando configurado

### Invalidação Automática

O cache é automaticamente invalidado quando:
- Um registro é criado
- Um registro é atualizado
- Um registro é excluído

### Health Check

```
GET /api/v1/health
```

Retorna status do banco de dados e Redis:

```json
{
  "status": "healthy",
  "services": {
    "database": {
      "status": "connected",
      "pool": { "total": 20, "idle": 18, "waiting": 0 }
    },
    "redis": {
      "status": "connected",
      "keys": 15,
      "memory": "1.55M"
    }
  }
}
```

## Autenticação

A API suporta **dois métodos de autenticação**, ambos enviados pelo mesmo header `Authorization`:

```
Authorization: Bearer <token>
```

O middleware detecta automaticamente o tipo de token:
- Se contém `.` (pontos) → **JWT** (ex: `eyJhbGciOi...`)
- Se contém `_` e tem 36+ caracteres → **API Key** (ex: `app_vendedores_803b18...`)

### JWT Token (Usuários)

Para acesso autenticado por usuários logados. Obtido via `/autenticar`.

```bash
# 1. Obter token
curl -X POST https://bluepoint-api.bluetechfilms.com.br/api/v1/autenticar \
  -H "Content-Type: application/json" \
  -d '{"email": "usuario@empresa.com", "senha": "senha123"}'

# 2. Usar o token JWT
curl -X GET https://bluepoint-api.bluetechfilms.com.br/api/v1/listar-colaboradores \
  -H "Authorization: Bearer eyJhbGciOi..."
```

### API Key (Integrações e Dispositivos)

Para integrações externas e dispositivos. Não expira. Gerenciada via painel admin.

```bash
# Usar API Key no mesmo header Authorization
curl -X GET https://bluepoint-api.bluetechfilms.com.br/api/v1/listar-colaboradores \
  -H "Authorization: Bearer app_vendedores_803b18debadb56f85294014115e21d06"
```

> **Importante:** NÃO existe header `X-API-Key`. Tanto JWT quanto API Key usam `Authorization: Bearer <token>`.

### Tipos de Usuário (JWT)

| Tipo | Permissões |
|------|------------|
| `admin` | Acesso total |
| `gestor` | Gerenciar colaboradores, aprovar solicitações |
| `colaborador` | Apenas próprios dados |

### Permissões de API Key

| Permissão | Equivalente JWT | Acesso |
|-----------|----------------|--------|
| `admin` | admin | Acesso total |
| `write` | gestor | Leitura e escrita |
| `read` | colaborador | Apenas leitura |

---

## Endpoints

### Base URL
```
https://bluepoint-api.bluetechfilms.com.br/api/v1
```

---

## Autenticação

### POST /autenticar
Login - retorna token JWT e refresh token

**Request:**
```json
{
  "email": "admin@bluepoint.com",
  "senha": "Admin@123"
}
```

**Response:**
```json
{
  "token": "eyJhbGci...",
  "refreshToken": "abc123...",
  "usuario": {
    "id": 1,
    "nome": "Administrador",
    "email": "admin@bluepoint.com",
    "tipo": "admin",
    "foto": null
  }
}
```

### POST /renovar-token
Renova o token JWT usando refresh token

### POST /deslogar
Logout - revoga o refresh token

### POST /solicitar-recuperacao-senha
Envia email para recuperação de senha

### POST /redefinir-senha
Redefine a senha com token de recuperação

---

## Empresas

### POST /criar-empresa
Criar nova empresa (apenas admin)

**Request:**
```json
{
  "razaoSocial": "Minha Empresa LTDA",
  "nomeFantasia": "Minha Empresa",
  "cnpj": "11.222.333/0001-44",
  "celular": "(11) 99999-8888",
  "cep": "01310-100",
  "estado": "SP",
  "cidade": "São Paulo",
  "bairro": "Centro",
  "rua": "Rua Principal",
  "numero": "123"
}
```

**Campos:**
| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| razaoSocial | string | Sim | Razão social |
| nomeFantasia | string | Sim | Nome fantasia |
| cnpj | string | Sim | CNPJ (com ou sem máscara) |
| celular | string | Não | Celular |
| cep | string | Não | CEP |
| estado | string | Não | UF (2 caracteres) |
| cidade | string | Não | Cidade |
| bairro | string | Não | Bairro |
| rua | string | Não | Rua/Logradouro |
| numero | string | Não | Número |

### GET /listar-empresas
Lista todas as empresas (paginado)

**Query params:**
- `pagina` - Número da página (default: 1)
- `limite` - Itens por página (default: 50)
- `busca` - Busca por nome fantasia, razão social ou CNPJ

### GET /obter-empresa/{id}
Obtém empresa específica

### PUT /atualizar-empresa/{id}
Atualiza empresa (apenas admin)

### DELETE /excluir-empresa/{id}
Exclui empresa (apenas admin)

---

## Cargos

### POST /criar-cargo
Cadastra novo cargo (apenas admin)

**Request:**
```json
{
  "nome": "Desenvolvedor Full Stack",
  "cbo": "212405",
  "descricao": "Desenvolve sistemas web e mobile"
}
```

**Response (201):**
```json
{
  "id": 1,
  "nome": "Desenvolvedor Full Stack",
  "mensagem": "Cargo criado com sucesso"
}
```

### GET /listar-cargos
Lista todos os cargos (paginado)

**Query Params:** `pagina`, `limite`

**Response:**
```json
{
  "dados": [
    {
      "id": 1,
      "nome": "Desenvolvedor Full Stack",
      "cbo": "212405",
      "descricao": "Desenvolve sistemas web e mobile",
      "criadoEm": "2026-01-27T15:00:00.000Z",
      "atualizadoEm": "2026-01-27T15:00:00.000Z"
    }
  ],
  "paginacao": {
    "total": 2445,
    "pagina": 1,
    "limite": 50,
    "totalPaginas": 49
  }
}
```

### GET /obter-cargo/{id}
Obtém dados de um cargo específico

### PUT /atualizar-cargo/{id}
Atualiza cargo (apenas admin)

### DELETE /excluir-cargo/{id}
Exclui cargo (apenas admin). Não permite excluir cargo com colaboradores vinculados.

---

## Colaboradores

### GET /listar-colaboradores
Lista todos os colaboradores (paginado)

### GET /obter-colaborador/{id}
Obtém dados de um colaborador específico

### POST /criar-colaborador
Cadastra novo colaborador (gestor/admin)

**Request:**
```json
{
  "nome": "João Silva",
  "email": "joao@empresa.com",
  "senha": "Senha@123",
  "cpf": "123.456.789-00",
  "cargo": "Desenvolvedor",
  "dataAdmissao": "2024-01-15",
  "departamentoId": 1,
  "jornadaId": 1
}
```

### PUT /atualizar-colaborador/{id}
Atualiza todos os dados do colaborador

### PATCH /atualizar-parcial-colaborador/{id}
Atualiza parcialmente o colaborador

### DELETE /excluir-colaborador/{id}
Remove colaborador (soft delete)

### GET /listar-colaboradores-departamento/{id}
Lista colaboradores de um departamento

### GET /obter-resumo-colaborador/{colaboradorId}
Resumo com estatísticas do colaborador

### PUT /atualizar-foto-colaborador/{id}
Atualiza foto do colaborador

### GET /obter-foto-colaborador/{id}
Obtém foto do colaborador

### GET /listar-documentos-colaborador/{id}
Lista documentos do colaborador

---

## Marcações de Ponto

### POST /registrar-entrada
Registra entrada do colaborador

**Request:**
```json
{
  "colaboradorId": 1,
  "latitude": -23.5505,
  "longitude": -46.6333,
  "metodo": "web"
}
```

### POST /registrar-saida
Registra saída do colaborador

### GET /listar-marcacoes
Lista todas as marcações (paginado)

### GET /listar-marcacoes-hoje
Lista marcações do dia atual

### GET /listar-marcacoes-colaborador/{colaboradorId}
Lista marcações de um colaborador

### GET /obter-marcacao/{id}
Obtém uma marcação específica

### POST /criar-marcacao
Cria marcação manual (admin/gestor)

### PUT /atualizar-marcacao/{id}
Atualiza uma marcação

### DELETE /excluir-marcacao/{id}
Remove uma marcação

### POST /sincronizar-marcacoes-offline
Sincroniza marcações feitas offline

### POST /validar-geofence
Valida se localização está no geofence

---

## Banco de Horas

### GET /obter-banco-horas/{colaboradorId}
Obtém banco de horas do colaborador

### GET /obter-saldo-horas/{colaboradorId}
Obtém saldo atual de horas

### GET /listar-historico-horas/{colaboradorId}
Lista histórico de movimentações

### POST /criar-ajuste-horas
Cria ajuste manual no banco de horas

---

## Solicitações

### GET /listar-solicitacoes
Lista todas as solicitações

### GET /listar-solicitacoes-pendentes
Lista solicitações pendentes

### GET /listar-solicitacoes-colaborador/{colaboradorId}
Lista solicitações de um colaborador

### GET /obter-solicitacao/{id}
Obtém detalhes de uma solicitação

### POST /criar-solicitacao
Cria nova solicitação genérica

### PUT /atualizar-solicitacao/{id}
Atualiza uma solicitação

### DELETE /excluir-solicitacao/{id}
Remove/cancela uma solicitação

### POST /aprovar-solicitacao/{id}
Aprova uma solicitação (gestor)

### POST /rejeitar-solicitacao/{id}
Rejeita uma solicitação (gestor)

### GET /listar-tipos-solicitacao
Lista tipos de solicitação disponíveis

### POST /solicitar-ajuste-ponto
Cria solicitação de ajuste de ponto

### POST /solicitar-ferias
Cria solicitação de férias

### POST /justificar-ausencia
Cria justificativa de ausência

### POST /enviar-atestado
Envia atestado médico

---

## Anexos

### POST /enviar-anexo
Faz upload de anexo

### GET /obter-anexo/{id}
Obtém/download de um anexo

### DELETE /excluir-anexo/{id}
Remove um anexo

### GET /listar-anexos-solicitacao/{solicitacaoId}
Lista anexos de uma solicitação

---

## Departamentos

### GET /listar-departamentos
Lista todos os departamentos

### GET /obter-departamento/{id}
Obtém um departamento específico

### POST /criar-departamento
Cria novo departamento

**Request:**
```json
{
  "nome": "Tecnologia",
  "descricao": "Departamento de TI",
  "gestorId": 1
}
```

### PUT /atualizar-departamento/{id}
Atualiza um departamento

### DELETE /excluir-departamento/{id}
Remove um departamento

---

## Jornadas

A API suporta dois tipos de jornada:
- **Simples**: Horários definidos por dia da semana (seg, ter, qua...)
- **Circular**: Escala que se repete a cada X dias (12x36, 5x1, etc)

### GET /listar-jornadas
Lista todas as jornadas de trabalho

**Response:**
```json
{
  "data": [
    {
      "id": 1,
      "nome": "Comercial 8h",
      "tipo": "simples",
      "diasRepeticao": null,
      "horarios": [
        {
          "diaSemana": 1,
          "entrada1": "08:00",
          "saida1": "12:00",
          "entrada2": "13:00",
          "saida2": "18:00",
          "folga": false
        }
      ],
      "cargaHorariaSemanal": 45,
      "toleranciaEntrada": 10,
      "toleranciaSaida": 10,
      "status": "ativo"
    }
  ]
}
```

### GET /obter-jornada/{id}
Obtém uma jornada específica com colaboradores vinculados

### GET /obter-jornada-colaborador/{colaboradorId}
Obtém jornada de um colaborador

### POST /criar-jornada
Cria nova jornada de trabalho

**Horário Simples (por dia da semana):**
```json
{
  "nome": "Comercial 8h",
  "tipo": "simples",
  "toleranciaEntrada": 10,
  "toleranciaSaida": 10,
  "horarios": [
    {"diaSemana": 0, "folga": true},
    {"diaSemana": 1, "entrada1": "08:00", "saida1": "12:00", "entrada2": "13:00", "saida2": "18:00", "folga": false},
    {"diaSemana": 2, "entrada1": "08:00", "saida1": "12:00", "entrada2": "13:00", "saida2": "18:00", "folga": false},
    {"diaSemana": 3, "entrada1": "08:00", "saida1": "12:00", "entrada2": "13:00", "saida2": "18:00", "folga": false},
    {"diaSemana": 4, "entrada1": "08:00", "saida1": "12:00", "entrada2": "13:00", "saida2": "18:00", "folga": false},
    {"diaSemana": 5, "entrada1": "08:00", "saida1": "12:00", "entrada2": "13:00", "saida2": "18:00", "folga": false},
    {"diaSemana": 6, "folga": true}
  ]
}
```

**Horário Circular (escala que repete):**
```json
{
  "nome": "Escala 12x36",
  "tipo": "circular",
  "diasRepeticao": 2,
  "toleranciaEntrada": 15,
  "toleranciaSaida": 15,
  "horarios": [
    {"entrada1": "07:00", "saida1": "12:00", "entrada2": "13:00", "saida2": "19:00", "folga": false}
  ]
}
```

**Campos do horário:**
| Campo | Tipo | Descrição |
|-------|------|-----------|
| diaSemana | number | 0=Dom, 1=Seg, ..., 6=Sab (null para circular) |
| entrada1 | string | Primeira entrada (HH:MM) |
| saida1 | string | Saída para intervalo (HH:MM) |
| entrada2 | string | Retorno do intervalo (HH:MM) |
| saida2 | string | Saída final (HH:MM) |
| folga | boolean | true = dia de folga |

### PUT /atualizar-jornada/{id}
Atualiza uma jornada

### DELETE /excluir-jornada/{id}
Remove uma jornada

### POST /atribuir-jornada
Atribui jornada a um ou mais colaboradores

**Request:**
```json
{
  "jornadaId": 1,
  "colaboradorIds": [2, 3, 4],
  "dataInicio": "2026-01-27"
}
```

---

## Localizações (Geofence)

### GET /listar-localizacoes
Lista todas as localizações

### GET /obter-localizacao/{id}
Obtém uma localização específica

### POST /criar-localizacao
Cria nova localização

**Request:**
```json
{
  "nome": "Matriz",
  "tipo": "matriz",
  "latitude": -23.5505,
  "longitude": -46.6333,
  "raioPermitido": 100
}
```

### PUT /atualizar-localizacao/{id}
Atualiza uma localização

### DELETE /excluir-localizacao/{id}
Remove uma localização

---

## Feriados

### GET /listar-feriados
Lista todos os feriados

### GET /listar-feriados-ano/{ano}
Lista feriados de um ano específico

### GET /obter-feriado/{id}
Obtém um feriado específico

### POST /criar-feriado
Cria novo feriado

### PUT /atualizar-feriado/{id}
Atualiza um feriado

### DELETE /excluir-feriado/{id}
Remove um feriado

---

## Férias

- `GET /listar-ferias` - Lista períodos de férias
- `GET /obter-ferias/{id}` - Obtém registro de férias
- `POST /designar-ferias` - Designa férias
- `POST /solicitar-ferias` - Solicitação de férias
- `PUT /atualizar-ferias/{id}` - Atualiza férias
- `DELETE /excluir-ferias/{id}` - Remove férias

---

## Horas Extras e Limites

- `GET /listar-horas-extras` - Lista horas extras
- `GET /horas-extras-custos` - Custos de HE
- `GET /solicitacoes-horas-extras` - Solicitações de HE
- `GET /solicitacoes-horas-extras/{id}/custos` - Custos da solicitação
- `POST /solicitar-hora-extra` - Nova solicitação de HE
- `GET /limites-he-empresas`, `GET /limites-he-empresas/{empresaId}` - Limites por empresa
- `GET /limites-he-departamentos`, `GET /limites-he-departamentos/{id}` - Limites por departamento
- `GET /limites-he-gestores` - Limites por gestor
- `GET /saldo-he-gestor/{gestorId}` - Saldo HE do gestor
- `GET /saldo-tolerancia-hora-extra/{colaboradorId}` - Saldo tolerância HE
- `GET /parametros-hora-extra` - Parâmetros de HE
- `GET /liderancas-departamento`, `GET /liderancas-departamento/{id}` - Lideranças

---

## Alertas Inteligentes

Alertas periódicos (regras + IA com Gemini) para ausências, atrasos, HE e pendências. Notificação por push (OneSignal), email e in-app.

- `GET /alertas-inteligentes` - Lista alertas
- `GET /alertas-inteligentes/{id}` - Obtém alerta
- `POST /alertas-inteligentes/executar` - Dispara análise manual (admin)
- `POST /alertas-inteligentes/testar-push` - Testa push (admin)

Requer: `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`; opcional: `GEMINI_API_KEY`.

---

## Relatório Mensal

- `GET /relatorio-mensal/status` - Status dos relatórios
- `GET /relatorio-mensal/modelos` - Modelos
- `GET /relatorio-mensal/personalizado/config` - Config personalizado
- `GET /relatorio-mensal/{id}` - Obtém relatório
- `GET /relatorio-mensal/{id}/pdf` - PDF
- `POST /relatorio-mensal/{id}/assinar` - Assinar
- `POST /relatorio-mensal/{id}/contestar` - Contestar
- `POST /relatorio-mensal/{id}/recurso` - Recurso

---

## Exportação (Modelos e Códigos)

- `GET /listar-modelos-exportacao`, `GET /obter-modelo-exportacao/{id}`
- `POST /criar-modelo-exportacao`, `PUT /atualizar-modelo-exportacao/{id}`, `DELETE /excluir-modelo-exportacao/{id}`
- `POST /criar-codigo-exportacao`, `PUT /atualizar-codigo-exportacao/{id}`, `DELETE /excluir-codigo-exportacao/{id}`
- `POST /validar-codigos-exportacao`, `POST /gerar-exportacao`

---

## Permissões e API Keys

- `GET /permissoes`, `GET /permissoes/{id}`, `GET /permissoes/papel/{papel}`, `GET /permissoes/usuario`
- `GET/POST /api-keys` - Listar e criar API Keys
- `GET/PUT/DELETE /api-keys/{id}` - CRUD de API Key
- `POST /api-keys/{id}/regenerar` - Regenerar chave

---

## Dispositivos

- `GET /dispositivos/listar-dispositivos`, `GET /dispositivos/obter-dispositivo/{id}`
- `POST /dispositivos/criar-dispositivo`, `PUT /dispositivos/atualizar-dispositivo/{id}`, `DELETE /dispositivos/excluir-dispositivo/{id}`
- `POST /dispositivos/ativar-dispositivo`, `POST /dispositivos/regenerar-codigo/{id}`

---

## Apps (Binários)

- `GET /apps` - Lista apps
- `GET /apps/{nome}/download` - Download
- `POST /apps/upload-chunk`, `POST /apps/finalize-upload` - Upload em chunks

---

## Benefícios e Outros

- `GET /listar-beneficios-resumo`, `GET /parametros-beneficios`
- `GET /acompanhamento-jornada` - Acompanhamento de jornada
- `GET /painel-presenca` - Painel de presença
- `GET/PUT /parametros-tolerancia-atraso`, `POST /solicitar-atraso`, `POST /justificar-atraso`
- `POST /alterar-senha`, `POST /redefinir-senha`, `POST /resetar-senha/{id}`
- `POST /limpar-cache` (admin), `GET /warmup`, `GET /storage/[...path]`
- `GET/POST /external/solicitacoes-horas-extras` - Integração externa HE

---

## Notificações

### GET /listar-notificacoes
Lista notificações do usuário

### GET /obter-notificacao/{id}
Obtém uma notificação específica

### PUT /marcar-notificacao-lida/{id}
Marca notificação como lida

### PUT /marcar-todas-lidas
Marca todas as notificações como lidas

### DELETE /excluir-notificacao/{id}
Remove uma notificação

---

## Configurações

### GET /obter-configuracoes
Obtém configurações do sistema

### PUT /atualizar-configuracoes
Atualiza configurações do sistema

### GET /obter-tolerancias
Obtém tolerâncias de ponto

### PUT /atualizar-tolerancias
Atualiza tolerâncias de ponto

---

## Biometria Facial

A API de biometria facial permite cadastrar e verificar faces para autenticação.

**Em ambiente Docker** é utilizado o microserviço **Face Service** (Python/InsightFace). Em desenvolvimento local pode ser usado TensorFlow.js/face-api.js conforme configuração.

> **📄 Documentação completa:** [docs/BIOMETRIA.md](docs/BIOMETRIA.md)

### Token de API (Sistemas Externos)

Para integração com sistemas externos, use uma API Key ou o token fixo legado:

```bash
# API Key (recomendado)
Authorization: Bearer app_seuapp_803b18debadb56f85294014115e21d06

# Token fixo legado (apenas biometria)
Authorization: Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c
```

### Endpoints

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| POST | `/biometria/cadastrar-face` | Cadastra face | Token API ou JWT |
| POST | `/biometria/cadastrar-face-cpf` | Cadastra face via CPF (app) | JWT (admin/gestor/rh) |
| POST | `/biometria/verificar-face` | Verifica/autentica face | Nenhuma |
| GET | `/biometria/status/{colaboradorId}` | Status BluePoint | JWT |
| GET | `/biometria/status-externo/{externalId}` | Status externo | Token API |
| DELETE | `/biometria/remover-face/{colaboradorId}` | Remove BluePoint | JWT (admin) |
| DELETE | `/biometria/remover-face-externa` | Remove externo | Token API |

### Otimizações

- **Cache Redis**: Encodings cacheados por 5 minutos
- **Rate Limiting**: 60/min (verificar), 30/min (cadastrar)
- **CORS**: Aceita qualquer origem
- **Request ID**: Rastreamento de requisições
- **Pré-processamento**: Melhoria automática de imagem (contraste, brilho, nitidez)
- **Threshold Dinâmico**: Ajuste automático baseado na qualidade da imagem

### Cadastrar Face via CPF (App Mobile)

Endpoint para cadastro facial via aplicativo. Requer autenticação JWT de usuário admin/gestor/rh.

```bash
# 1. Login para obter token
curl -X POST .../api/v1/autenticar -d '{"email":"admin@empresa.com","senha":"..."}'
# Retorna: {"token": "eyJ..."}

# 2. Cadastrar face com o token
curl -X POST https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria/cadastrar-face-cpf \
  -H "Authorization: Bearer eyJ..." \
  -H "Content-Type: application/json" \
  -d '{"cpf": "123.456.789-00", "imagem": "data:image/jpeg;base64,..."}'
```

**Resposta:**
```json
{
  "success": true,
  "data": {
    "colaborador": {"id": 45, "nome": "João Silva", "cpf": "123.456.789-00"},
    "biometria": {"qualidade": 0.78, "preprocessado": true},
    "cadastradoPor": {"id": 1, "nome": "Admin Sistema"},
    "mensagem": "Biometria facial cadastrada com sucesso"
  }
}
```

### Cadastrar Face (Sistema Externo)

```bash
curl -X POST https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria/cadastrar-face \
  -H "Authorization: Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c" \
  -H "Content-Type: application/json" \
  -d '{"externalId": "user_123", "imagem": "data:image/jpeg;base64,..."}'
```

### Verificar Face

```bash
curl -X POST https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria/verificar-face \
  -H "Content-Type: application/json" \
  -d '{"imagem": "data:image/jpeg;base64,..."}'
```

**Resposta (usuário externo):**
```json
{
  "success": true,
  "data": {
    "identificado": true,
    "tipo": "externo",
    "externalId": "user_123",
    "confianca": 0.92
  }
}
```

**Resposta (colaborador BluePoint):**
```json
{
  "success": true,
  "data": {
    "identificado": true,
    "tipo": "bluepoint",
    "colaborador": {"id": 1, "nome": "João"},
    "token": "eyJ...",
    "refreshToken": "..."
  }
}
```

---

## Relatórios e Dashboard

### GET /obter-visao-geral
Dashboard com totalizadores e gráficos

### GET /obter-status-tempo-real
Status em tempo real dos colaboradores

### POST /gerar-espelho-ponto
Gera espelho de ponto (PDF)

### POST /gerar-relatorio-banco-horas
Gera relatório de banco de horas

---

## Auditoria

### GET /listar-logs-auditoria
Lista logs de auditoria do sistema

---

## Comandos Docker

O projeto inclui o serviço **face-service** (Python/InsightFace) para reconhecimento facial quando em ambiente Docker.

```bash
# Subir containers (API + Face Service)
docker compose up -d

# Ver logs
docker compose logs -f api
docker compose logs -f face-service

# Rebuild
docker compose up -d --build

# Parar
docker compose down

# Reiniciar
docker compose restart api
```

---

## Estrutura do Banco de Dados

### Schema: `bluepoint`

**Tabelas principais:**
- `bt_colaboradores` - Usuários do sistema
- `bt_empresas` - Empresas cadastradas
- `bt_departamentos` - Departamentos
- `bt_cargos` - Cargos (nome, CBO, descrição)
- `bt_jornadas` - Jornadas de trabalho (simples ou circular)
- `bt_jornada_horarios` - Horários (entrada1, saida1, entrada2, saida2, folga)
- `bt_marcacoes` - Marcações de ponto
- `bt_banco_horas` - Movimentações de banco de horas
- `bt_solicitacoes` - Solicitações diversas
- `bt_anexos` - Arquivos anexados
- `bt_localizacoes` - Localizações (geofence)
- `bt_feriados` - Feriados (nacional, estadual, municipal)
- `bt_ferias` - Períodos de férias
- `bt_notificacoes` - Notificações
- `bt_refresh_tokens` - Tokens de refresh
- `bt_configuracoes` - Configurações do sistema
- `bt_auditoria` - Logs de auditoria
- `bt_biometria_facial` - Cadastros faciais (colaborador_id ou external_id)
- `bt_alertas_inteligentes` - Alertas (regras e IA)
- `bt_limites_he_empresas`, `bt_limites_he_departamentos`, `bt_limites_he_gestores` - Limites de HE
- `bt_dispositivos` - Dispositivos de ponto
- `bt_permissoes`, `bt_api_keys` - Permissões e API Keys
- Demais tabelas de exportação, relatório mensal, benefícios, etc.

---

## Credenciais Padrão

| Campo | Valor |
|-------|-------|
| Email | `admin@bluepoint.com` |
| Senha | `Admin@123` |
| Tipo | `admin` |

> **Importante:** Altere a senha padrão em produção!

---

## Total de Endpoints: 185+

As rotas estão em `src/app/api/v1/`. Cada recurso pode expor GET, POST, PUT, PATCH ou DELETE conforme o caso.

---

## Estrutura do Projeto

```
bluepoint_api/
├── src/
│   ├── app/
│   │   └── api/v1/          # Rotas da API (uma pasta por endpoint)
│   ├── lib/                 # Lógica compartilhada
│   │   ├── db.ts            # Pool PostgreSQL
│   │   ├── cache.ts         # Redis
│   │   ├── email.ts         # Nodemailer
│   │   ├── notificacoes.ts  # Notificações in-app
│   │   ├── push-onesignal.ts
│   │   ├── alertas-periodicos.ts  # Job de alertas (regras + Gemini)
│   │   └── ...
│   └── ...
├── face-service/            # Microserviço Python (InsightFace) para biometria
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── README.md
└── docs/
    └── BIOMETRIA.md        # Documentação detalhada da biometria
```

---

## Changelog

### v1.6.0 (2026-02-27)
- Documentação geral revisada e atualizada
- Novos módulos documentados: Alertas Inteligentes, Relatório Mensal, Exportação, Férias, Horas Extras e Limites, Permissões, API Keys, Dispositivos, Apps, Benefícios
- Variáveis de ambiente ampliadas (SMTP, MinIO, Portal Colaborador, OneSignal, Gemini, Face Service)
- Estrutura do projeto e total de endpoints atualizados (185+)
- Docker: documentado face-service (Python/InsightFace)

### v1.4.0 (2026-02-11)
- Documentação de autenticação corrigida: JWT e API Key usam o mesmo header `Authorization: Bearer <token>`
- Removidas referências incorretas ao header `X-API-Key` (nunca existiu na implementação)
- Documentação de permissões de API Key adicionada

### v1.2.0 (2026-01-29)
- Novo endpoint `/biometria/cadastrar-face-cpf` para cadastro via app mobile
- Pré-processamento automático de imagem (contraste, brilho, nitidez)
- Threshold dinâmico baseado na qualidade da imagem
- Análise de qualidade detalhada (tamanho face, centralização, proporção)
- Dicas personalizadas para melhorar captura da imagem

### v1.1.0 (2026-01-28)
- Biometria facial otimizada para uso multi-plataforma
- Novos endpoints para sistemas externos (`/status-externo`, `/remover-face-externa`)
- Cache Redis para encodings faciais
- Rate limiting por IP
- Headers padronizados (X-Request-ID, X-RateLimit-*)
- Códigos de erro consistentes
