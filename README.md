# People API

API REST para sistema de gestão de ponto eletrônico.

## Tecnologias

- **Next.js 16** — Framework React com API Routes
- **TypeScript** — Tipagem estática
- **PostgreSQL (Aurora)** — Banco de dados (schema `people`)
- **Redis (ElastiCache)** — Cache e sessões
- **MinIO** — Object storage (anexos, fotos, documentos)
- **Docker** — Containerização
- **Face Service (Python/InsightFace)** — Reconhecimento facial (microserviço opcional)
- **OneSignal** — Push notifications
- **Google Gemini** — IA para alertas inteligentes (opcional)

---

## URLs

| Ambiente | URL |
|----------|-----|
| Produção | https://people-api.valerisapp.com.br |
| Local | http://localhost:3003 |

---

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

**Desenvolvimento local (sem Docker):** instale dependências com `npm install`, configure o `.env` com banco e Redis acessíveis, e execute `npm run dev`. A API sobe na porta definida em `API_PORT` (ex: 3003) ou 3000.

### Variáveis de Ambiente

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `API_PORT` | Porta da API | `3003` |
| `DB_HOST` | Host do PostgreSQL/PgBouncer | `pgbouncer` ou `localhost` |
| `DB_PORT` | Porta do PostgreSQL | `6432` ou `5432` |
| `DB_USERNAME` | Usuário do banco | `people` |
| `DB_PASSWORD` | Senha do banco | `***` |
| `DB_DATABASE` | Nome do banco | `people` |
| `DB_SSLMODE` | SSL do banco | `disable` |
| `REDIS_HOST` | Host do Redis (cache) | `redis` ou `localhost` |
| `REDIS_PORT` | Porta do Redis | `6379` |
| `REDIS_PASSWORD` | Senha do Redis (opcional) | `` |
| `JWT_SECRET` | Chave secreta JWT | `chave-secreta-forte` |
| `JWT_EXPIRES_IN` | Expiração do token | `24h` |
| `JWT_REFRESH_EXPIRES_IN` | Expiração do refresh | `7d` |
| `SMTP_*`, `EMAIL_FROM` | Email (recuperação de senha, alertas) | - |
| `BASE_URL` | URL base da API | `http://localhost:3003` |
| `FRONTEND_URL` | URL base do frontend (links públicos) | `http://localhost:3000` |
| `FORMULARIO_ADMISSAO_FRONTEND_URL` | URL base do frontend para link de admissão | `https://app.seudominio.com` |
| `FORMULARIO_ADMISSAO_FRONTEND_PATH` | Rota SPA do formulário de admissão | `/form` |
| `MINIO_*` | MinIO (endpoint, porta, chaves, bucket) | - |
| `BIOMETRIA_API_TOKEN` | Token fixo para biometria (sistemas externos) | `bp_bio_...` |
| `PORTAL_COLABORADOR_URL`, `PORTAL_COLABORADOR_API_KEY` | Integração Portal do Colaborador | - |
| `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY` | OneSignal (push) | - |
| `GEMINI_API_KEY` | Google Gemini (alertas inteligentes) | - |
| `FACE_SERVICE_URL` | Microserviço de reconhecimento facial | `http://face-service:5000` |

---

## Cache (Redis)

| TTL | Duração | Uso |
|-----|---------|-----|
| SHORT | 1 minuto | Dados frequentemente alterados (colaboradores) |
| MEDIUM | 5 minutos | Dados moderadamente estáveis (documentos) |
| LONG | 1 hora | Dados estáveis (cargos, empresas) |
| VERY_LONG | 24 horas | Dados raramente alterados |

O cache é invalidado automaticamente em criações, atualizações e exclusões.

---

## Autenticação

Todos os endpoints protegidos usam o header:

```
Authorization: Bearer <token>
```

O middleware detecta automaticamente o tipo de token:
- Se contém `.` → **JWT** (`eyJhbGciOi...`)
- Se contém `_` e tem 36+ caracteres → **API Key** (`app_vendedores_803b18...`)

### Tipos de Usuário (JWT)

| Tipo | Permissões |
|------|------------|
| `admin` | Acesso total |
| `gestor` | Gerenciar colaboradores, aprovar solicitações |
| `gerente` | Equivalente a gestor em alguns fluxos |
| `supervisor` | Acesso supervisão |
| `coordenador` | Acesso coordenação |
| `colaborador` | Apenas próprios dados |

### Permissões de API Key

| Permissão | Equivalente JWT | Acesso |
|-----------|----------------|--------|
| `admin` | admin | Acesso total |
| `write` | gestor | Leitura e escrita |
| `read` | colaborador | Apenas leitura |

### Endpoints sem autenticação

| Método | Endpoint | Uso |
|--------|----------|-----|
| POST | `/api/v1/autenticar` | Login (retorna JWT) |
| POST | `/api/v1/renovar-token` | Renovar JWT com refresh token |
| POST | `/api/v1/solicitar-recuperacao-senha` | Enviar email de recuperação |
| POST | `/api/v1/redefinir-senha` | Redefinir senha com token do email |
| GET | `/api/v1/health` | Health check (banco, Redis) |
| POST | `/api/v1/biometria/verificar-face` | Verificação facial |

---

## Formato de Respostas

**Sucesso simples:**
```json
{ "success": true, "data": { ... } }
```

**Sucesso paginado** (ex: `GET /listar-colaboradores`):
```json
{
  "success": true,
  "data": [ ... ],
  "paginacao": { "total": 100, "pagina": 1, "limite": 50, "totalPaginas": 2 }
}
```

**Erro:**
```json
{ "success": false, "error": "mensagem de erro" }
```

**Erro de validação (422):**
```json
{
  "success": false,
  "error": "Erro de validação",
  "errors": { "campo": ["mensagem"] }
}
```

---

## Base URL

```
https://people-api.valerisapp.com.br/api/v1
```

---

## Health Check

### GET /health

