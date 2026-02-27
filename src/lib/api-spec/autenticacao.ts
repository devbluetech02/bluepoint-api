import { CategorySpec } from './types';

export const autenticacaoCategory: CategorySpec = {
  id: 'autenticacao',
  name: 'Autenticação',
  description: 'Login, logout, tokens e API keys',
  icon: 'Lock',
  endpoints: [
    {
      id: 'autenticar',
      method: 'POST',
      path: '/api/v1/autenticar',
      summary: 'Realizar login',
      description: 'Autentica com email/senha e retorna tokens JWT.',
      auth: 'none',
      tags: ['autenticacao'],
      requestBody: {
        required: true,
        schema: {
          email: { type: 'string', required: true, description: 'Email do usuário' },
          senha: { type: 'string', required: true, description: 'Senha' },
        },
        example: { email: 'usuario@empresa.com', senha: 'minhasenha123' },
      },
      responses: {
        success: {
          status: 200,
          description: 'Login realizado',
          example: {
            success: true,
            data: {
              token: 'eyJhbGciOiJIUzI1NiIs...',
              refreshToken: 'a1b2c3d4e5f6...',
              usuario: { id: 1, nome: 'João', email: 'usuario@empresa.com', tipo: 'colaborador', foto: '/storage/fotos/1.jpg' },
            },
          },
        },
        errors: [
          { status: 400, code: 'VALIDATION_ERROR', message: 'Credenciais inválidas' },
          { status: 401, code: 'UNAUTHORIZED', message: 'Email ou senha inválidos' },
        ],
      },
      tutorial: `## Fluxo de Autenticação

### 1. Login
\`\`\`bash
curl -X POST /api/v1/autenticar \\
  -H "Content-Type: application/json" \\
  -d '{"email": "usuario@empresa.com", "senha": "minhasenha123"}'
\`\`\`

### 2. Usando o Token
\`\`\`bash
curl -X GET /api/v1/listar-colaboradores \\
  -H "Authorization: Bearer eyJhbGciOi..."
\`\`\`

### 3. Renovando
\`\`\`bash
curl -X POST /api/v1/renovar-token \\
  -d '{"refreshToken": "a1b2c3d4e5f6..."}'
\`\`\``,
    },
    {
      id: 'deslogar',
      method: 'POST',
      path: '/api/v1/deslogar',
      summary: 'Realizar logout',
      auth: 'both',
      tags: ['autenticacao'],
      requestBody: {
        required: true,
        schema: { refreshToken: { type: 'string', required: true, description: 'Refresh token' } },
        example: { refreshToken: 'a1b2c3d4e5f6...' },
      },
      responses: {
        success: { status: 200, description: 'Logout realizado', example: { success: true } },
        errors: [{ status: 401, code: 'UNAUTHORIZED', message: 'Token inválido' }],
      },
    },
    {
      id: 'renovar-token',
      method: 'POST',
      path: '/api/v1/renovar-token',
      summary: 'Renovar token JWT',
      auth: 'none',
      tags: ['autenticacao'],
      requestBody: {
        required: true,
        schema: { refreshToken: { type: 'string', required: true, description: 'Refresh token válido' } },
        example: { refreshToken: 'a1b2c3d4e5f6...' },
      },
      responses: {
        success: { status: 200, description: 'Token renovado', example: { success: true, data: { token: 'novo_token...', refreshToken: 'novo_refresh...' } } },
        errors: [{ status: 401, code: 'INVALID_REFRESH_TOKEN', message: 'Token expirado ou inválido' }],
      },
    },
    {
      id: 'alterar-senha',
      method: 'POST',
      path: '/api/v1/alterar-senha',
      summary: 'Alterar senha',
      auth: 'both',
      tags: ['autenticacao'],
      requestBody: {
        required: true,
        schema: {
          senhaAtual: { type: 'string', required: true, description: 'Senha atual' },
          novaSenha: { type: 'string', required: true, description: 'Nova senha (mín. 6 caracteres)' },
          confirmarSenha: { type: 'string', required: true, description: 'Confirmação' },
        },
        example: { senhaAtual: 'senha123', novaSenha: 'novasenha456', confirmarSenha: 'novasenha456' },
      },
      responses: {
        success: { status: 200, description: 'Senha alterada', example: { success: true } },
        errors: [{ status: 400, code: 'PASSWORD_MISMATCH', message: 'Senhas não conferem' }],
      },
    },
    {
      id: 'solicitar-recuperacao-senha',
      method: 'POST',
      path: '/api/v1/solicitar-recuperacao-senha',
      summary: 'Solicitar recuperação de senha',
      auth: 'none',
      tags: ['autenticacao'],
      requestBody: {
        required: true,
        schema: { email: { type: 'string', required: true, description: 'Email cadastrado' } },
        example: { email: 'usuario@empresa.com' },
      },
      responses: {
        success: { status: 200, description: 'Email enviado', example: { success: true, message: 'Instruções enviadas por email' } },
        errors: [],
      },
    },
    {
      id: 'redefinir-senha',
      method: 'POST',
      path: '/api/v1/redefinir-senha',
      summary: 'Redefinir senha',
      auth: 'none',
      tags: ['autenticacao'],
      requestBody: {
        required: true,
        schema: {
          token: { type: 'string', required: true, description: 'Token de recuperação' },
          novaSenha: { type: 'string', required: true, description: 'Nova senha' },
          confirmarSenha: { type: 'string', required: true, description: 'Confirmação' },
        },
        example: { token: 'abc123...', novaSenha: 'novasenha', confirmarSenha: 'novasenha' },
      },
      responses: {
        success: { status: 200, description: 'Senha redefinida', example: { success: true } },
        errors: [{ status: 400, code: 'INVALID_TOKEN', message: 'Token inválido ou expirado' }],
      },
    },
    {
      id: 'listar-api-keys',
      method: 'GET',
      path: '/api/v1/api-keys',
      summary: 'Listar API keys',
      auth: 'both',
      tags: ['autenticacao', 'api-keys'],
      responses: {
        success: { status: 200, description: 'Lista', example: { success: true, data: [{ id: 1, nome: 'App Mobile', status: 'ativo' }] } },
        errors: [{ status: 403, code: 'FORBIDDEN', message: 'Apenas admin' }],
      },
    },
    {
      id: 'criar-api-key',
      method: 'POST',
      path: '/api/v1/api-keys',
      summary: 'Criar API key',
      auth: 'both',
      tags: ['autenticacao', 'api-keys'],
      requestBody: {
        required: true,
        schema: {
          nome: { type: 'string', required: true, description: 'Nome identificador' },
          descricao: { type: 'string', description: 'Descrição' },
        },
        example: { nome: 'Integração ERP', descricao: 'API key para ERP' },
      },
      responses: {
        success: { status: 201, description: 'Criada', example: { success: true, data: { id: 1, key: 'bp_abc123...' } } },
        errors: [{ status: 403, code: 'FORBIDDEN', message: 'Apenas admin' }],
      },
    },
    {
      id: 'excluir-api-key',
      method: 'DELETE',
      path: '/api/v1/api-keys/{id}',
      summary: 'Excluir API key',
      auth: 'both',
      tags: ['autenticacao', 'api-keys'],
      pathParams: { id: { type: 'number', required: true, description: 'ID da API key' } },
      responses: {
        success: { status: 200, description: 'Excluída', example: { success: true } },
        errors: [{ status: 404, code: 'NOT_FOUND', message: 'API key não encontrada' }],
      },
    },
  ],
};
