# BluePoint API - Biometria Facial

Documentação completa dos endpoints de reconhecimento facial.

---

## Índice

- [Visão Geral](#visão-geral)
- [Pré-processamento de Imagem](#pré-processamento-de-imagem-v120)
- [Otimizações Multi-Plataforma](#otimizações-multi-plataforma)
- [Autenticação](#autenticação)
- [Endpoints](#endpoints)
  - [POST /cadastrar-face](#post-cadastrar-face)
  - [POST /cadastrar-face-cpf](#post-cadastrar-face-cpf)
  - [POST /verificar-face](#post-verificar-face)
  - [POST /salvar-foto-reconhecimento](#post-salvar-foto-reconhecimento)
  - [GET /status/{colaboradorId}](#get-statuscolaboradorid)
  - [GET /status-externo/{externalId}](#get-status-externoexternalid)
  - [DELETE /remover-face/{colaboradorId}](#delete-remover-facecolaboradorid)
  - [DELETE /remover-face-externa](#delete-remover-face-externa)
- [Estrutura do Banco de Dados](#estrutura-do-banco-de-dados)
- [Integração com Sistemas Externos](#integração-com-sistemas-externos)
- [Fluxo Completo: Cadastro e Login](#fluxo-completo-cadastro-e-login-por-reconhecimento-facial)
- [Boas Práticas](#boas-práticas)
- [Códigos de Erro HTTP](#códigos-de-erro-http)
- [Changelog](#changelog)

---

## Visão Geral

A API de biometria facial permite:
- Cadastrar faces de colaboradores BluePoint
- Cadastrar faces de usuários de sistemas externos
- Verificar/autenticar usuários por reconhecimento facial
- Consultar status de cadastro
- Remover cadastros faciais

**Tecnologia:** Em ambiente Docker utiliza o **Face Service** (Python/InsightFace). Em outros ambientes pode ser usado TensorFlow.js + face-api.js (vladmandic).

---

## Pré-processamento de Imagem (v1.2.0)

A API aplica automaticamente melhorias na imagem antes do reconhecimento facial, otimizado para câmeras de baixa qualidade (tablets, webcams antigas, etc.):

| Técnica | Descrição |
|---------|-----------|
| **Normalização de histograma** | Ajusta contraste automaticamente |
| **Ajuste de brilho dinâmico** | Corrige imagens escuras ou claras demais |
| **Sharpening** | Melhora nitidez da imagem |
| **Redimensionamento** | Normaliza para 640px mantendo proporção |

### Threshold Dinâmico

O threshold de reconhecimento é ajustado automaticamente baseado na qualidade da imagem:

| Qualidade | Threshold | Comportamento |
|-----------|-----------|---------------|
| ≥ 0.85 (excelente) | 0.35 | Mais restritivo |
| ≥ 0.70 (boa) | 0.40 | Padrão |
| 0.50-0.70 (média) | 0.40-0.46 | Interpolado |
| < 0.50 (baixa) | até 0.52 | Mais permissivo |

### Análise de Qualidade Detalhada

Cada processamento retorna análise detalhada:

```json
{
  "qualidade": 0.72,
  "qualidadeDetalhada": {
    "scoreDeteccao": 0.95,
    "tamanhoFace": 0.65,
    "proporcaoFace": 0.82,
    "centralizacao": 0.70
  },
  "thresholdRecomendado": 0.43,
  "preprocessado": true
}
```

---

## Otimizações Multi-Plataforma

A API foi otimizada para uso em múltiplos sistemas:

| Recurso | Descrição |
|---------|-----------|
| **Cache Redis** | Encodings faciais são cacheados por 5 minutos |
| **Rate Limiting** | Proteção contra abusos (60/min verificação, 30/min cadastro) |
| **CORS Completo** | Aceita requisições de qualquer origem |
| **Request ID** | Cada requisição tem ID único para rastreamento |
| **Códigos de Erro** | Respostas padronizadas com códigos identificáveis |
| **Headers Expostos** | Rate limit e tempo de resposta nos headers |

---

## Autenticação

### Token Fixo (Sistemas Externos)

Para integração com sistemas externos, use o token fixo de API:

```
Token: bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c
```

> **Aviso:** O token acima é apenas um exemplo para documentação. Em produção, solicite seu token real ao administrador do sistema.

**Header:**
```
Authorization: Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c
```

### Token JWT (Usuários BluePoint)

Para operações internas do BluePoint, use o token JWT do usuário logado (gestor/admin).

---

## Endpoints

### Base URL
```
https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria
```

### Resumo

| Método | Endpoint | Descrição | Auth |
|--------|----------|-----------|------|
| POST | `/cadastrar-face` | Cadastra face | Token API ou JWT |
| POST | `/cadastrar-face-cpf` | Cadastra via CPF (app) | JWT (admin/gestor/rh) |
| POST | `/verificar-face` | Verifica/autentica | Nenhuma |
| POST | `/salvar-foto-reconhecimento` | Salva foto de reconhecimento | JWT |
| GET | `/status/{colaboradorId}` | Status BluePoint | JWT |
| GET | `/status-externo/{externalId}` | Status externo | Token API |
| DELETE | `/remover-face/{colaboradorId}` | Remove BluePoint | JWT (admin) |
| DELETE | `/remover-face-externa` | Remove externo | Token API |

---

## POST /cadastrar-face

Cadastra ou atualiza a face de um colaborador ou usuário externo.

### Rate Limit
- **30 requisições por minuto** por IP

### Autenticação
- **Token Fixo** (sistemas externos): `Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c`
- **Token JWT** (BluePoint): Token de gestor ou admin

### Request

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Body (Colaborador BluePoint):**
```json
{
  "colaboradorId": 1,
  "imagem": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD..."
}
```

**Body (Sistema Externo):**
```json
{
  "externalId": "portal_918",
  "imagem": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD..."
}
```

### Campos

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| colaboradorId | number | Condicional | ID do colaborador BluePoint |
| externalId | string | Condicional | ID externo no formato `prefixo_id` (ex: `portal_918`, `vendas_119`) |
| imagem | string | Sim | Imagem em base64 (jpeg/png) |

> **Nota:** Informe `colaboradorId` OU `externalId`, não ambos. O `externalId` permite associar a mesma biometria a múltiplos sistemas externos.

### Responses

**Sucesso (201):**
```json
{
  "success": true,
  "data": {
    "colaboradorId": null,
    "externalIds": {
      "portal": "918"
    },
    "qualidade": 0.92,
    "mensagem": "Face cadastrada com sucesso",
    "processedIn": 1250
  }
}
```

**Erro - Nenhuma face detectada (400):**
```json
{
  "success": false,
  "error": "Não foi possível detectar a face na imagem",
  "code": "FACE_NOT_DETECTED"
}
```

**Erro - Qualidade baixa (400):**
```json
{
  "success": false,
  "error": "Qualidade da imagem muito baixa. Por favor, capture uma imagem melhor.",
  "code": "LOW_QUALITY",
  "qualidade": 0.35,
  "minQualidade": 0.5
}
```

**Erro - Rate Limit (429):**
```json
{
  "success": false,
  "error": "Limite de requisições excedido. Tente novamente em alguns segundos.",
  "code": "RATE_LIMIT_EXCEEDED"
}
```

### Headers de Resposta

```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 29
X-RateLimit-Reset: 58
X-Request-ID: req_lxyz123_abc456
X-Response-Time: 1250ms
```

### cURL Exemplo

```bash
curl -X POST https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria/cadastrar-face \
  -H "Authorization: Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "portal_918",
    "imagem": "data:image/jpeg;base64,/9j/4AAQ..."
  }'
```

---

## POST /cadastrar-face-cpf

Cadastra a face de um colaborador usando CPF como identificador. **Ideal para aplicativos mobile** onde um administrador/gestor autentica e cadastra a biometria de outros colaboradores.

### Rate Limit
- **20 requisições por minuto** por IP

### Autenticação
- **Bearer Token (JWT)** - Obtido via `/autenticar`
- Usuário deve ter tipo: `admin`, `gestor` ou `rh`

### Fluxo de Autenticação

```
1. POST /api/v1/autenticar
   Body: { "email": "admin@empresa.com", "senha": "..." }
   Response: { "token": "eyJ...", ... }

2. POST /api/v1/biometria/cadastrar-face-cpf
   Header: Authorization: Bearer eyJ...
   Body: { "cpf": "123.456.789-00", "imagem": "data:image/jpeg;base64,..." }
```

### Request

**Headers:**
```
Authorization: Bearer <token_jwt>
Content-Type: application/json
```

**Body:**
```json
{
  "cpf": "123.456.789-00",
  "imagem": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD..."
}
```

### Campos

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| cpf | string | Sim | CPF do colaborador (com ou sem máscara) |
| imagem | string | Sim | Imagem em base64 (jpeg/png) |

### Permissões

Apenas usuários com tipo `admin`, `gestor` ou `rh` podem cadastrar biometria.

### Responses

**Sucesso - Novo cadastro (201):**
```json
{
  "success": true,
  "data": {
    "colaborador": {
      "id": 45,
      "nome": "João Silva",
      "cpf": "123.456.789-00"
    },
    "biometria": {
      "qualidade": 0.78,
      "qualidadeDetalhada": {
        "scoreDeteccao": 0.92,
        "tamanhoFace": 0.75,
        "proporcaoFace": 0.88,
        "centralizacao": 0.65
      },
      "preprocessado": true,
      "atualizado": false
    },
    "cadastradoPor": {
      "id": 1,
      "nome": "Admin Sistema"
    },
    "mensagem": "Biometria facial cadastrada com sucesso",
    "processedIn": 1450
  }
}
```

**Sucesso - Atualização (200):**
```json
{
  "success": true,
  "data": {
    "colaborador": { "id": 45, "nome": "João Silva", "cpf": "123.456.789-00" },
    "biometria": { "qualidade": 0.82, "atualizado": true },
    "mensagem": "Biometria facial atualizada com sucesso"
  }
}
```

**Erro - Token não fornecido (401):**
```json
{
  "success": false,
  "error": "Token não fornecido"
}
```

**Erro - Token inválido (401):**
```json
{
  "success": false,
  "error": "Token inválido ou expirado"
}
```

**Erro - Sem permissão (403):**
```json
{
  "success": false,
  "error": "Você não tem permissão para acessar este recurso"
}
```

**Erro - CPF não encontrado (404):**
```json
{
  "success": false,
  "error": "Colaborador não encontrado com este CPF",
  "code": "COLLABORATOR_NOT_FOUND",
  "cpfInformado": "123.456.789-00"
}
```

**Erro - Qualidade baixa (400):**
```json
{
  "success": false,
  "error": "Qualidade da imagem insuficiente para cadastro. Por favor, capture uma imagem melhor.",
  "code": "LOW_QUALITY",
  "qualidade": 0.32,
  "qualidadeDetalhada": {
    "scoreDeteccao": 0.65,
    "tamanhoFace": 0.40,
    "proporcaoFace": 0.75,
    "centralizacao": 0.30
  },
  "minQualidade": 0.4,
  "dicas": [
    "Aproxime mais o rosto da câmera.",
    "Centralize o rosto na imagem."
  ]
}
```

### Headers de Resposta

```
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 19
X-RateLimit-Reset: 55
```

### cURL Exemplo

```bash
# 1. Primeiro, faça login para obter o token
TOKEN=$(curl -s -X POST https://bluepoint-api.bluetechfilms.com.br/api/v1/autenticar \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@empresa.com", "senha": "Admin@123"}' | jq -r '.token')

# 2. Use o token para cadastrar a face
curl -X POST https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria/cadastrar-face-cpf \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "cpf": "123.456.789-00",
    "imagem": "data:image/jpeg;base64,/9j/4AAQ..."
  }'
```

### Fluxo no App Mobile

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  App Mobile     │     │   BluePoint     │     │   PostgreSQL    │
│  (Tablet)       │────▶│   API           │────▶│                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │
        │  1. POST /autenticar  │
        │  (email + senha)      │
        │ ─────────────────────▶│
        │                       │ Valida credenciais
        │  ◀─ Token JWT ────────│
        │                       │
        │  2. Informa CPF do    │
        │  colaborador          │
        │                       │
        │  3. Captura foto      │
        │  do colaborador       │
        │                       │
        │  4. POST /cadastrar-  │
        │  face-cpf             │
        │  Header: Bearer Token │
        │  Body: cpf + imagem   │
        │ ─────────────────────▶│
        │                       │ Valida JWT
        │                       │ Verifica permissão
        │                       │ Busca por CPF
        │                       │ Processa imagem
        │                       │ Salva encoding
        │                       │
        │  5. Retorna sucesso   │
        │  com dados do         │
        │  colaborador          │
        │ ◀─────────────────────│
```

### Exemplo Flutter/Dart

```dart
class BiometriaAdminService {
  static const String _baseUrl = 'https://bluepoint-api.bluetechfilms.com.br/api/v1';
  
  String? _token;

  /// Faz login do admin e armazena o token
  Future<void> loginAdmin(String email, String senha) async {
    final response = await http.post(
      Uri.parse('$_baseUrl/autenticar'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'email': email,
        'senha': senha,
      }),
    );

    final data = jsonDecode(response.body);
    
    if (response.statusCode != 200) {
      throw Exception(data['error'] ?? 'Erro ao autenticar');
    }
    
    _token = data['token'];
  }

  /// Cadastra face de um colaborador usando CPF
  /// Requer login prévio via loginAdmin()
  Future<Map<String, dynamic>> cadastrarFacePorCpf({
    required String cpf,
    required String imagemBase64,
  }) async {
    if (_token == null) {
      throw Exception('Faça login primeiro');
    }

    final response = await http.post(
      Uri.parse('$_baseUrl/biometria/cadastrar-face-cpf'),
      headers: {
        'Authorization': 'Bearer $_token',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'cpf': cpf,
        'imagem': imagemBase64,
      }),
    );

    final data = jsonDecode(response.body);
    
    if (!data['success']) {
      // Verificar se tem dicas de melhoria
      if (data['dicas'] != null) {
        throw BiometriaException(
          data['error'],
          dicas: List<String>.from(data['dicas']),
        );
      }
      throw Exception(data['error']);
    }
    
    return data['data'];
  }
  
  /// Verifica se está logado
  bool get isLoggedIn => _token != null;
  
  /// Faz logout
  void logout() => _token = null;
}

// Uso:
// final service = BiometriaAdminService();
// await service.loginAdmin('admin@empresa.com', 'senha123');
// final result = await service.cadastrarFacePorCpf(cpf: '123.456.789-00', imagemBase64: '...');
```

---

## POST /verificar-face

Verifica uma face e identifica o usuário. **Endpoint público** - não requer autenticação.

### Rate Limit
- **60 requisições por minuto** por IP

### Request

**Headers:**
```
Content-Type: application/json
```

**Body:**
```json
{
  "imagem": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD..."
}
```

### Responses

**Identificado - Usuário Externo:**
```json
{
  "success": true,
  "data": {
    "identificado": true,
    "tipo": "externo",
    "externalIds": { "portal": "918", "vendas": "119" },
    "confianca": 0.92,
    "token": "eyJhbGciOi...",
    "refreshToken": "52d5c684...",
    "processedIn": 850
  }
}
```

**Identificado - Colaborador BluePoint:**
```json
{
  "success": true,
  "data": {
    "identificado": true,
    "tipo": "bluepoint",
    "colaboradorId": 1,
    "externalIds": { "portal": "918" },
    "colaborador": {
      "id": 1,
      "nome": "João Silva",
      "email": "joao@empresa.com",
      "cargo": "Desenvolvedor",
      "departamento": "TI",
      "perfil": "colaborador",
      "foto": null
    },
    "confianca": 0.89,
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "52d5c6841ce44b4e90b4c5ac3ad56038...",
    "processedIn": 920
  }
}
```

**Não identificado:**
```json
{
  "success": true,
  "data": {
    "identificado": false,
    "mensagem": "Nenhum usuário identificado",
    "code": "NOT_IDENTIFIED",
    "threshold": 0.4,
    "processedIn": 780
  }
}
```

**Erro - Qualidade baixa (400):**
```json
{
  "success": false,
  "error": "Qualidade da imagem muito baixa",
  "code": "LOW_QUALITY"
}
```

### cURL Exemplo

```bash
curl -X POST https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria/verificar-face \
  -H "Content-Type: application/json" \
  -d '{
    "imagem": "data:image/jpeg;base64,/9j/4AAQ..."
  }'
```

---

## POST /salvar-foto-reconhecimento

Salva uma foto de reconhecimento facial no storage para auditoria ou backup. **Útil para manter registro das imagens usadas em verificações.**

### Autenticação
Bearer Token (qualquer usuário autenticado)

### Request

**Headers:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

**Body:**
```json
{
  "colaboradorId": 1,
  "imagem": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD...",
  "tipo": "reconhecimento",
  "marcacaoId": 123,
  "dispositivoId": 5,
  "latitude": -23.5505,
  "longitude": -46.6333
}
```

### Campos

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| colaboradorId | number | Sim | ID do colaborador |
| imagem | string | Sim | Imagem em base64 (jpeg/png/webp) |
| tipo | string | Não | Tipo da foto: "reconhecimento" ou "ponto" (padrão: "reconhecimento") |
| marcacaoId | number | Não | ID da marcação de ponto associada |
| dispositivoId | number | Não | ID do dispositivo que capturou |
| latitude | number | Não | Latitude da captura |
| longitude | number | Não | Longitude da captura |

### Responses

**Sucesso (200):**
```json
{
  "success": true,
  "data": {
    "id": 456,
    "colaboradorId": 1,
    "url": "https://storage.example.com/reconhecimentos/1/2026-01-30/2026-01-30_10-30-45.jpg",
    "caminho": "reconhecimentos/1/2026-01-30/2026-01-30_10-30-45.jpg",
    "tipo": "reconhecimento",
    "tamanhoBytes": 245760,
    "processedIn": 450
  }
}
```

**Erro - Colaborador não encontrado (404):**
```json
{
  "success": false,
  "error": "Colaborador não encontrado",
  "code": "COLLABORATOR_NOT_FOUND"
}
```

### cURL Exemplo

```bash
curl -X POST https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria/salvar-foto-reconhecimento \
  -H "Authorization: Bearer eyJ..." \
  -H "Content-Type: application/json" \
  -d '{
    "colaboradorId": 1,
    "imagem": "data:image/jpeg;base64,/9j/4AAQ...",
    "tipo": "reconhecimento",
    "marcacaoId": 123
  }'
```

### Uso Recomendado

- **Após verificação facial bem-sucedida** para manter registro da imagem usada
- **Integração com sistemas de auditoria** que precisam das fotos originais
- **Backup de imagens** para resolução de disputas sobre marcações

---

## GET /status/{colaboradorId}

Verifica o status de cadastro facial de um colaborador BluePoint.

### Autenticação
Bearer Token (qualquer usuário autenticado)

### Response

**Cadastrado:**
```json
{
  "success": true,
  "data": {
    "colaboradorId": 1,
    "cadastrado": true,
    "qualidade": 0.95,
    "dataCadastro": "2026-01-27T15:00:00.000Z",
    "atualizadoEm": "2026-01-27T15:00:00.000Z"
  }
}
```

**Não cadastrado:**
```json
{
  "success": true,
  "data": {
    "colaboradorId": 1,
    "cadastrado": false
  }
}
```

---

## GET /status-externo/{externalId}

Verifica o status de cadastro facial de um usuário externo.

### Autenticação
Token de API: `Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c`

### Response

**Cadastrado:**
```json
{
  "success": true,
  "data": {
    "externalId": "user_123",
    "cadastrado": true,
    "qualidade": 0.92,
    "dataCadastro": "2026-01-27T15:00:00.000Z",
    "atualizadoEm": "2026-01-27T15:00:00.000Z"
  }
}
```

**Não cadastrado:**
```json
{
  "success": true,
  "data": {
    "externalId": "user_123",
    "cadastrado": false
  }
}
```

### cURL Exemplo

```bash
curl -X GET https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria/status-externo/user_123 \
  -H "Authorization: Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c"
```

---

## DELETE /remover-face/{colaboradorId}

Remove o cadastro facial de um colaborador BluePoint.

### Autenticação
Bearer Token (apenas admin)

### Response

```json
{
  "success": true,
  "data": {
    "mensagem": "Face removida com sucesso",
    "colaboradorId": 1
  }
}
```

---

## DELETE /remover-face-externa

Remove o cadastro facial de um usuário externo.

### Autenticação
Token de API: `Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c`

### Request

```json
{
  "externalId": "user_123"
}
```

### Response

```json
{
  "success": true,
  "data": {
    "mensagem": "Face removida com sucesso",
    "externalId": "user_123"
  }
}
```

### cURL Exemplo

```bash
curl -X DELETE https://bluepoint-api.bluetechfilms.com.br/api/v1/biometria/remover-face-externa \
  -H "Authorization: Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c" \
  -H "Content-Type: application/json" \
  -d '{"externalId": "user_123"}'
```

---

## Estrutura do Banco de Dados

### Tabela `bt_biometria_facial`

```sql
CREATE TABLE bluepoint.bt_biometria_facial (
    id SERIAL PRIMARY KEY,
    colaborador_id INTEGER REFERENCES bluepoint.bt_colaboradores(id),  -- NULL para externos puros
    external_id JSONB DEFAULT '{}'::jsonb,  -- Múltiplos sistemas: {"portal": "918", "vendas": "119"}
    encoding BYTEA,                          -- Dados do encoding facial (128 floats)
    qualidade DECIMAL(3,2),                  -- 0.00 a 1.00
    foto_referencia_url TEXT,
    data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraint: deve ter colaborador_id OU external_id preenchido
    CONSTRAINT chk_biometria_tem_id CHECK (
        colaborador_id IS NOT NULL 
        OR (external_id IS NOT NULL AND external_id != '{}'::jsonb)
    )
);

-- Índice GIN para busca eficiente no JSONB
CREATE INDEX idx_biometria_external_id_gin ON bluepoint.bt_biometria_facial USING GIN (external_id);
```

### Formato do `external_id` (JSONB)

O campo `external_id` armazena um objeto JSON onde:
- **Chave** = prefixo do sistema (ex: `portal`, `vendas`, `rh`)
- **Valor** = ID do usuário naquele sistema

```json
{
  "portal": "918",
  "vendas": "119",
  "rh": "456"
}
```

### Queries Úteis

```sql
-- Buscar por sistema + ID específico
SELECT * FROM bluepoint.bt_biometria_facial 
WHERE external_id ->> 'portal' = '918';

-- Buscar todos que têm vínculo com sistema "vendas"
SELECT * FROM bluepoint.bt_biometria_facial 
WHERE external_id ? 'vendas';

-- Adicionar novo external_id (SEM apagar os existentes)
UPDATE bluepoint.bt_biometria_facial 
SET external_id = external_id || '{"vendas": "119"}'::jsonb 
WHERE id = 5;

-- Remover vínculo de um sistema específico
UPDATE bluepoint.bt_biometria_facial 
SET external_id = external_id - 'portal' 
WHERE id = 5;

-- Listar todos os sistemas vinculados
SELECT id, jsonb_object_keys(external_id) as sistema 
FROM bluepoint.bt_biometria_facial WHERE id = 5;
```

---

## Integração com Sistemas Externos

### Múltiplos Sistemas Externos

A partir da versão 1.3.0, uma mesma biometria pode ser associada a múltiplos sistemas externos simultaneamente:

```json
{
  "externalIds": {
    "portal": "918",
    "vendas": "119",
    "rh": "456"
  }
}
```

**Vantagens:**
- Uma pessoa pode ter acesso a vários sistemas com a mesma face
- Não há duplicação de dados biométricos
- Cada sistema consulta pelo seu prefixo específico

### Formato do `externalId` na Requisição

O `externalId` na requisição deve seguir o formato `prefixo_id`:

| Sistema | ID do Usuário | externalId |
|---------|---------------|------------|
| Portal RH | 918 | `portal_918` |
| App Vendas | 119 | `vendas_119` |
| Sistema RH | 456 | `rh_456` |

> **Importante:** O prefixo identifica o sistema de origem. Use um prefixo único para cada sistema que consome a API.

### Merge Automático de Biometrias

Quando você cadastra uma face com `externalId` e essa face **já existe** no banco (mesmo encoding facial):

1. A API **reconhece** que é a mesma pessoa
2. **Adiciona** o novo `externalId` ao registro existente (não cria duplicado)
3. Retorna todos os `externalIds` vinculados

**Exemplo:** Maria cadastrou face no Portal (`portal_918`). Depois, cadastra no App Vendas (`vendas_119`):

```
Registro ANTES:  { external_id: {"portal": "918"} }
Registro DEPOIS: { external_id: {"portal": "918", "vendas": "119"} }
```

### Fluxo Completo

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Sistema        │     │   BluePoint     │     │   Redis +       │
│  Externo        │────▶│   API           │────▶│   PostgreSQL    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │
        │  1. Cadastrar face    │
        │  (portal_918 + img)   │
        │ ─────────────────────▶│
        │                       │ Salva encoding
        │                       │ external_id: {"portal": "918"}
        │                       │
        │  2. Cadastrar mesmo   │
        │  usuário no vendas    │
        │  (vendas_119 + img)   │
        │ ─────────────────────▶│
        │                       │ Reconhece face existente
        │                       │ Adiciona: {"portal": "918", "vendas": "119"}
        │                       │
        │  3. Verificar face    │
        │  (imagem)             │
        │ ─────────────────────▶│
        │                       │ Busca no cache/banco
        │  4. Retorna todos os  │ Compara encodings
        │  externalIds          │
        │ ◀─────────────────────│
        │                       │
        │  5. Sistema decide    │
        │  qual ID usar baseado │
        │  no prefixo           │
```

### Exemplo JavaScript/TypeScript - Múltiplos Sistemas

```typescript
/**
 * Cadastra face para múltiplos sistemas
 */
async function cadastrarFaceMultiSistema(userIds: { [prefixo: string]: string }, imagemBase64: string) {
  for (const [prefixo, id] of Object.entries(userIds)) {
    const externalId = `${prefixo}_${id}`;
    
    const response = await fetch(`${BLUEPOINT_API}/biometria/cadastrar-face`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        externalId,
        imagem: imagemBase64,
      }),
    });
    
    const result = await response.json();
    
    if (!result.success) {
      console.error(`Erro ao cadastrar ${externalId}:`, result.error);
    } else {
      console.log(`${externalId} cadastrado. ExternalIds atuais:`, result.data.externalIds);
    }
  }
}

/**
 * Verifica face e obtém todos os IDs externos
 */
async function verificarFaceMultiSistema(imagemBase64: string) {
  const response = await fetch(`${BLUEPOINT_API}/biometria/verificar-face`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      imagem: imagemBase64,
    }),
  });
  
  const result = await response.json();
  
  if (result.success && result.data.identificado && result.data.tipo === 'externo') {
    const externalIds = result.data.externalIds;
    console.log('Usuário encontrado com IDs:', externalIds);
    
    // Sistema pode escolher qual ID usar baseado no prefixo
    if (externalIds['portal']) {
      // Logar no portal
      loginPortal(externalIds['portal']);
    }
    if (externalIds['vendas']) {
      // Logar no sistema de vendas
      loginVendas(externalIds['vendas']);
    }
  }
}
```

### Exemplo JavaScript/TypeScript - Uso Básico

```typescript
const BLUEPOINT_API = 'https://bluepoint-api.bluetechfilms.com.br/api/v1';
const API_TOKEN = 'bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c';

/**
 * Cadastra a face de um usuário do SEU sistema
 */
async function cadastrarFace(userId: string, imagemBase64: string) {
  const response = await fetch(`${BLUEPOINT_API}/biometria/cadastrar-face`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      externalId: userId,
      imagem: imagemBase64,
    }),
  });
  
  const result = await response.json();
  
  // Verificar rate limit
  const remaining = response.headers.get('X-RateLimit-Remaining');
  if (remaining && parseInt(remaining) < 5) {
    console.warn('Rate limit baixo:', remaining);
  }
  
  return result;
}

/**
 * Verifica uma face e retorna os IDs externos
 * O sistema deve filtrar pelo SEU prefixo
 */
async function verificarFace(imagemBase64: string, meuPrefixo: string): Promise<string | null> {
  const response = await fetch(`${BLUEPOINT_API}/biometria/verificar-face`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      imagem: imagemBase64,
    }),
  });
  
  const result = await response.json();
  
  if (result.success && result.data.identificado) {
    // Busca o ID do MEU sistema usando o prefixo
    const externalIds = result.data.externalIds || {};
    return externalIds[meuPrefixo] || null;
  }
  
  return null;
}

/**
 * Verifica se um usuário tem face cadastrada
 */
async function verificarStatus(userId: string): Promise<boolean> {
  const response = await fetch(`${BLUEPOINT_API}/biometria/status-externo/${userId}`, {
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });
  
  const result = await response.json();
  return result.success && result.data.cadastrado;
}

/**
 * Remove face cadastrada
 */
async function removerFace(userId: string): Promise<boolean> {
  const response = await fetch(`${BLUEPOINT_API}/biometria/remover-face-externa`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      externalId: userId,
    }),
  });
  
  const result = await response.json();
  return result.success;
}

/**
 * Login completo por reconhecimento facial
 * @param meuPrefixo Prefixo do seu sistema (ex: 'portal')
 */
async function loginPorFace(imagemBase64: string, meuPrefixo: string) {
  const userId = await verificarFace(imagemBase64, meuPrefixo);
  
  if (!userId) {
    throw new Error('Face não reconhecida ou usuário não cadastrado neste sistema');
  }
  
  // Busca o usuário no SEU banco de dados
  const usuario = await seuBanco.findById(userId);
  
  if (!usuario) {
    throw new Error('Usuário não encontrado');
  }
  
  // Cria sessão no SEU sistema
  const sessao = await criarSessaoLocal(usuario);
  
  return { usuario, sessao };
}
```

### Exemplo Flutter/Dart

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';

const String BLUEPOINT_API = 'https://bluepoint-api.bluetechfilms.com.br/api/v1';
const String API_TOKEN = 'bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c';

class BiometriaService {
  final ImagePicker _picker = ImagePicker();

  /// Captura imagem e converte para base64
  Future<String?> capturarImagem() async {
    final XFile? image = await _picker.pickImage(
      source: ImageSource.camera,
      preferredCameraDevice: CameraDevice.front,
      imageQuality: 80,
    );
    
    if (image == null) return null;
    
    final bytes = await image.readAsBytes();
    return 'data:image/jpeg;base64,${base64Encode(bytes)}';
  }

  /// Cadastra face de um usuário
  Future<Map<String, dynamic>> cadastrarFace(String userId) async {
    final imagemBase64 = await capturarImagem();
    if (imagemBase64 == null) {
      throw Exception('Nenhuma imagem capturada');
    }

    final response = await http.post(
      Uri.parse('$BLUEPOINT_API/biometria/cadastrar-face'),
      headers: {
        'Authorization': 'Bearer $API_TOKEN',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'externalId': userId,
        'imagem': imagemBase64,
      }),
    );

    return jsonDecode(response.body);
  }

  /// Verifica face e retorna o ID do usuário para o SEU sistema
  /// [meuPrefixo] é o prefixo do seu sistema (ex: 'portal', 'vendas')
  Future<String?> verificarFace(String meuPrefixo) async {
    final imagemBase64 = await capturarImagem();
    if (imagemBase64 == null) {
      throw Exception('Nenhuma imagem capturada');
    }

    final response = await http.post(
      Uri.parse('$BLUEPOINT_API/biometria/verificar-face'),
      headers: {
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'imagem': imagemBase64,
      }),
    );

    final data = jsonDecode(response.body);
    
    if (data['success'] == true && data['data']['identificado'] == true) {
      // Busca o ID do MEU sistema usando o prefixo
      final externalIds = data['data']['externalIds'] ?? {};
      return externalIds[meuPrefixo];
    }
    
    return null;
  }

  /// Verifica status do cadastro
  Future<bool> verificarStatus(String userId) async {
    final response = await http.get(
      Uri.parse('$BLUEPOINT_API/biometria/status-externo/$userId'),
      headers: {
        'Authorization': 'Bearer $API_TOKEN',
      },
    );

    final data = jsonDecode(response.body);
    return data['success'] == true && data['data']['cadastrado'] == true;
  }

  /// Remove face cadastrada
  Future<bool> removerFace(String userId) async {
    final response = await http.delete(
      Uri.parse('$BLUEPOINT_API/biometria/remover-face-externa'),
      headers: {
        'Authorization': 'Bearer $API_TOKEN',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'externalId': userId,
      }),
    );

    final data = jsonDecode(response.body);
    return data['success'] == true;
  }
}
```

### Exemplo Python

```python
import requests
import base64
from typing import Optional, Dict, Any

BLUEPOINT_API = "https://bluepoint-api.bluetechfilms.com.br/api/v1"
API_TOKEN = "bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c"

def imagem_para_base64(caminho_imagem: str) -> str:
    """Converte arquivo de imagem para base64"""
    with open(caminho_imagem, "rb") as f:
        return f"data:image/jpeg;base64,{base64.b64encode(f.read()).decode()}"

def cadastrar_face(user_id: str, imagem_base64: str) -> Dict[str, Any]:
    """Cadastra face de um usuário"""
    response = requests.post(
        f"{BLUEPOINT_API}/biometria/cadastrar-face",
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
        },
        json={
            "externalId": user_id,
            "imagem": imagem_base64,
        },
        timeout=30,
    )
    return response.json()

def verificar_face(imagem_base64: str, meu_prefixo: str) -> Optional[str]:
    """
    Verifica face e retorna o ID do usuário para o SEU sistema.
    
    Args:
        imagem_base64: Imagem em base64
        meu_prefixo: Prefixo do seu sistema (ex: 'portal', 'vendas')
    
    Returns:
        ID do usuário no seu sistema ou None se não identificado
    """
    response = requests.post(
        f"{BLUEPOINT_API}/biometria/verificar-face",
        headers={"Content-Type": "application/json"},
        json={"imagem": imagem_base64},
        timeout=30,
    )
    
    data = response.json()
    
    if data.get("success") and data.get("data", {}).get("identificado"):
        # Busca o ID do MEU sistema usando o prefixo
        external_ids = data.get("data", {}).get("externalIds", {})
        return external_ids.get(meu_prefixo)
    
    return None

def verificar_status(user_id: str) -> bool:
    """Verifica se usuário tem face cadastrada"""
    response = requests.get(
        f"{BLUEPOINT_API}/biometria/status-externo/{user_id}",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
        timeout=10,
    )
    
    data = response.json()
    return data.get("success") and data.get("data", {}).get("cadastrado")

def remover_face(user_id: str) -> bool:
    """Remove face cadastrada"""
    response = requests.delete(
        f"{BLUEPOINT_API}/biometria/remover-face-externa",
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
        },
        json={"externalId": user_id},
        timeout=10,
    )
    
    data = response.json()
    return data.get("success", False)
```

---

## Fluxo Completo: Cadastro e Login por Reconhecimento Facial

Esta seção explica como um sistema externo deve implementar o fluxo completo de biometria facial.

### 1. Arquitetura

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SEU SISTEMA                                   │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐  │
│  │ Banco de    │    │ Backend     │    │ Frontend/App            │  │
│  │ Dados       │◄──▶│ API         │◄──▶│ (captura foto)          │  │
│  │             │    │             │    │                         │  │
│  │ usuarios    │    │             │    │                         │  │
│  │ - id        │    │             │    │                         │  │
│  │ - nome      │    │             │    │                         │  │
│  │ - email     │    │             │    │                         │  │
│  │ - ...       │    │             │    │                         │  │
│  └─────────────┘    └──────┬──────┘    └─────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  BluePoint API  │
                    │  (biometria)    │
                    └─────────────────┘
```

### 2. Definir seu Prefixo

Cada sistema deve usar um **prefixo único** para identificar seus usuários:

| Sistema | Prefixo | Exemplo de externalId |
|---------|---------|----------------------|
| Portal RH | `portal` | `portal_918` |
| App Vendas | `vendas` | `vendas_119` |
| Sistema Ponto | `ponto` | `ponto_45` |

> **Importante:** O prefixo deve ser **único** entre todos os sistemas que usam a API.

### 3. Fluxo de Cadastro

```
USUÁRIO QUER CADASTRAR BIOMETRIA
         │
         ▼
┌──────────────────────────────────┐
│  1. Usuário já está logado       │
│     no SEU sistema               │
│     (você sabe o ID dele: 918)   │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  2. Frontend captura foto        │
│     (câmera frontal)             │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  3. Backend envia para           │
│     BluePoint API:               │
│                                  │
│     POST /cadastrar-face         │
│     {                            │
│       "externalId": "portal_918",│
│       "imagem": "data:image/..." │
│     }                            │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  4. BluePoint armazena:          │
│     - Encoding facial (128 nums) │
│     - external_id: {"portal":"918"} │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  5. SEU banco pode marcar:       │
│     UPDATE usuarios              │
│     SET biometria_ativa = true   │
│     WHERE id = 918               │
└──────────────────────────────────┘
```

### 4. Fluxo de Login por Reconhecimento Facial

```
USUÁRIO QUER FAZER LOGIN POR FACE
         │
         ▼
┌──────────────────────────────────┐
│  1. Frontend captura foto        │
│     (usuário NÃO está logado)    │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  2. Backend envia para           │
│     BluePoint API:               │
│                                  │
│     POST /verificar-face         │
│     {                            │
│       "imagem": "data:image/..." │
│     }                            │
│                                  │
│     (NÃO precisa auth!)          │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  3. BluePoint retorna:           │
│     {                            │
│       "identificado": true,      │
│       "externalIds": {           │
│         "portal": "918",         │
│         "vendas": "119"          │
│       }                          │
│     }                            │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  4. SEU backend filtra pelo      │
│     SEU prefixo:                 │
│                                  │
│     const meuUserId =            │
│       externalIds['portal'];     │
│     // meuUserId = "918"         │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  5. SEU backend busca usuário:   │
│                                  │
│     SELECT * FROM usuarios       │
│     WHERE id = 918               │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  6. SEU backend cria sessão:     │
│                                  │
│     - Gera JWT/cookie            │
│     - Retorna dados do usuário   │
└──────────────────────────────────┘
```

### 5. Código Completo de Exemplo (Node.js/TypeScript)

```typescript
// config.ts
export const MEU_PREFIXO = 'portal';  // Defina o prefixo do SEU sistema
export const BLUEPOINT_API = 'https://bluepoint-api.bluetechfilms.com.br/api/v1';
export const API_TOKEN = 'bp_bio_...';  // Seu token real

// biometria.service.ts
import { MEU_PREFIXO, BLUEPOINT_API, API_TOKEN } from './config';

/**
 * Cadastra biometria de um usuário do SEU sistema
 * @param userId ID do usuário NO SEU BANCO
 * @param imagemBase64 Foto capturada
 */
export async function cadastrarBiometria(userId: number, imagemBase64: string) {
  const externalId = `${MEU_PREFIXO}_${userId}`;
  
  const response = await fetch(`${BLUEPOINT_API}/biometria/cadastrar-face`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      externalId,
      imagem: imagemBase64,
    }),
  });
  
  const result = await response.json();
  
  if (!result.success) {
    throw new Error(result.error || 'Erro ao cadastrar biometria');
  }
  
  // Opcional: marcar no SEU banco que o usuário tem biometria
  await db.query('UPDATE usuarios SET biometria_ativa = true WHERE id = $1', [userId]);
  
  return result.data;
}

/**
 * Faz login por reconhecimento facial
 * @param imagemBase64 Foto capturada
 * @returns Dados do usuário logado ou null
 */
export async function loginPorFace(imagemBase64: string) {
  // 1. Envia foto para BluePoint (NÃO precisa de auth)
  const response = await fetch(`${BLUEPOINT_API}/biometria/verificar-face`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      imagem: imagemBase64,
    }),
  });
  
  const result = await response.json();
  
  // 2. Verifica se identificou
  if (!result.success || !result.data.identificado) {
    return null;  // Face não reconhecida
  }
  
  // 3. Busca o ID do MEU sistema
  const externalIds = result.data.externalIds || {};
  const meuUserId = externalIds[MEU_PREFIXO];
  
  if (!meuUserId) {
    return null;  // Usuário não cadastrado no MEU sistema
  }
  
  // 4. Busca usuário no MEU banco
  const usuario = await db.query(
    'SELECT id, nome, email FROM usuarios WHERE id = $1 AND ativo = true',
    [meuUserId]
  );
  
  if (!usuario.rows.length) {
    return null;  // Usuário não existe ou inativo
  }
  
  // 5. Cria sessão e retorna
  const token = gerarJWT(usuario.rows[0]);
  
  return {
    usuario: usuario.rows[0],
    token,
    confianca: result.data.confianca,
  };
}

/**
 * Verifica se usuário tem biometria cadastrada
 */
export async function verificarStatusBiometria(userId: number): Promise<boolean> {
  const externalId = `${MEU_PREFIXO}_${userId}`;
  
  const response = await fetch(
    `${BLUEPOINT_API}/biometria/status-externo/${externalId}`,
    {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
      },
    }
  );
  
  const result = await response.json();
  return result.success && result.data.cadastrado;
}

/**
 * Remove biometria de um usuário
 */
export async function removerBiometria(userId: number) {
  const externalId = `${MEU_PREFIXO}_${userId}`;
  
  const response = await fetch(`${BLUEPOINT_API}/biometria/remover-face-externa`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ externalId }),
  });
  
  const result = await response.json();
  
  if (result.success) {
    // Atualiza SEU banco
    await db.query('UPDATE usuarios SET biometria_ativa = false WHERE id = $1', [userId]);
  }
  
  return result.success;
}
```

### 6. Resumo do que Armazenar

| Onde | O que | Exemplo |
|------|-------|---------|
| **BluePoint API** | Encoding facial + externalIds | `{"portal": "918", "vendas": "119"}` |
| **SEU Banco** | Flag `biometria_ativa` (opcional) | `usuarios.biometria_ativa = true` |
| **SEU Código** | Constante com seu prefixo | `MEU_PREFIXO = 'portal'` |

> **Você NÃO precisa armazenar** o encoding facial ou imagens - isso fica na BluePoint API.

---

## Boas Práticas

### Qualidade da Imagem

1. **Iluminação**: Garanta boa iluminação no rosto
2. **Enquadramento**: Rosto centralizado e completo
3. **Resolução**: Mínimo 640x480 pixels
4. **Formato**: JPEG ou PNG
5. **Tamanho**: Máximo recomendado 500KB em base64

### Segurança

1. **Token de API**: Guarde apenas no backend, nunca no frontend
2. **HTTPS**: Sempre use conexão segura
3. **Rate Limiting**: Respeite os limites (60/min verificação, 30/min cadastro)
4. **Logs**: Todas as operações são auditadas

### Performance

1. **Comprimir imagens** antes de enviar (quality 80%)
2. **Usar câmera frontal** para selfies
3. **Timeout recomendado**: 30 segundos
4. **Cache**: Encodings são cacheados por 5 minutos

### Tratamento de Erros

Sempre verifique o campo `code` na resposta de erro:

| Código | Descrição | Ação |
|--------|-----------|------|
| `RATE_LIMIT_EXCEEDED` | Muitas requisições | Aguarde e tente novamente |
| `FACE_NOT_DETECTED` | Nenhuma face na imagem | Solicite nova foto |
| `LOW_QUALITY` | Imagem ruim | Melhore iluminação/foco |
| `VALIDATION_ERROR` | Dados inválidos | Verifique campos |
| `NOT_FOUND` | Recurso não existe | Verifique ID |
| `INTERNAL_ERROR` | Erro no servidor | Tente novamente |

---

## Códigos de Erro HTTP

| Código | Descrição |
|--------|-----------|
| 200 | Sucesso |
| 201 | Criado com sucesso |
| 400 | Requisição inválida |
| 401 | Token inválido ou não fornecido |
| 403 | Sem permissão |
| 404 | Recurso não encontrado |
| 422 | Erro de validação |
| 429 | Rate limit excedido |
| 500 | Erro interno |

---

## Suporte

Em caso de dúvidas ou problemas:
- Verifique os logs da API: `docker compose logs -f api`
- Confirme que a imagem está em base64 válido
- Teste com diferentes condições de iluminação
- Use o `X-Request-ID` retornado para rastreamento

---

## Changelog

### v1.4.0 (2026-02-27)
- Documentação atualizada: em Docker o reconhecimento facial é feito pelo Face Service (Python/InsightFace); em outros ambientes pode ser TensorFlow.js/face-api.js

### v1.3.0 (2026-02-04)
- **external_id transformado em JSONB** para suporte a múltiplos sistemas externos
- Uma mesma biometria pode ser associada a vários sistemas (ex: `{"portal": "918", "vendas": "119"}`)
- **Formato externalId na requisição:** `prefixo_id` (ex: `portal_918`, `vendas_119`)
- **Merge automático:** Se a face já existe, adiciona o novo externalId ao registro existente
- Endpoints atualizados: `cadastrar-face`, `verificar-face`, `status-externo`, `remover-face-externa`
- **Respostas simplificadas:** Apenas `externalIds` (objeto completo) na resposta, sem campo `externalId` duplicado
- Índice GIN para busca eficiente em JSONB
- Constraint: registro deve ter `colaborador_id` OU `external_id` preenchido

### v1.2.0 (2026-01-29)
- **Novo endpoint** `/cadastrar-face-cpf` para cadastro via app mobile
- **Pré-processamento automático de imagem:**
  - Normalização de histograma (contraste)
  - Ajuste dinâmico de brilho
  - Sharpening (nitidez)
  - Redimensionamento inteligente
- **Threshold dinâmico:** ajuste automático baseado na qualidade (0.35-0.52)
- **Análise de qualidade detalhada:** scoreDeteccao, tamanhoFace, proporcaoFace, centralizacao
- **Dicas personalizadas** quando a qualidade é baixa
- Fallback para imagem original se pré-processamento falhar na detecção
- Threshold mínimo de qualidade reduzido (0.25 para verificação, 0.4 para cadastro)

### v1.1.0 (2026-01-28)
- Cache Redis para encodings faciais (TTL 5 min)
- Rate limiting por IP (60/min verificação, 30/min cadastro)
- Novos endpoints: `/status-externo/{externalId}`, `/remover-face-externa`
- Headers padronizados: `X-Request-ID`, `X-RateLimit-*`, `X-Response-Time`
- Códigos de erro consistentes (`FACE_NOT_DETECTED`, `LOW_QUALITY`, etc.)
- Suporte a `externalId` direto na tabela `bt_biometria_facial`
- Invalidação automática do cache ao cadastrar/remover faces

### v1.0.0 (2026-01-27)
- Cadastro e verificação de faces para colaboradores BluePoint
- Integração com TensorFlow.js + face-api.js
- Suporte a token fixo para sistemas externos
- Endpoints básicos de CRUD facial
