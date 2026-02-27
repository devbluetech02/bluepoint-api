import { CategorySpec } from './types';

export const biometriaCategory: CategorySpec = {
  id: 'biometria',
  name: 'Biometria Facial',
  description: 'Cadastro e verificação de faces para autenticação biométrica. Suporta múltiplos sistemas externos.',
  icon: 'Scan',
  endpoints: [
    {
      id: 'cadastrar-face',
      method: 'POST',
      path: '/api/v1/biometria/cadastrar-face',
      summary: 'Cadastrar face',
      description: 'Cadastra face de colaborador BluePoint ou usuário de sistema externo. Suporta múltiplos sistemas externos por biometria.',
      auth: 'both',
      tags: ['biometria'],
      requestBody: {
        required: true,
        schema: {
          colaboradorId: { type: 'number', description: 'ID do colaborador BluePoint (use este OU externalId)' },
          externalId: { type: 'string', description: 'ID externo no formato prefixo_id (ex: portal_918, vendas_119)' },
          imagem: { type: 'string', required: true, description: 'Imagem em base64 (jpeg/png)' },
        },
        example: { externalId: 'portal_918', imagem: 'data:image/jpeg;base64,/9j/4AAQ...' },
      },
      responses: {
        success: { 
          status: 201, 
          description: 'Face cadastrada com sucesso', 
          example: { 
            success: true, 
            data: { 
              colaboradorId: null,
              externalIds: { portal: '918' },
              qualidade: 0.92,
              qualidadeDetalhada: { scoreDeteccao: 0.95, tamanhoFace: 0.88, centralizacao: 0.93 },
              fotoReferencia: 'https://storage.exemplo.com/biometria/externos/portal_918/2026-02-23_10-30-45.jpg',
              operacao: 'insert',
              mensagem: 'Face cadastrada com sucesso',
              processedIn: 1250
            } 
          } 
        },
        errors: [
          { status: 400, code: 'FACE_NOT_DETECTED', message: 'Nenhuma face detectada na imagem' },
          { status: 400, code: 'LOW_QUALITY', message: 'Qualidade da imagem muito baixa' },
          { status: 400, code: 'VALIDATION_ERROR', message: 'Informe colaboradorId ou externalId' },
          { status: 409, code: 'FACE_ALREADY_EXISTS', message: 'Esta face já está cadastrada para outro usuário' },
          { status: 429, code: 'RATE_LIMIT_EXCEEDED', message: 'Limite de requisições excedido' },
        ],
      },
      tutorial: `## Cadastro Biométrico

### Modos de Cadastro

**1. Colaborador BluePoint:**
\`\`\`javascript
{ colaboradorId: 123, imagem: 'data:image/jpeg;base64,...' }
\`\`\`

**2. Sistema Externo:**
\`\`\`javascript
{ externalId: 'portal_918', imagem: 'data:image/jpeg;base64,...' }
\`\`\`

### Formato do externalId
O \`externalId\` deve seguir o formato \`prefixo_id\`:
- \`portal_918\` → sistema "portal", usuário "918"
- \`vendas_119\` → sistema "vendas", usuário "119"

### Múltiplos Sistemas
Uma mesma face pode ser associada a vários sistemas. Se a face já existir:
- O sistema adiciona o novo \`externalId\` ao registro existente
- Não cria duplicados

### Qualidade da Imagem
| Score | Classificação |
|-------|--------------|
| >= 0.85 | Excelente |
| >= 0.70 | Boa |
| >= 0.50 | Aceitável |
| < 0.50 | Recusada |

### Exemplo Completo
\`\`\`javascript
const response = await fetch('/api/v1/biometria/cadastrar-face', {
  method: 'POST',
  headers: { 
    'Authorization': 'Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ 
    externalId: 'vendas_119', 
    imagem: 'data:image/jpeg;base64,...' 
  })
});

const { data } = await response.json();
console.log(data.externalIds); // { portal: '918', vendas: '119' }
\`\`\``,
    },
    {
      id: 'cadastrar-face-cpf',
      method: 'POST',
      path: '/api/v1/biometria/cadastrar-face-cpf',
      summary: 'Cadastrar face por CPF',
      description: 'Cadastra face de colaborador usando CPF. Ideal para apps mobile onde admin cadastra colaboradores.',
      auth: 'jwt',
      tags: ['biometria'],
      requestBody: {
        required: true,
        schema: {
          cpf: { type: 'string', required: true, description: 'CPF do colaborador (com ou sem máscara)' },
          imagem: { type: 'string', required: true, description: 'Imagem em base64 (jpeg/png)' },
        },
        example: { cpf: '123.456.789-00', imagem: 'data:image/jpeg;base64,...' },
      },
      responses: {
        success: { 
          status: 201, 
          description: 'Face cadastrada', 
          example: { 
            success: true, 
            data: { 
              colaborador: { id: 45, nome: 'João Silva', cpf: '123.456.789-00' },
              biometria: { qualidade: 0.78, atualizado: false },
              cadastradoPor: { id: 1, nome: 'Admin' },
              mensagem: 'Biometria facial cadastrada com sucesso'
            } 
          } 
        },
        errors: [
          { status: 401, code: 'UNAUTHORIZED', message: 'Token não fornecido ou inválido' },
          { status: 403, code: 'FORBIDDEN', message: 'Sem permissão (requer admin/gestor/rh)' },
          { status: 404, code: 'COLLABORATOR_NOT_FOUND', message: 'Colaborador não encontrado com este CPF' },
          { status: 400, code: 'LOW_QUALITY', message: 'Qualidade da imagem insuficiente' },
        ],
      },
      tutorial: `## Cadastro por CPF (App Mobile)

### Permissões Necessárias
Usuário deve ter tipo: \`admin\`, \`gestor\` ou \`rh\`

### Fluxo
1. Login do admin → obter token JWT
2. Informar CPF do colaborador
3. Capturar foto do colaborador
4. Enviar para API

### Exemplo
\`\`\`javascript
// 1. Login
const loginRes = await fetch('/api/v1/autenticar', {
  method: 'POST',
  body: JSON.stringify({ email: 'admin@empresa.com', senha: '...' })
});
const { token } = await loginRes.json();

// 2. Cadastrar face
const res = await fetch('/api/v1/biometria/cadastrar-face-cpf', {
  method: 'POST',
  headers: { 
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ 
    cpf: '123.456.789-00', 
    imagem: 'data:image/jpeg;base64,...' 
  })
});
\`\`\``,
    },
    {
      id: 'verificar-face',
      method: 'POST',
      path: '/api/v1/biometria/verificar-face',
      summary: 'Verificar face',
      description: 'Identifica usuário por reconhecimento facial. Retorna colaborador BluePoint ou IDs externos. Endpoint público.',
      auth: 'none',
      tags: ['biometria'],
      requestBody: {
        required: true,
        schema: {
          imagem: { type: 'string', required: true, description: 'Imagem em base64 (jpeg/png)' },
          dispositivoCodigo: { type: 'string', description: 'Código do dispositivo (6 chars)' },
          registrarPonto: { type: 'boolean', description: 'Registrar ponto automaticamente (apenas BluePoint)' },
          tipoPonto: { type: 'string', description: 'Tipo de ponto (auto-detectado se não informado)', enum: ['entrada', 'saida', 'almoco', 'retorno'] },
          latitude: { type: 'number', description: 'Latitude GPS' },
          longitude: { type: 'number', description: 'Longitude GPS' },
        },
        example: { imagem: 'data:image/jpeg;base64,...' },
      },
      responses: {
        success: {
          status: 200,
          description: 'Face verificada',
          example: {
            success: true,
            data: {
              identificado: true,
              tipo: 'bluepoint',
              colaboradorId: 45,
              externalIds: { portal: '918', vendas: '119' },
              colaborador: {
                id: 45,
                nome: 'João Silva',
                email: 'joao@empresa.com',
                cargo: { id: 5, nome: 'Desenvolvedor' },
                departamento: 'Tecnologia',
                perfil: 'colaborador',
                foto: null,
              },
              confianca: 0.92,
              token: 'eyJhbGciOiJIUzI1NiIs...',
              refreshToken: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
              pontoRegistrado: null,
              processedIn: 850,
            },
          },
        },
        errors: [
          { status: 400, code: 'FACE_NOT_DETECTED', message: 'Nenhuma face detectada' },
          { status: 400, code: 'LOW_QUALITY', message: 'Qualidade da imagem muito baixa' },
        ],
      },
      tutorial: `## Verificação Facial

### Tipos de Resposta

A resposta sempre inclui \`externalIds\` — um objeto JSONB com os IDs de **todos** os sistemas externos vinculados àquela face.

**1. Colaborador BluePoint identificado (com vínculos externos):**
\`\`\`json
{
  "identificado": true,
  "tipo": "bluepoint",
  "colaboradorId": 45,
  "externalIds": { "portal": "918", "vendas": "119" },
  "colaborador": {
    "id": 45,
    "nome": "João Silva",
    "email": "joao@empresa.com",
    "cargo": { "id": 5, "nome": "Desenvolvedor" },
    "departamento": "Tecnologia",
    "perfil": "colaborador",
    "foto": null
  },
  "confianca": 0.92,
  "token": "eyJhbGciOi...",
  "refreshToken": "a1b2c3d4-...",
  "pontoRegistrado": null,
  "processedIn": 850
}
\`\`\`

**2. Usuário Externo identificado (sem colaborador BluePoint):**
\`\`\`json
{
  "identificado": true,
  "tipo": "externo",
  "colaboradorId": null,
  "externalIds": { "portal": "918", "vendas": "119" },
  "colaborador": null,
  "confianca": 0.88,
  "token": "eyJhbGciOi...",
  "refreshToken": "a1b2c3d4-...",
  "pontoRegistrado": null,
  "processedIn": 750
}
\`\`\`

**3. Não identificado:**
\`\`\`json
{
  "identificado": false,
  "tipo": null,
  "colaboradorId": null,
  "externalId": null,
  "colaborador": null,
  "confianca": 0,
  "token": null,
  "refreshToken": null,
  "pontoRegistrado": null,
  "mensagem": "Nenhum usuário identificado",
  "code": "NOT_IDENTIFIED",
  "qualidadeCaptura": 0.65,
  "thresholdUtilizado": 0.68,
  "processedIn": 900
}
\`\`\`

**4. Com registro de ponto:**
\`\`\`json
{
  "identificado": true,
  "tipo": "bluepoint",
  "colaboradorId": 45,
  "externalIds": { "portal": "918" },
  "colaborador": { "..." : "..." },
  "confianca": 0.92,
  "token": "eyJ...",
  "refreshToken": "...",
  "pontoRegistrado": {
    "marcacaoId": 789,
    "tipo": "entrada",
    "tipoDetectadoAutomaticamente": true,
    "sequencia": 1,
    "dispositivoId": 10,
    "dispositivoNome": "Totem Recepção",
    "dataHora": "2026-02-23T08:00:00.000Z"
  },
  "processedIn": 1200
}
\`\`\`

### O campo externalIds
A coluna \`external_id\` no banco é JSONB. Cada chave é o prefixo do sistema e o valor é o ID do usuário naquele sistema. Uma mesma face pode estar vinculada a vários sistemas simultaneamente:
\`\`\`json
{ "portal": "918", "vendas": "119", "app": "usr_42" }
\`\`\`

Sistemas externos devem filtrar pelo seu prefixo:
\`\`\`javascript
const { externalIds } = data;
const meuUserId = externalIds['portal']; // '918'
\`\`\``,
    },
    {
      id: 'salvar-foto-reconhecimento',
      method: 'POST',
      path: '/api/v1/biometria/salvar-foto-reconhecimento',
      summary: 'Salvar foto do reconhecimento',
      description: 'Salva foto usada no reconhecimento facial para auditoria. Útil para backup e resolução de disputas.',
      auth: 'jwt',
      tags: ['biometria'],
      requestBody: {
        required: true,
        schema: {
          colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' },
          imagem: { type: 'string', required: true, description: 'Imagem em base64 (jpeg/png/webp)' },
          tipo: { type: 'string', description: 'Tipo da foto', enum: ['reconhecimento', 'ponto'] },
          marcacaoId: { type: 'number', description: 'ID da marcação de ponto associada' },
          dispositivoId: { type: 'number', description: 'ID do dispositivo que capturou' },
          latitude: { type: 'number', description: 'Latitude da captura' },
          longitude: { type: 'number', description: 'Longitude da captura' },
        },
        example: { colaboradorId: 1, imagem: 'data:image/jpeg;base64,...', tipo: 'ponto', marcacaoId: 123 },
      },
      responses: {
        success: { 
          status: 200, 
          description: 'Foto salva', 
          example: { 
            success: true, 
            data: { 
              id: 456,
              colaboradorId: 1,
              url: 'https://storage.example.com/reconhecimentos/1/2026-01-30/...',
              tipo: 'ponto',
              tamanhoBytes: 245760,
              processedIn: 450
            } 
          } 
        },
        errors: [{ status: 404, code: 'COLLABORATOR_NOT_FOUND', message: 'Colaborador não encontrado' }],
      },
    },
    {
      id: 'status-biometria',
      method: 'GET',
      path: '/api/v1/biometria/status/{colaboradorId}',
      summary: 'Status da biometria (BluePoint)',
      description: 'Verifica se colaborador BluePoint tem face cadastrada.',
      auth: 'jwt',
      tags: ['biometria'],
      pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador BluePoint' } },
      responses: {
        success: { 
          status: 200, 
          description: 'Status retornado', 
          example: { 
            success: true, 
            data: { 
              colaboradorId: 1, 
              cadastrado: true, 
              qualidade: 0.92,
              dataCadastro: '2026-01-27T15:00:00.000Z',
              atualizadoEm: '2026-01-27T15:00:00.000Z'
            } 
          } 
        },
        errors: [{ status: 404, code: 'NOT_FOUND', message: 'Colaborador não encontrado' }],
      },
    },
    {
      id: 'status-biometria-externo',
      method: 'GET',
      path: '/api/v1/biometria/status-externo/{externalId}',
      summary: 'Status da biometria (Externo)',
      description: 'Verifica se usuário externo tem face cadastrada. Use formato prefixo_id.',
      auth: 'api_key',
      tags: ['biometria'],
      pathParams: { externalId: { type: 'string', required: true, description: 'ID externo (formato: prefixo_id, ex: portal_918)' } },
      responses: {
        success: { 
          status: 200, 
          description: 'Status retornado', 
          example: { 
            success: true, 
            data: { 
              externalId: 'portal_918', 
              cadastrado: true, 
              qualidade: 0.92,
              externalIds: { portal: '918', vendas: '119' },
              dataCadastro: '2026-01-27T15:00:00.000Z'
            } 
          } 
        },
        errors: [{ status: 404, code: 'NOT_FOUND', message: 'Biometria não encontrada' }],
      },
      tutorial: `## Verificar Status de Usuário Externo

### URL
\`GET /api/v1/biometria/status-externo/{prefixo}_{id}\`

### Exemplo
\`\`\`bash
curl -X GET /api/v1/biometria/status-externo/portal_918 \\
  -H "Authorization: Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c"
\`\`\`

### Resposta
A resposta inclui \`externalIds\` com todos os sistemas vinculados:
\`\`\`json
{
  "externalId": "portal_918",
  "cadastrado": true,
  "externalIds": { "portal": "918", "vendas": "119" }
}
\`\`\``,
    },
    {
      id: 'remover-face',
      method: 'DELETE',
      path: '/api/v1/biometria/remover-face/{colaboradorId}',
      summary: 'Remover biometria (BluePoint)',
      description: 'Remove cadastro facial de colaborador BluePoint. Requer permissão de admin.',
      auth: 'jwt',
      tags: ['biometria'],
      pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador BluePoint' } },
      responses: {
        success: { status: 200, description: 'Biometria removida', example: { success: true, data: { mensagem: 'Face removida com sucesso', colaboradorId: 1 } } },
        errors: [
          { status: 403, code: 'FORBIDDEN', message: 'Sem permissão (requer admin)' },
          { status: 404, code: 'NOT_FOUND', message: 'Biometria não encontrada' },
        ],
      },
    },
    {
      id: 'remover-face-externa',
      method: 'DELETE',
      path: '/api/v1/biometria/remover-face-externa',
      summary: 'Remover biometria (Externo)',
      description: 'Remove vínculo de sistema externo. Se for o único vínculo e não tiver colaborador_id, remove o registro todo.',
      auth: 'api_key',
      tags: ['biometria'],
      requestBody: {
        required: true,
        schema: {
          externalId: { type: 'string', required: true, description: 'ID externo (formato: prefixo_id)' },
        },
        example: { externalId: 'portal_918' },
      },
      responses: {
        success: { 
          status: 200, 
          description: 'Vínculo removido', 
          example: { 
            success: true, 
            data: { 
              mensagem: 'Face removida com sucesso', 
              externalId: 'portal_918' 
            } 
          } 
        },
        errors: [
          { status: 400, code: 'VALIDATION_ERROR', message: 'Formato inválido para externalId' },
          { status: 404, code: 'NOT_FOUND', message: 'Biometria não encontrada' },
        ],
      },
      tutorial: `## Remover Biometria Externa

### Comportamento
- Se o registro tem **outros externalIds** ou **colaborador_id**: remove apenas o vínculo do sistema solicitado
- Se é o **único vínculo**: remove o registro completo

### Exemplo
\`\`\`bash
curl -X DELETE /api/v1/biometria/remover-face-externa \\
  -H "Authorization: Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c" \\
  -H "Content-Type: application/json" \\
  -d '{"externalId": "portal_918"}'
\`\`\`

### Cenários

**Antes:** \`{ external_id: {"portal": "918", "vendas": "119"} }\`
**Remover:** \`portal_918\`
**Depois:** \`{ external_id: {"vendas": "119"} }\` (registro mantido)

**Antes:** \`{ external_id: {"portal": "918"}, colaborador_id: null }\`
**Remover:** \`portal_918\`
**Depois:** Registro deletado completamente`,
    },
  ],
};