Retorna status do banco e Redis. Não requer autenticação.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "services": {
      "database": { "status": "connected", "pool": { "total": 20, "idle": 18, "waiting": 0 } },
      "redis": { "status": "connected", "keys": 15, "memory": "1.55M" }
    }
  }
}
```

---

## Autenticação

### POST /autenticar

Login com email e senha. Retorna JWT, refresh token e dados do usuário.

**Request:**
```json
{
  "email": "admin@people.com",
  "senha": "Admin@123"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| email | string | Sim | Email cadastrado |
| senha | string | Sim | Senha do usuário |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "abc123def456...",
    "usuario": {
      "id": 1,
      "nome": "Administrador",
      "email": "admin@people.com",
      "cpf": "12345678900",
      "tipo": "admin",
      "foto": null,
      "permitePontoMobile": false,
      "permissoes": ["colaboradores.listar", "colaboradores.criar", "cargos.listar"]
    }
  }
}
```

**Erros:**
- `401` — Email ou senha inválidos / Usuário inativo

---

### POST /renovar-token

Renova o JWT usando o refresh token.

**Request:**
```json
{ "refreshToken": "abc123def456..." }
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGci...",
    "refreshToken": "novo_refresh_token..."
  }
}
```

---

### POST /deslogar

Logout — revoga o refresh token. Requer autenticação.

**Request:**
```json
{ "refreshToken": "abc123def456..." }
```

**Response (200):** `{ "success": true, "data": { "mensagem": "Logout realizado com sucesso" } }`

---

### POST /solicitar-recuperacao-senha

Envia email com link de recuperação de senha. Não requer autenticação.

**Request:**
```json
{ "email": "usuario@empresa.com" }
```

---

### POST /redefinir-senha

Redefine a senha usando o token recebido por email. Não requer autenticação.

**Request:**
```json
{
  "token": "token-do-email",
  "novaSenha": "NovaSenha@123",
  "confirmarSenha": "NovaSenha@123"
}
```

---

### POST /alterar-senha

Altera a própria senha (usuário autenticado).

**Request:**
```json
{
  "senhaAtual": "SenhaAtual@123",
  "novaSenha": "NovaSenha@456"
}
```

---

## Empresas

### POST /criar-empresa

Cria nova empresa. Requer `admin`.

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

| Campo | Tipo | Obrigatório |
|-------|------|-------------|
| razaoSocial | string | Sim |
| nomeFantasia | string | Sim |
| cnpj | string | Sim |
| celular | string | Não |
| cep | string | Não |
| estado | string (2 chars) | Não |
| cidade | string | Não |
| bairro | string | Não |
| rua | string | Não |
| numero | string | Não |

---

### GET /listar-empresas

Lista todas as empresas (paginado). Requer autenticação.

**Query params:**

| Param | Tipo | Default | Descrição |
|-------|------|---------|-----------|
| pagina | number | 1 | Número da página |
| limite | number | 50 | Itens por página (máx 100) |
| busca | string | - | Filtro por nome fantasia, razão social ou CNPJ |

---

### GET /obter-empresa/{id}

Retorna empresa pelo ID. Requer autenticação.

---

### PUT /atualizar-empresa/{id}

Atualiza empresa. Requer `admin`. Campos iguais ao POST.

---

### DELETE /excluir-empresa/{id}

Exclui empresa. Requer `admin`.

---

## Cargos

### POST /criar-cargo

Cria novo cargo. Requer `admin`.

**Request:**
```json
{
  "nome": "Desenvolvedor Full Stack",
  "cbo": "212405",
  "descricao": "Desenvolve sistemas web e mobile"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| nome | string (mín 2 chars) | Sim | Nome do cargo |
| cbo | string | Não | Código Brasileiro de Ocupações |
| descricao | string | Não | Descrição do cargo |

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": 42,
    "nome": "Desenvolvedor Full Stack",
    "mensagem": "Cargo criado com sucesso"
  }
}
```

---

### GET /listar-cargos

Lista todos os cargos (paginado, cache 1h). Requer autenticação.

**Query params:**

| Param | Tipo | Default | Descrição |
|-------|------|---------|-----------|
| pagina | number | 1 | Página |
| limite | number | 50 | Itens por página (máx 100) |
| busca | string | - | Filtro por nome, CBO ou descrição |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "success": true,
    "data": [
      {
        "id": 1,
        "nome": "Desenvolvedor Full Stack",
        "cbo": "212405",
        "descricao": "Desenvolve sistemas web e mobile",
        "salarioMedio": 8500.00,
        "valorHoraExtra75": null,
        "criadoEm": "2026-01-27T15:00:00.000Z",
        "atualizadoEm": "2026-01-27T15:00:00.000Z"
      }
    ],
    "paginacao": {
      "total": 120,
      "pagina": 1,
      "limite": 50,
      "totalPaginas": 3
    }
  }
}
```

> **Nota:** O campo `data` é um objeto paginado (duplo wrapping por compatibilidade de cache). Acesse `response.data.data` para o array de cargos e `response.data.paginacao` para a paginação.

---

### GET /obter-cargo/{id}

Retorna dados de um cargo específico. Requer autenticação.

---

### PUT /atualizar-cargo/{id}

Atualiza cargo. Requer `admin`. Campos iguais ao POST (todos opcionais).

---

### DELETE /excluir-cargo/{id}

Exclui cargo. Requer `admin`. Retorna `400` se o cargo tiver colaboradores vinculados.

---

### GET /cargos/{id}/tipos-documento

Lista os tipos de documento do cargo com indicador de obrigatoriedade. Requer autenticação.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "cargoId": 1,
    "cargoNome": "Operador de Empilhadeira",
    "tipos": [
      {
        "id": 1,
        "codigo": "aso",
        "nomeExibicao": "ASO",
        "validadeMeses": 12,
        "obrigatorioPadrao": true,
        "obrigatorio": true,
        "categorias": ["operacional"]
      },
      {
        "id": 2,
        "codigo": "nr35",
        "nomeExibicao": "NR-35 Trabalho em Altura",
        "validadeMeses": 24,
        "obrigatorioPadrao": false,
        "obrigatorio": true,
        "categorias": ["operacional"]
      }
    ]
  }
}
```

> `obrigatorio` reflete a configuração específica para este cargo (se existir), ou o `obrigatorioPadrao` do tipo. Apenas tipos da categoria `operacional` são retornados.

---

### PUT /cargos/{id}/tipos-documento

Define quais tipos de documento são obrigatórios ou opcionais para o cargo. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "tipos": [
    { "tipoDocumentoId": 1, "obrigatorio": true },
    { "tipoDocumentoId": 2, "obrigatorio": false },
    { "tipoDocumentoId": 3, "obrigatorio": true }
  ]
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| tipos | array | Sim | Lista de tipos a configurar |
| tipos[].tipoDocumentoId | number | Sim | ID do tipo de documento |
| tipos[].obrigatorio | boolean | Sim | Se é obrigatório para este cargo |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "cargoId": 1,
    "mensagem": "Tipos de documento do cargo atualizados",
    "tipos": [
      { "tipoDocumentoId": 1, "obrigatorio": true },
      { "tipoDocumentoId": 2, "obrigatorio": false }
    ]
  }
}
```

> Esta operação **substitui** toda a configuração anterior do cargo (DELETE + INSERT). Apenas tipos de categoria `operacional` podem ser vinculados.

---

## Colaboradores

### GET /listar-colaboradores

Lista todos os colaboradores com paginação e filtros. Requer autenticação (JWT ou API Key).

**Query params:**

| Param | Tipo | Descrição |
|-------|------|-----------|
| pagina | number | Página (default: 1) |
| limite | number | Itens por página (default: 50, máx: 100) |
| busca | string | Filtro por nome, email ou CPF |
| filtro[departamentoId] | number | Filtro por departamento |
| filtro[status] | string | `ativo` ou `inativo` |
| filtro[mesReferencia] | string | `YYYY-MM` — inclui `diasDesconto` de benefícios |
| ordenar | string | `nome`, `email`, `data_admissao` ou `criado_em` (sufixo `:desc` para decrescente) |

**Exemplo:**
```
GET /api/v1/listar-colaboradores?pagina=1&limite=20&filtro[status]=ativo&ordenar=nome:asc
```

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "nome": "João Silva",
      "email": "joao@empresa.com",
      "cpf": "12345678900",
      "matricula": "12345678900",
      "tipo": "colaborador",
      "status": "ativo",
      "dataAdmissao": "2024-01-15T00:00:00.000Z",
      "foto": null,
      "valeAlimentacao": true,
      "valeTransporte": false,
      "empresa": { "id": 1, "nomeFantasia": "Empresa X" },
      "departamento": { "id": 2, "nome": "Logística" },
      "jornada": { "id": 1, "nome": "Comercial 8h" },
      "cargo": { "id": 5, "nome": "Analista" },
      "biometria": {
        "cadastrada": false,
        "cadastradaEm": null
      }
    }
  ],
  "paginacao": {
    "total": 150,
    "pagina": 1,
    "limite": 50,
    "totalPaginas": 3
  }
}
```

> Quando `filtro[mesReferencia]` é informado, cada item inclui também `diasDesconto` (número de dias sem direito a VA) e `mesReferenciaBeneficios`.

---

### GET /obter-colaborador/{id}

Retorna dados completos de um colaborador, incluindo endereço e documentos. Requer autenticação.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "nome": "João Silva",
    "email": "joao@empresa.com",
    "cpf": "12345678900",
    "rg": "12.345.678-9",
    "telefone": "(11) 99999-8888",
    "pis": "123.45678.90-1",
    "externalId": null,
    "tipo": "colaborador",
    "categoria": "empregado_clt",
    "observacao": null,
    "status": "ativo",
    "foto": null,
    "faceRegistrada": false,
    "permitePontoMobile": true,
    "permitePontoQualquerEmpresa": false,
    "valeAlimentacao": true,
    "valeTransporte": false,
    "dataAdmissao": "2024-01-15T00:00:00.000Z",
    "dataNascimento": "1990-05-20T00:00:00.000Z",
    "dataDesligamento": null,
    "criadoEm": "2024-01-10T12:00:00.000Z",
    "atualizadoEm": "2024-03-01T08:30:00.000Z",
    "endereco": {
      "cep": "01310-100",
      "logradouro": "Av. Paulista",
      "numero": "1000",
      "complemento": "Apto 42",
      "bairro": "Bela Vista",
      "cidade": "São Paulo",
      "estado": "SP"
    },
    "empresa": {
      "id": 1,
      "nomeFantasia": "Empresa X",
      "cnpj": "11222333000144",
      "estado": "SP",
      "cidade": "São Paulo"
    },
    "departamento": { "id": 2, "nome": "Logística" },
    "jornada": { "id": 1, "nome": "Comercial 8h" },
    "cargo": { "id": 5, "nome": "Analista" },
    "documentos": [
      {
        "id": 10,
        "tipo": "aso",
        "tipoDocumentoId": 1,
        "nome": "aso_joao_2024.pdf",
        "url": "https://storage.../aso_joao_2024.pdf",
        "tamanho": 102400,
        "dataUpload": "2024-01-15T12:00:00.000Z",
        "dataValidade": "2025-01-15",
        "vencido": false,
        "diasParaVencer": 275
      }
    ]
  }
}
```

**Erros:**
- `404` — Colaborador não encontrado

---

### POST /criar-colaborador

Cria novo colaborador. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "nome": "João Silva",
  "email": "joao@empresa.com",
  "senha": "Senha@123",
  "cpf": "123.456.789-00",
  "rg": "12.345.678-9",
  "telefone": "(11) 99999-8888",
  "pis": "123.45678.90-1",
  "categoria": "empregado",
  "observacao": "Observação opcional",
  "cargoId": 5,
  "empresaId": 1,
  "departamentoId": 2,
  "jornadaId": 1,
  "dataAdmissao": "2024-01-15",
  "dataNascimento": "1990-05-20",
  "dataDesligamento": null,
  "endereco": {
    "cep": "01310-100",
    "logradouro": "Av. Paulista",
    "numero": "1000",
    "complemento": "Apto 42",
    "bairro": "Bela Vista",
    "cidade": "São Paulo",
    "estado": "SP"
  },
  "permitePontoMobile": true,
  "permitePontoQualquerEmpresa": false,
  "valeAlimentacao": true,
  "valeTransporte": false
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| nome | string (mín 3, máx 255) | Sim | Nome completo |
| email | string (email) | Sim | Email único |
| senha | string (mín 6) | Sim | Senha inicial |
| cpf | string (11-14 chars) | Sim | CPF (com ou sem máscara, único) |
| rg | string (máx 20) | Não | RG |
| telefone | string (máx 20) | Não | Telefone/celular |
| pis | string (máx 20) | Não | PIS/PASEP |
| categoria | string | Não | `empregado`, `empregado_clt` ou `usuario_interno` |
| observacao | string | Não | Observação interna |
| cargoId | number | Não | ID do cargo (detecta `tipo` automaticamente pelo nome do cargo) |
| empresaId | number | Não | ID da empresa |
| departamentoId | number | Não | ID do departamento |
| jornadaId | number | Não | ID da jornada de trabalho |
| dataAdmissao | string (YYYY-MM-DD ou DD/MM/YYYY) | Sim | Data de admissão |
| dataNascimento | string (YYYY-MM-DD ou DD/MM/YYYY) | Não | Data de nascimento |
| dataDesligamento | string (YYYY-MM-DD) | Não | Data de desligamento |
| endereco | object | Não | Endereço residencial |
| endereco.cep | string (máx 10) | Não | CEP |
| endereco.logradouro | string (máx 255) | Não | Rua/Av. |
| endereco.numero | string (máx 20) | Não | Número |
| endereco.complemento | string (máx 100) | Não | Complemento |
| endereco.bairro | string (máx 100) | Não | Bairro |
| endereco.cidade | string (máx 100) | Não | Cidade |
| endereco.estado | string (2 chars) | Não | UF |
| permitePontoMobile | boolean | Não | Permite bater ponto pelo app (default: false) |
| permitePontoQualquerEmpresa | boolean | Não | Permite bater ponto em qualquer empresa (default: false) |
| valeAlimentacao | boolean | Não | Tem direito a VA (default: false) |
| valeTransporte | boolean | Não | Tem direito a VT (default: false) |

> O campo `tipo` (admin, gestor, colaborador, etc.) é determinado automaticamente pelo nome do cargo via `detectarTipoPorCargo`. Pode ser sobrescrito com `PUT /atualizar-colaborador/{id}` por um `admin`.

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": 123,
    "nome": "João Silva",
    "email": "joao@empresa.com",
    "tipo": "colaborador",
    "mensagem": "Colaborador criado com sucesso"
  }
}
```

**Erros:**
- `400` — CPF inválido
- `400` — Email ou CPF já cadastrado
- `422` — Erro de validação

---

### PUT /atualizar-colaborador/{id}

Atualiza dados do colaborador. Requer `gestor` ou `admin`. Todos os campos são opcionais.

**Request:**
```json
{
  "nome": "João da Silva Atualizado",
  "email": "joao.novo@empresa.com",
  "cpf": "123.456.789-00",
  "rg": "98.765.432-1",
  "telefone": "(11) 88888-7777",
  "pis": "123.45678.90-1",
  "categoria": "empregado_clt",
  "observacao": "Nova observação",
  "cargoId": 6,
  "empresaId": 1,
  "departamentoId": 3,
  "jornadaId": 2,
  "dataAdmissao": "2024-01-15",
  "dataNascimento": "1990-05-20",
  "dataDesligamento": null,
  "status": "ativo",
  "novaSenha": "NovaSenha@123",
  "endereco": {
    "cep": "04538-132",
    "logradouro": "Av. Brigadeiro Faria Lima",
    "numero": "2000",
    "complemento": null,
    "bairro": "Itaim Bibi",
    "cidade": "São Paulo",
    "estado": "SP"
  },
  "permitePontoMobile": true,
  "permitePontoQualquerEmpresa": false,
  "valeAlimentacao": true,
  "valeTransporte": true
}
```

> Campos omitidos **não** são alterados (atualização parcial). O campo `tipo` pode ser enviado por um `admin` para forçar o tipo de acesso (`colaborador`, `gestor`, `gerente`, `supervisor`, `coordenador`, `admin`). Para não-admins, o `tipo` é recalculado pelo `cargoId` se fornecido.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 123,
    "nome": "João da Silva Atualizado",
    "mensagem": "Colaborador atualizado com sucesso"
  }
}
```

**Erros:**
- `404` — Colaborador não encontrado
- `400` — CPF/email já cadastrado em outro colaborador
- `400` — Tipo inválido (campo `tipo` enviado por admin)

---

### DELETE /excluir-colaborador/{id}

Remove colaborador (soft delete — marca como inativo). Requer `admin`.

**Response (200):**
```json
{
  "success": true,
  "data": { "mensagem": "Colaborador removido com sucesso" }
}
```

---

### GET /listar-estoquistas

Lista colaboradores com cargo de estoquista (paginado). Requer autenticação.

**Query params:** `pagina`, `limite`, `busca`, `filtro[departamentoId]`, `filtro[status]`, `ordenar`

---

### GET /listar-supervisores

Lista colaboradores supervisores (paginado). Requer autenticação.

**Query params:** `pagina`, `limite`, `busca`, filtros de departamento e status.

---

### POST /colaboradores/{id}/documentos

Envia documento para o colaborador via **FormData**. Requer `gestor` ou `admin`.

**FormData:**

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| tipoDocumentoId | number | Sim | ID do tipo de documento |
| arquivo | File | Sim | Arquivo (PDF, JPG, PNG, DOC, DOCX — máx 15 MB) |
| dataValidade | string (YYYY-MM-DD) | Não | Data de validade; se omitido, calculada por `validadeMeses` do tipo |

**Exemplo cURL:**
```bash
curl -X POST https://people-api.valerisapp.com.br/api/v1/colaboradores/1/documentos \
  -H "Authorization: Bearer eyJ..." \
  -F "tipoDocumentoId=1" \
  -F "arquivo=@/caminho/aso.pdf" \
  -F "dataValidade=2025-01-15"
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": 10,
    "colaboradorId": 1,
    "tipo": "aso",
    "tipoDocumentoId": 1,
    "nome": "aso.pdf",
    "url": "https://storage.minio.../aso.pdf",
    "tamanho": 102400,
    "dataUpload": "2024-01-15T12:00:00.000Z",
    "dataValidade": "2025-01-15",
    "diasParaVencer": 365
  }
}
```

**Erros:**
- `404` — Colaborador não encontrado
- `400` — Arquivo muito grande (> 15 MB)
- `400` — Tipo de arquivo não permitido
- `400` — tipoDocumentoId não encontrado

---

### DELETE /colaboradores/{id}/documentos/{docId}

Remove documento do colaborador (arquivo no MinIO + registro no banco). Requer `gestor` ou `admin`.

**Response (200):**
```json
{
  "success": true,
  "data": { "mensagem": "Documento removido com sucesso" }
}
```

---

### GET /listar-documentos-colaborador/{id}

Lista documentos de um colaborador com status de validade e obrigatoriedade por cargo. Requer autenticação.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "documentos": [
      {
        "id": 10,
        "tipo": "aso",
        "tipoDocumentoId": 1,
        "tipoNomeExibicao": "ASO",
        "categorias": ["operacional"],
        "nome": "aso_joao_2024.pdf",
        "url": "https://storage.../aso_joao_2024.pdf",
        "tamanho": 102400,
        "dataUpload": "2024-01-15T12:00:00.000Z",
        "dataValidade": "2025-01-15",
        "vencido": false,
        "diasParaVencer": 275
      }
    ],
    "tiposObrigatoriosCargo": [
      { "tipoDocumentoId": 1, "codigo": "aso", "obrigatorio": true },
      { "tipoDocumentoId": 2, "codigo": "nr35", "obrigatorio": false }
    ]
  }
}
```

> `tiposObrigatoriosCargo` lista todos os tipos operacionais com indicação se são obrigatórios para o cargo do colaborador. Útil para o frontend exibir quais documentos estão faltando.

---

### GET /tipos-documento-colaborador

Lista os tipos de documento disponíveis. Requer autenticação.

**Query params:**

| Param | Tipo | Descrição |
|-------|------|-----------|
| categoria | string | Filtrar por `operacional` ou `admissao` |

**Response (200):**
```json
{
  "success": true,
  "data": {
    "tipos": [
      {
        "id": 1,
        "codigo": "aso",
        "nomeExibicao": "ASO",
        "validadeMeses": 12,
        "obrigatorioPadrao": true,
        "categorias": ["operacional"]
      },
      {
        "id": 2,
        "codigo": "nr35",
        "nomeExibicao": "NR-35 Trabalho em Altura",
        "validadeMeses": 24,
        "obrigatorioPadrao": false,
        "categorias": ["operacional"]
      },
      {
        "id": 3,
        "codigo": "rg",
        "nomeExibicao": "RG",
        "validadeMeses": null,
        "obrigatorioPadrao": true,
        "categorias": ["admissao"]
      }
    ]
  }
}
```

---

### POST /tipos-documento-colaborador

Cria novo tipo de documento ou adiciona categorias a um tipo existente (por `codigo`). Requer `gestor` ou `admin`.

**Request:**
```json
{
  "codigo": "cnh",
  "nomeExibicao": "CNH",
  "validadeMeses": 60,
  "obrigatorioPadrao": false,
  "categorias": ["operacional"]
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| codigo | string | Sim | Identificador único (snake_case, a-z 0-9 _) |
| nomeExibicao | string | Sim | Nome para exibição (máx 100 chars) |
| validadeMeses | number | Não | Validade em meses (null = sem validade) |
| obrigatorioPadrao | boolean | Não | Obrigatório por padrão (default: true) |
| categorias | array | Não | `["operacional"]`, `["admissao"]` ou ambos (default: `["operacional"]`) |

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": 7,
    "codigo": "cnh",
    "nomeExibicao": "CNH",
    "validadeMeses": 60,
    "obrigatorioPadrao": false,
    "categorias": ["operacional"]
  }
}
```

> Se o `codigo` já existir, a operação faz um merge das categorias (sem criar duplicata) e retorna `200`.

---

### POST /colaboradores/{id}/alterar-senha

Permite que um gestor/admin altere a senha de um colaborador.

**Request:**
```json
{ "novaSenha": "NovaSenha@123" }
```

**Response (200):**
```json
{
  "success": true,
  "data": { "mensagem": "Senha alterada com sucesso" }
}
```

---

## Departamentos

### POST /criar-departamento

Cria novo departamento. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "nome": "Tecnologia",
  "descricao": "Departamento de TI",
  "gestorId": 1
}
```

| Campo | Tipo | Obrigatório |
|-------|------|-------------|
| nome | string (mín 2, máx 100) | Sim |
| descricao | string | Não |
| gestorId | number | Não |

---

### GET /listar-departamentos

Lista todos os departamentos. Requer autenticação.

---

### GET /obter-departamento/{id}

Retorna departamento específico. Requer autenticação.

---

### PUT /atualizar-departamento/{id}

Atualiza departamento. Requer `gestor` ou `admin`.

**Request (todos os campos opcionais):**
```json
{
  "nome": "Novo Nome",
  "descricao": "Nova descrição",
  "gestorId": 2,
  "status": "ativo"
}
```

---

### DELETE /excluir-departamento/{id}

Remove departamento. Requer `admin`.

---

## Jornadas

A API suporta dois tipos de jornada:
- **Simples** — Horários definidos por dia da semana (0=Dom...6=Sab)
- **Circular** — Escala que se repete a cada X dias (12x36, 5x1, etc.)

### GET /listar-jornadas

Lista todas as jornadas. Requer autenticação.

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "nome": "Comercial 8h",
      "tipo": "simples",
      "diasRepeticao": null,
      "toleranciaEntrada": 10,
      "toleranciaSaida": 10,
      "status": "ativo",
      "horarios": [
        {
          "diaSemana": 1,
          "periodos": [
            { "entrada": "08:00", "saida": "12:00" },
            { "entrada": "13:00", "saida": "18:00" }
          ],
          "folga": false
        }
      ]
    }
  ]
}
```

---

### POST /criar-jornada

Cria nova jornada. Requer `gestor` ou `admin`.

**Jornada Simples (por dia da semana):**
```json
{
  "nome": "Comercial 8h",
  "tipo": "simples",
  "toleranciaEntrada": 10,
  "toleranciaSaida": 10,
  "horarios": [
    { "diaSemana": 0, "folga": true },
    {
      "diaSemana": 1,
      "folga": false,
      "periodos": [
        { "entrada": "08:00", "saida": "12:00" },
        { "entrada": "13:00", "saida": "18:00" }
      ]
    },
    { "diaSemana": 2, "folga": false, "periodos": [{ "entrada": "08:00", "saida": "12:00" }, { "entrada": "13:00", "saida": "18:00" }] },
    { "diaSemana": 3, "folga": false, "periodos": [{ "entrada": "08:00", "saida": "12:00" }, { "entrada": "13:00", "saida": "18:00" }] },
    { "diaSemana": 4, "folga": false, "periodos": [{ "entrada": "08:00", "saida": "12:00" }, { "entrada": "13:00", "saida": "18:00" }] },
    { "diaSemana": 5, "folga": false, "periodos": [{ "entrada": "08:00", "saida": "12:00" }, { "entrada": "13:00", "saida": "18:00" }] },
    { "diaSemana": 6, "folga": true }
  ]
}
```

**Jornada Circular (escala que repete):**
```json
{
  "nome": "Escala 12x36",
  "tipo": "circular",
  "diasRepeticao": 2,
  "toleranciaEntrada": 15,
  "toleranciaSaida": 15,
  "horarios": [
    {
      "sequencia": 1,
      "folga": false,
      "periodos": [
        { "entrada": "07:00", "saida": "12:00" },
        { "entrada": "13:00", "saida": "19:00" }
      ]
    },
    { "sequencia": 2, "folga": true }
  ]
}
```

| Campo de horário | Tipo | Descrição |
|------------------|------|-----------|
| diaSemana | number 0-6 | Dia da semana (jornada simples) |
| sequencia | number | Posição no ciclo (jornada circular) |
| folga | boolean | `true` = dia de folga |
| periodos | array | Períodos de trabalho `[{ entrada, saida }]` no formato HH:MM |

---

### POST /atribuir-jornada

Atribui jornada a um ou mais colaboradores. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "jornadaId": 1,
  "colaboradorIds": [2, 3, 4],
  "dataInicio": "2026-01-27"
}
```

---

### PUT /atualizar-jornada/{id}

Atualiza jornada. Campos iguais ao POST (todos opcionais).

---

### DELETE /excluir-jornada/{id}

Remove jornada. Requer `admin`.

---

## Marcações de Ponto

### POST /registrar-entrada

Registra entrada do colaborador. Requer autenticação.

**Request:**
```json
{
  "colaboradorId": 1,
  "empresaId": 1,
  "localizacao": {
    "latitude": -23.5505,
    "longitude": -46.6333
  },
  "foto": "data:image/jpeg;base64,...",
  "metodo": "app"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| colaboradorId | number | Sim | ID do colaborador |
| empresaId | number | Não | ID da empresa |
| localizacao | object | Não | Geolocalização |
| foto | string | Não | Foto em base64 |
| metodo | string | Sim | `app`, `web` ou `biometria` |

---

### POST /registrar-saida

Registra saída. Campos iguais a `/registrar-entrada`.

---

### POST /criar-marcacao

Cria marcação manual. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "colaboradorId": 1,
  "empresaId": 1,
  "dataHora": "2026-01-27T08:00:00.000Z",
  "tipo": "entrada",
  "justificativa": "Esqueceu de bater o ponto",
  "observacao": "Registrado pelo gestor"
}
```

| Campo | Tipo | Obrigatório | Valores |
|-------|------|-------------|---------|
| colaboradorId | number | Sim | - |
| dataHora | string (ISO) | Sim | - |
| tipo | string | Sim | `entrada`, `saida`, `almoco`, `retorno` |
| justificativa | string | Sim | Motivo da marcação manual |
| observacao | string | Não | - |

---

### GET /listar-marcacoes

Lista marcações com filtros (paginado). Requer autenticação.

**Query params:** `pagina`, `limite`, `colaboradorId`, `dataInicio` (YYYY-MM-DD), `dataFim` (YYYY-MM-DD), `tipo`, `filtro[departamentoId]`

---

### GET /listar-marcacoes-hoje

Lista marcações do dia atual. Requer autenticação.

---

### POST /sincronizar-marcacoes-offline

Sincroniza marcações feitas offline. Requer autenticação.

**Request:**
```json
{
  "marcacoes": [
    {
      "colaboradorId": 1,
      "dataHora": "2026-01-27T08:00:00.000Z",
      "tipo": "entrada",
      "localizacao": { "latitude": -23.55, "longitude": -46.63 },
      "metodo": "app"
    }
  ]
}
```

---

### POST /validar-geofence

Verifica se a localização está dentro do perímetro permitido.

**Request:**
```json
{
  "latitude": -23.5505,
  "longitude": -46.6333,
  "localizacaoId": 1
}
```

---

## Banco de Horas

### POST /criar-ajuste-horas

Cria ajuste manual no banco de horas. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "colaboradorId": 1,
  "tipo": "credito",
  "horas": 2.5,
  "motivo": "Hora extra não registrada",
  "observacao": "Aprovado pelo gestor",
  "data": "2026-01-27"
}
```

| Campo | Tipo | Obrigatório | Valores |
|-------|------|-------------|---------|
| colaboradorId | number | Sim | - |
| tipo | string | Sim | `credito` ou `debito` |
| horas | number | Sim | Horas (> 0) |
| motivo | string | Sim | - |
| observacao | string | Não | - |
| data | string (YYYY-MM-DD) | Sim | - |

---

## Solicitações

### POST /criar-solicitacao

Cria nova solicitação. Requer autenticação.

**Request:**
```json
{
  "tipo": "ajuste_ponto",
  "gestorId": 5,
  "dataEvento": "2026-01-27",
  "dataEventoFim": null,
  "descricao": "Ponto não registrado",
  "justificativa": "Sistema fora do ar",
  "dadosAdicionais": {},
  "anexosIds": []
}
```

| Campo | Tipo | Obrigatório | Valores |
|-------|------|-------------|---------|
| tipo | string | Sim | `ajuste_ponto`, `ferias`, `atestado`, `ausencia`, `hora_extra`, `atraso`, `outros` |
| gestorId | number | Condicional | Obrigatório para `hora_extra` |
| dataEvento | string (YYYY-MM-DD) | Sim | - |
| dataEventoFim | string (YYYY-MM-DD) | Não | - |
| descricao | string | Sim | - |
| justificativa | string | Sim | - |
| dadosAdicionais | object | Não | Dados extras livre |
| anexosIds | number[] | Não | IDs de anexos já enviados |

---

### PATCH /aprovar-solicitacao/{id}

Aprova solicitação. Requer `gestor` ou `admin`.

**Request:**
```json
{ "observacao": "Aprovado conforme política interna" }
```

---

### PATCH /rejeitar-solicitacao/{id}

Rejeita solicitação. Requer `gestor` ou `admin`.

**Request:**
```json
{ "motivo": "Fora do prazo para solicitação" }
```

---

### GET /listar-solicitacoes

Lista solicitações com filtros (paginado). Requer autenticação.

**Query params:** `pagina`, `limite`, `colaboradorId`, `tipo`, `status`, `dataInicio`, `dataFim`, `gestorId`

---

### POST /solicitar-ajuste-ponto

Cria solicitação de ajuste de marcação. Requer autenticação.

**Request:**
```json
{
  "ajustes": [
    { "marcacaoId": 10, "dataHoraCorreta": "2026-01-27T08:05:00.000Z" }
  ],
  "motivo": "Atraso no sistema",
  "justificativa": "O relógio estava adiantado"
}
```

---

### POST /solicitar-ferias

Cria solicitação de férias. Requer autenticação.

**Request:**
```json
{
  "dataInicio": "2026-07-01",
  "dataFim": "2026-07-30",
  "dias": 30,
  "observacao": "Férias anuais"
}
```

---

### POST /designar-ferias

Gestor designa férias para um colaborador. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "colaboradorId": 1,
  "dataInicio": "2026-07-01",
  "dataFim": "2026-07-30",
  "observacao": "Férias anuais designadas"
}
```

---

### POST /justificar-ausencia

Justifica ausência. Requer autenticação.

**Request:**
```json
{
  "data": "2026-01-27",
  "motivo": "Problema de saúde",
  "justificativa": "Consulta médica",
  "anexoId": 5
}
```

---

### POST /justificar-atraso

Justifica atraso em uma marcação. Requer autenticação.

**Request:**
```json
{
  "marcacaoId": 10,
  "justificativa": "Acidente na via",
  "motivo": "transito",
  "anexoId": null
}
```

| Campo motivo | Descrição |
|--------------|-----------|
| `transito` | Trânsito |
| `transporte_publico` | Transporte público |
| `problema_saude` | Problema de saúde |
| `problema_familiar` | Problema familiar |
| `compromisso_medico` | Compromisso médico |
| `outros` | Outros |

---

### POST /enviar-atestado

Envia atestado médico. Requer autenticação.

**Request:**
```json
{
  "dataInicio": "2026-01-27",
  "dataFim": "2026-01-28",
  "cid": "J00",
  "observacao": "Gripe",
  "anexoId": 5
}
```

---

## Horas Extras

### POST /solicitar-hora-extra

Cria solicitação de hora extra. Requer autenticação.

**Request:**
```json
{
  "colaboradorId": 1,
  "gestorId": 5,
  "data": "2026-01-27",
  "horaInicio": "18:00",
  "horaFim": "20:00",
  "motivo": "Fechamento de projeto",
  "observacao": "",
  "anexosIds": []
}
```

---

### GET /listar-horas-extras

Lista horas extras. Requer autenticação.

---

### GET /horas-extras-custos

Retorna custos de horas extras. Requer autenticação.

---

### GET /parametros-hora-extra

Retorna parâmetros de hora extra. Requer autenticação.

---

## Localizações (Geofence)

### POST /criar-localizacao

Cria nova localização/geofence. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "nome": "Matriz São Paulo",
  "tipo": "matriz",
  "coordenadas": {
    "latitude": -23.5505,
    "longitude": -46.6333
  },
  "raioPermitido": 100,
  "endereco": {
    "logradouro": "Av. Paulista",
    "numero": "1000",
    "bairro": "Bela Vista",
    "cidade": "São Paulo",
    "estado": "SP"
  }
}
```

| Campo tipo | Valores |
|------------|---------|
| tipo | `matriz`, `filial`, `obra`, `cliente`, `outros` |

---

### GET /listar-localizacoes

Lista todas as localizações. Requer autenticação.

---

### PUT /atualizar-localizacao/{id}

Atualiza localização. Campos iguais ao POST (todos opcionais).

---

### DELETE /excluir-localizacao/{id}

Remove localização.

---

## Feriados

### POST /criar-feriado

Cria feriado. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "nome": "Natal",
  "data": "2026-12-25",
  "tipo": "nacional",
  "recorrente": true,
  "abrangencia": null,
  "descricao": "Natal"
}
```

| Campo tipo | Valores |
|------------|---------|
| tipo | `nacional`, `estadual`, `municipal`, `empresa` |

---

### GET /listar-feriados

Lista feriados com filtros opcionais. Requer autenticação.

---

## Férias

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| GET | `/listar-ferias` | Lista períodos de férias | Auth |
| GET | `/obter-ferias/{id}` | Obtém registro de férias | Auth |
| POST | `/designar-ferias` | Gestor designa férias | Gestor |
| POST | `/solicitar-ferias` | Colaborador solicita férias | Auth |
| PATCH | `/atualizar-ferias/{id}` | Atualiza período | Gestor |
| DELETE | `/excluir-ferias/{id}` | Remove período | Admin |

---

## Prestadores de Serviços

### POST /criar-prestador

Cria prestador (PJ). Requer `gestor` ou `admin`.

**Request:**
```json
{
  "razaoSocial": "Empresa X Ltda",
  "nomeFantasia": "Empresa X",
  "cnpjCpf": "12.345.678/0001-90",
  "email": "contato@empresax.com",
  "telefone": "(11) 99999-0000",
  "endereco": "Rua ABC, 123 - São Paulo/SP",
  "areaAtuacao": "TI",
  "status": "ativo",
  "observacoes": ""
}
```

| Campo | Tipo | Obrigatório |
|-------|------|-------------|
| razaoSocial | string (mín 2) | Sim |
| nomeFantasia | string | Não |
| cnpjCpf | string | Sim |
| email | string (email) | Não |
| telefone | string | Não |
| endereco | string | Não |
| areaAtuacao | string | Não |
| status | string | Não | `ativo`, `inativo`, `bloqueado` (default: `ativo`) |
| observacoes | string | Não |

---

### GET /listar-prestadores

Lista prestadores com filtros. Requer autenticação.

**Query params:** `busca`, `status` (`ativo`, `inativo`, `bloqueado`), `pagina`, `limite`

---

### POST /criar-contrato-prestador

Cria contrato vinculado a prestador. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "prestadorId": 1,
  "numero": "CT-2026-001",
  "descricao": "Manutenção de servidores",
  "dataInicio": "2026-01-01",
  "dataFim": "2026-12-31",
  "valor": 5000.00,
  "formaPagamento": "mensal",
  "status": "vigente",
  "alertaRenovacaoDias": 30,
  "observacoes": ""
}
```

| Campo formaPagamento | Valores |
|----------------------|---------|
| formaPagamento | `mensal`, `quinzenal`, `por_demanda`, `unico` |

---

### POST /criar-nfe-prestador

Cadastra NFe vinculada a prestador. Requer `gestor` ou `admin`.

**Request:**
```json
{
  "prestadorId": 1,
  "contratoId": 1,
  "numero": "000123",
  "serie": "1",
  "chaveAcesso": "35260612345678000190550010001230001234567890",
  "dataEmissao": "2026-02-01",
  "valor": 5000.00,
  "status": "pendente",
  "arquivoUrl": "",
  "observacoes": ""
}
```

---

## Relatórios e Dashboard

### GET /obter-visao-geral

Dashboard com totalizadores e gráficos. Requer autenticação.

### GET /obter-status-tempo-real

Status em tempo real dos colaboradores. Requer autenticação.

### GET /gerar-espelho-ponto

Gera espelho de ponto. Requer autenticação.

**Query params:** `colaboradorId`, `mes` (YYYY-MM)

### GET /gerar-espelho-ponto-pdf

Gera espelho de ponto em PDF. Mesmos params do anterior.

### GET /gerar-relatorio-banco-horas

Gera relatório de banco de horas. Requer autenticação.

---

## Notificações

### GET /listar-notificacoes

Lista notificações do usuário autenticado (paginado).

### PATCH /marcar-todas-lidas

Marca todas as notificações como lidas.

---

## Permissões e API Keys

### GET /permissoes

Lista todas as permissões do sistema. Requer `admin`.

### GET /api-keys, POST /api-keys

Lista e cria API Keys. Requer `admin`.

**Request POST:**
```json
{
  "nome": "App Relógio Ponto",
  "permissao": "write",
  "descricao": "Integração com relógio biométrico"
}
```

### PUT /api-keys/{id}, DELETE /api-keys/{id}

Atualiza e exclui API Key. Requer `admin`.

### POST /api-keys/{id}/regenerar

Regenera a chave. Requer `admin`.

---

## Biometria Facial

> **Documentação completa:** [docs/BIOMETRIA.md](docs/BIOMETRIA.md)

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| POST | `/biometria/cadastrar-face` | Cadastra face (sistema externo) | Token API |
| POST | `/biometria/cadastrar-face-cpf` | Cadastra face via CPF (app) | JWT admin/gestor |
| POST | `/biometria/verificar-face` | Verifica/identifica face | Nenhuma |
| GET | `/biometria/status/{colaboradorId}` | Status biometria People | JWT |
| DELETE | `/biometria/remover-face/{colaboradorId}` | Remove face | JWT admin |

### POST /biometria/cadastrar-face-cpf

**Request:**
```json
{
  "cpf": "123.456.789-00",
  "imagem": "data:image/jpeg;base64,/9j/4AAQSkZJRgAB..."
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "colaborador": { "id": 45, "nome": "João Silva", "cpf": "12345678900" },
    "biometria": { "qualidade": 0.78, "preprocessado": true },
    "cadastradoPor": { "id": 1, "nome": "Admin Sistema" },
    "mensagem": "Biometria facial cadastrada com sucesso"
  }
}
```

### POST /biometria/verificar-face

Não requer autenticação. Identifica o colaborador pela face.

**Request:**
```json
{
  "foto": "data:image/jpeg;base64,...",
  "localizacao": { "latitude": -23.5505, "longitude": -46.6333 }
}
```

**Response — colaborador People identificado:**
```json
{
  "success": true,
  "data": {
    "identificado": true,
    "tipo": "people",
    "colaborador": { "id": 1, "nome": "João Silva" },
    "token": "eyJ...",
    "refreshToken": "..."
  }
}
```

---

## Alertas Inteligentes

Alertas periódicos com IA (Gemini) para ausências, atrasos, HE e pendências. Notificação por push (OneSignal), email e in-app.

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| GET | `/alertas-inteligentes` | Lista alertas | Auth |
| POST | `/alertas-inteligentes/executar` | Dispara análise manual | Admin |
| POST | `/alertas-inteligentes/testar-push` | Testa push | Admin |

Requer: `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`; opcional: `GEMINI_API_KEY`.

---

## Relatório Mensal

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/relatorio-mensal/modelos` | Lista modelos |
| GET | `/relatorio-mensal/{id}` | Obtém relatório |
| GET | `/relatorio-mensal/{id}/pdf` | PDF do relatório |
| POST | `/relatorio-mensal/{id}/assinar` | Assinar relatório |
| POST | `/relatorio-mensal/{id}/contestar` | Contestar relatório |

---

## Assiduidade

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/assiduidade` | Dashboard de assiduidade |
| GET/POST | `/assiduidade/bloquear-colaborador` | Bloquear/desbloquear colaborador |
| GET | `/assiduidade/colaboradores-ocultos` | Colaboradores ocultos |

---

## Auditoria

### GET /listar-logs-auditoria

Lista logs de auditoria. Requer `admin`.

**Query params:** `dataInicio`, `dataFim`, `modulo`, `acao`, `colaboradorId`, `busca`, `pagina`, `limite`

---

## Configurações

### GET /obter-configuracoes

Retorna configurações do sistema. Requer autenticação.

### PUT /atualizar-configuracoes

Atualiza configurações. Requer `admin`.

**Request:**
```json
{
  "categoria": "ponto",
  "configuracoes": {
    "toleranciaEntrada": "10",
    "toleranciaSaida": "10"
  }
}
```

### PUT /atualizar-configuracoes-sistema

Atualiza configurações por seção. Requer `admin`.

**Request:**
```json
{
  "geral": {
    "nomeEmpresa": "Minha Empresa",
    "fusoHorario": "America/Sao_Paulo",
    "formatoData": "DD/MM/YYYY",
    "formatoHora": "24h",
    "idioma": "pt-BR"
  },
  "ponto": {
    "toleranciaEntrada": 10,
    "toleranciaSaida": 10,
    "intervaloMinimoMarcacoes": 5,
    "permitirMarcacaoOffline": true,
    "exigirFotoPadrao": false,
    "exigirGeolocalizacaoPadrao": false,
    "raioMaximoGeolocalizacao": 200,
    "permitirMarcacaoForaPerimetro": false,
    "bloquearMarcacaoDuplicada": true,
    "tempoBloqueioDuplicada": 5
  }
}
```

---

## Outros Endpoints

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| GET | `/painel-presenca` | Painel de presença em tempo real | Auth |
| GET | `/acompanhamento-jornada` | Acompanhamento de jornada | Auth |
| GET | `/listar-beneficios-resumo` | Resumo de benefícios | Auth |
| POST | `/limpar-cache` | Limpa cache Redis | Admin |
| GET | `/warmup` | Pré-aquece o servidor | - |
| GET | `/storage/[...path]` | Proxy para arquivos no MinIO | Auth |
| GET | `/gerar-token-jitsi` | Token para reunião Jitsi | Auth |
| GET | `/listar-reunioes` | Lista reuniões agendadas | Auth |
| POST | `/agendar-reuniao` | Agenda reunião Jitsi | Auth |
| GET | `/gestao-pessoas` | Dashboard gestão de pessoas | Auth |
| GET/POST | `/apps` | Apps binários | Admin |

---

## Comandos Docker

```bash
# Subir containers
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

Schema `people` — principais tabelas:

| Área | Tabelas |
|------|---------|
| Cadastros | `empresas`, `cargos`, `colaboradores`, `departamentos`, `documentos_colaborador`, `tipos_documento_colaborador`, `cargo_tipo_documento` |
| Jornada e ponto | `jornadas`, `jornada_horarios`, `marcacoes`, `colaborador_jornadas_historico` |
| Banco de horas / HE | `banco_horas`, `parametros_hora_extra`, `limites_he_*`, `solicitacoes_horas_extras` |
| Solicitações | `solicitacoes`, `solicitacoes_historico`, `tipos_solicitacao`, `anexos` |
| Local e feriados | `localizacoes`, `localizacao_departamentos`, `feriados` |
| Auth e segurança | `refresh_tokens`, `tokens_recuperacao`, `permissoes`, `tipo_usuario_permissoes`, `api_keys` |
| Config e sistema | `configuracoes`, `configuracoes_empresa`, `config_sistema` |
| Biometria e auditoria | `biometria_facial`, `auditoria`, `notificacoes` |
| Módulos | `prestadores`, `contratos_prestador`, `nfes_prestador`, `dispositivos`, `alertas_inteligentes`, `modelos_exportacao`, `relatorios_mensais` |

Views: `vw_colaboradores_completo`, `vw_marcacoes_hoje`, `vw_solicitacoes_pendentes`, `vw_saldo_banco_horas`

---

## Estrutura do Projeto

```
people_api/
├── src/
│   ├── app/
│   │   └── api/v1/          # Rotas da API (uma pasta por endpoint)
│   └── lib/
│       ├── db.ts             # Pool PostgreSQL
│       ├── cache.ts          # Redis (cache-aside)
│       ├── auth.ts           # JWT, hash de senha
│       ├── middleware.ts     # withAuth, withAdmin, withGestor, withRole
│       ├── validation.ts     # Schemas Zod
│       ├── api-response.ts   # Helpers de resposta padronizada
│       ├── audit.ts          # Auditoria de ações
│       ├── notificacoes.ts   # Notificações in-app + push
│       ├── push-onesignal.ts # OneSignal
│       └── face-recognition.ts
├── database/
│   └── migrations/           # Scripts SQL numerados (ex: 011_...sql)
├── face-service/             # Microserviço Python (InsightFace)
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

---

## Credenciais Padrão

| Campo | Valor |
|-------|-------|
| Email | `admin@people.com` |
| Senha | `Admin@123` |
| Tipo | `admin` |

> **Importante:** Altere a senha padrão em produção.

---

## Total de Endpoints: 190+

Todas as rotas estão em `src/app/api/v1/`. Todos os endpoints protegidos aceitam **JWT e API Key** no header `Authorization: Bearer <token>`.

---

## Changelog

### v1.9.0 (2026-04-16)
- Sistema renomeado de **BluePoint** para **People**

### v1.8.0 (2026-04-15)
- README completamente reescrito com request/response detalhados para todos os endpoints principais
- Colaboradores: documentados todos os campos de criação/atualização, response completo com endereço e documentos
- Cargos: documentados `salarioMedio`, `valorHoraExtra75` na listagem; endpoints `/cargos/{id}/tipos-documento` completamente documentados
- Tipos de documento: GET e POST `/tipos-documento-colaborador` documentados com filtro por categoria
- Marcações: campos completos de `criar-marcacao`, `registrar-entrada`/`saida`
- Atualização da URL de produção para `people-api.valerisapp.com.br`

### v1.7.0 (2026-03-10)
- Padronização de respostas: chave `data` em todos os endpoints de sucesso
- README: seção "Padronização de respostas" e "Endpoints sem autenticação"

### v1.6.0 (2026-02-27)
- Novos módulos: Alertas Inteligentes, Relatório Mensal, Exportação, Férias, HE e Limites, Permissões, API Keys, Dispositivos, Apps, Benefícios
- Variáveis de ambiente ampliadas

### v1.4.0 (2026-02-11)
- Documentação de autenticação corrigida: JWT e API Key usam o mesmo header `Authorization: Bearer <token>`

### v1.2.0 (2026-01-29)
- Endpoint `/biometria/cadastrar-face-cpf` para cadastro via app mobile
- Pré-processamento automático de imagem

### v1.1.0 (2026-01-28)
- Biometria facial multi-plataforma
- Cache Redis para encodings faciais
- Rate limiting por IP
