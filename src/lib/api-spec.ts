// =====================================================
// BluePoint API - Especificação de Endpoints
// =====================================================
// Usado pelo site de documentação (/docs)
// Atualizado: 2026-02-11

export const API_VERSION = '1.4.0';

// =====================================================
// TIPOS
// =====================================================

export interface FieldSpec {
  type: string;
  required?: boolean;
  description: string;
  enum?: string[];
}

export interface EndpointSpec {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  description?: string;
  auth: 'jwt' | 'api_key' | 'both' | 'none';
  pathParams?: Record<string, FieldSpec>;
  queryParams?: Record<string, FieldSpec>;
  requestBody?: {
    required: boolean;
    schema: Record<string, FieldSpec>;
    example: Record<string, unknown>;
  };
  responses: {
    success: {
      status: number;
      description: string;
      example: Record<string, unknown>;
    };
    errors: Array<{
      status: number;
      code: string;
      message: string;
    }>;
  };
  tutorial?: string;
}

export interface ApiCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  endpoints: EndpointSpec[];
}

// =====================================================
// CATEGORIAS E ENDPOINTS
// =====================================================

export const API_CATEGORIES: ApiCategory[] = [
  // =============================================
  // AUTENTICAÇÃO
  // =============================================
  {
    id: 'autenticacao',
    name: 'Autenticação',
    description: 'Login, logout, tokens e recuperação de senha',
    icon: 'Lock',
    endpoints: [
      {
        id: 'autenticar',
        method: 'POST',
        path: '/api/v1/autenticar',
        summary: 'Login - retorna JWT e refresh token',
        auth: 'none',
        requestBody: {
          required: true,
          schema: {
            email: { type: 'string', required: true, description: 'Email do usuário' },
            senha: { type: 'string', required: true, description: 'Senha do usuário' },
          },
          example: { email: 'usuario@empresa.com', senha: 'Senha@123' },
        },
        responses: {
          success: {
            status: 200,
            description: 'Login realizado com sucesso',
            example: {
              success: true,
              data: {
                token: 'eyJhbGciOi...',
                refreshToken: 'abc123...',
                usuario: { id: 1, nome: 'Administrador', email: 'admin@bluepoint.com', tipo: 'admin', foto: null },
              },
            },
          },
          errors: [
            { status: 401, code: 'INVALID_CREDENTIALS', message: 'Email ou senha inválidos' },
          ],
        },
        tutorial: `Como autenticar na API:

1. Faça uma requisição POST para /api/v1/autenticar com email e senha
2. Guarde o "token" retornado (JWT) para usar nos próximos requests
3. Envie o token no header: Authorization: Bearer <token>
4. Quando o token expirar, use o "refreshToken" em /api/v1/renovar-token

Importante: Tanto JWT tokens quanto API Keys usam o mesmo header Authorization: Bearer <token>
O sistema detecta automaticamente o tipo de token.`,
      },
      {
        id: 'renovar-token',
        method: 'POST',
        path: '/api/v1/renovar-token',
        summary: 'Renova o token JWT usando refresh token',
        auth: 'none',
        requestBody: {
          required: true,
          schema: {
            refreshToken: { type: 'string', required: true, description: 'Refresh token obtido no login' },
          },
          example: { refreshToken: 'abc123...' },
        },
        responses: {
          success: { status: 200, description: 'Token renovado', example: { success: true, data: { token: 'eyJhbGciOi...', refreshToken: 'novo_refresh...' } } },
          errors: [{ status: 401, code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token inválido ou expirado' }],
        },
      },
      {
        id: 'deslogar',
        method: 'POST',
        path: '/api/v1/deslogar',
        summary: 'Logout - revoga o refresh token',
        auth: 'both',
        requestBody: {
          required: true,
          schema: {
            refreshToken: { type: 'string', required: true, description: 'Refresh token a revogar' },
          },
          example: { refreshToken: 'abc123...' },
        },
        responses: {
          success: { status: 200, description: 'Logout realizado', example: { success: true, data: { mensagem: 'Logout realizado com sucesso' } } },
          errors: [],
        },
      },
      {
        id: 'alterar-senha',
        method: 'POST',
        path: '/api/v1/alterar-senha',
        summary: 'Altera a senha do usuário autenticado',
        auth: 'both',
        requestBody: {
          required: true,
          schema: {
            senhaAtual: { type: 'string', required: true, description: 'Senha atual' },
            novaSenha: { type: 'string', required: true, description: 'Nova senha' },
          },
          example: { senhaAtual: 'SenhaAtual@123', novaSenha: 'NovaSenha@456' },
        },
        responses: {
          success: { status: 200, description: 'Senha alterada', example: { success: true, data: { mensagem: 'Senha alterada com sucesso' } } },
          errors: [{ status: 401, code: 'INVALID_PASSWORD', message: 'Senha atual incorreta' }],
        },
      },
      {
        id: 'solicitar-recuperacao-senha',
        method: 'POST',
        path: '/api/v1/solicitar-recuperacao-senha',
        summary: 'Envia email de recuperação de senha',
        auth: 'none',
        requestBody: {
          required: true,
          schema: {
            email: { type: 'string', required: true, description: 'Email do usuário' },
          },
          example: { email: 'usuario@empresa.com' },
        },
        responses: {
          success: { status: 200, description: 'Email enviado', example: { success: true, data: { mensagem: 'Email de recuperação enviado' } } },
          errors: [],
        },
      },
      {
        id: 'redefinir-senha',
        method: 'POST',
        path: '/api/v1/redefinir-senha',
        summary: 'Redefine a senha com token de recuperação',
        auth: 'none',
        requestBody: {
          required: true,
          schema: {
            token: { type: 'string', required: true, description: 'Token de recuperação recebido por email' },
            novaSenha: { type: 'string', required: true, description: 'Nova senha' },
          },
          example: { token: 'token_recuperacao...', novaSenha: 'NovaSenha@123' },
        },
        responses: {
          success: { status: 200, description: 'Senha redefinida', example: { success: true, data: { mensagem: 'Senha redefinida com sucesso' } } },
          errors: [{ status: 400, code: 'INVALID_TOKEN', message: 'Token inválido ou expirado' }],
        },
      },
      {
        id: 'resetar-senha',
        method: 'POST',
        path: '/api/v1/resetar-senha/{id}',
        summary: 'Admin reseta senha de colaborador',
        auth: 'jwt',
        pathParams: {
          id: { type: 'number', required: true, description: 'ID do colaborador' },
        },
        responses: {
          success: { status: 200, description: 'Senha resetada', example: { success: true, data: { mensagem: 'Senha resetada com sucesso' } } },
          errors: [{ status: 403, code: 'FORBIDDEN', message: 'Apenas administradores' }],
        },
      },
    ],
  },

  // =============================================
  // COLABORADORES
  // =============================================
  {
    id: 'colaboradores',
    name: 'Colaboradores',
    description: 'Gerenciamento de colaboradores do sistema',
    icon: 'Users',
    endpoints: [
      {
        id: 'listar-colaboradores',
        method: 'GET',
        path: '/api/v1/listar-colaboradores',
        summary: 'Lista todos os colaboradores (paginado)',
        auth: 'both',
        queryParams: {
          pagina: { type: 'number', description: 'Número da página (padrão: 1)' },
          limite: { type: 'number', description: 'Itens por página (padrão: 50)' },
          busca: { type: 'string', description: 'Busca por nome, email ou CPF' },
          'filtro[departamentoId]': { type: 'number', description: 'Filtrar por departamento' },
          'filtro[status]': { type: 'string', description: 'Filtrar por status', enum: ['ativo', 'inativo'] },
          ordenarPor: { type: 'string', description: 'Campo para ordenar', enum: ['nome', 'email', 'data_admissao', 'criado_em'] },
          ordem: { type: 'string', description: 'Direção da ordenação', enum: ['ASC', 'DESC'] },
        },
        responses: {
          success: {
            status: 200,
            description: 'Lista de colaboradores',
            example: {
              success: true,
              data: [
                {
                  id: 1, nome: 'João Silva', email: 'joao@empresa.com', cpf: '123.456.789-00',
                  empresa: { id: 1, nomeFantasia: 'Minha Empresa' },
                  departamento: { id: 1, nome: 'TI' },
                  jornada: { id: 1, nome: 'Comercial 8h' },
                  cargo: { id: 1, nome: 'Desenvolvedor' }, dataAdmissao: '2024-01-15', status: 'ativo',
                  foto: 'https://...', biometria: { cadastrada: true, cadastradaEm: '2026-02-01' },
                },
              ],
              paginacao: { total: 645, pagina: 1, limite: 50, totalPaginas: 13 },
            },
          },
          errors: [{ status: 401, code: 'UNAUTHORIZED', message: 'Token não fornecido ou inválido' }],
        },
        tutorial: `Como listar colaboradores:

# Com JWT (usuário logado):
curl -X GET "/api/v1/listar-colaboradores" \\
  -H "Authorization: Bearer eyJhbGciOi..."

# Com API Key (integração externa):
curl -X GET "/api/v1/listar-colaboradores" \\
  -H "Authorization: Bearer app_vendedores_803b18..."

# Com filtros:
curl -X GET "/api/v1/listar-colaboradores?busca=joao&filtro[status]=ativo&pagina=1&limite=10" \\
  -H "Authorization: Bearer SEU_TOKEN"

Nota: Tanto JWT quanto API Key usam o mesmo header Authorization: Bearer <token>`,
      },
      {
        id: 'obter-colaborador',
        method: 'GET',
        path: '/api/v1/obter-colaborador/{id}',
        summary: 'Obtém dados de um colaborador',
        auth: 'both',
        pathParams: {
          id: { type: 'number', required: true, description: 'ID do colaborador' },
        },
        responses: {
          success: {
            status: 200,
            description: 'Dados do colaborador',
            example: {
              success: true,
              data: {
                id: 1, nome: 'João Silva', email: 'joao@empresa.com', cpf: '123.456.789-00',
                cargo: { id: 1, nome: 'Desenvolvedor' }, status: 'ativo',
              },
            },
          },
          errors: [{ status: 404, code: 'NOT_FOUND', message: 'Colaborador não encontrado' }],
        },
      },
      {
        id: 'criar-colaborador',
        method: 'POST',
        path: '/api/v1/criar-colaborador',
        summary: 'Cadastra novo colaborador (gestor/admin)',
        auth: 'jwt',
        requestBody: {
          required: true,
          schema: {
            nome: { type: 'string', required: true, description: 'Nome completo' },
            email: { type: 'string', required: true, description: 'Email do colaborador' },
            senha: { type: 'string', required: true, description: 'Senha de acesso' },
            cpf: { type: 'string', required: true, description: 'CPF (com ou sem máscara)' },
            cargoId: { type: 'number', description: 'ID do cargo' },
            dataAdmissao: { type: 'string', description: 'Data de admissão (YYYY-MM-DD)' },
            departamentoId: { type: 'number', description: 'ID do departamento' },
            jornadaId: { type: 'number', description: 'ID da jornada' },
            empresaId: { type: 'number', description: 'ID da empresa' },
          },
          example: {
            nome: 'João Silva', email: 'joao@empresa.com', senha: 'Senha@123',
            cpf: '123.456.789-00', cargoId: 1, dataAdmissao: '2024-01-15',
            departamentoId: 1, jornadaId: 1,
          },
        },
        responses: {
          success: { status: 201, description: 'Colaborador criado', example: { success: true, data: { id: 1, mensagem: 'Colaborador criado com sucesso' } } },
          errors: [
            { status: 400, code: 'VALIDATION_ERROR', message: 'Dados inválidos' },
            { status: 409, code: 'DUPLICATE', message: 'CPF ou email já cadastrado' },
          ],
        },
      },
      {
        id: 'atualizar-colaborador',
        method: 'PUT',
        path: '/api/v1/atualizar-colaborador/{id}',
        summary: 'Atualiza dados do colaborador (gestor/admin)',
        auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID do colaborador' } },
        requestBody: {
          required: true,
          schema: {
            nome: { type: 'string', description: 'Nome completo' },
            email: { type: 'string', description: 'Email' },
            cargoId: { type: 'number', description: 'ID do cargo' },
            status: { type: 'string', description: 'Status', enum: ['ativo', 'inativo'] },
            novaSenha: { type: 'string', description: 'Nova senha (apenas gestores/admins)' },
          },
          example: { nome: 'João Silva Atualizado', cargoId: 2, novaSenha: 'NovaSenha@123' },
        },
        responses: {
          success: { status: 200, description: 'Colaborador atualizado', example: { success: true, data: { mensagem: 'Colaborador atualizado com sucesso' } } },
          errors: [{ status: 404, code: 'NOT_FOUND', message: 'Colaborador não encontrado' }],
        },
      },
      {
        id: 'excluir-colaborador',
        method: 'DELETE',
        path: '/api/v1/excluir-colaborador/{id}',
        summary: 'Remove colaborador - soft delete (admin)',
        auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID do colaborador' } },
        responses: {
          success: { status: 200, description: 'Colaborador removido', example: { success: true, data: { mensagem: 'Colaborador excluído com sucesso' } } },
          errors: [{ status: 404, code: 'NOT_FOUND', message: 'Colaborador não encontrado' }],
        },
      },
      {
        id: 'listar-colaboradores-departamento',
        method: 'GET',
        path: '/api/v1/listar-colaboradores-departamento/{id}',
        summary: 'Lista colaboradores de um departamento',
        auth: 'both',
        pathParams: { id: { type: 'number', required: true, description: 'ID do departamento' } },
        responses: {
          success: { status: 200, description: 'Lista de colaboradores do departamento', example: { success: true, data: [] } },
          errors: [],
        },
      },
      {
        id: 'obter-resumo-colaborador',
        method: 'GET',
        path: '/api/v1/obter-resumo-colaborador/{colaboradorId}',
        summary: 'Resumo com estatísticas do colaborador',
        auth: 'both',
        pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' } },
        responses: {
          success: { status: 200, description: 'Resumo do colaborador', example: { success: true, data: {} } },
          errors: [{ status: 404, code: 'NOT_FOUND', message: 'Colaborador não encontrado' }],
        },
      },
      {
        id: 'atualizar-foto-colaborador',
        method: 'PUT',
        path: '/api/v1/atualizar-foto-colaborador/{id}',
        summary: 'Atualiza foto do colaborador',
        auth: 'both',
        pathParams: { id: { type: 'number', required: true, description: 'ID do colaborador' } },
        responses: {
          success: { status: 200, description: 'Foto atualizada', example: { success: true, data: { mensagem: 'Foto atualizada com sucesso' } } },
          errors: [],
        },
      },
      {
        id: 'obter-foto-colaborador',
        method: 'GET',
        path: '/api/v1/obter-foto-colaborador/{id}',
        summary: 'Obtém foto do colaborador',
        auth: 'both',
        pathParams: { id: { type: 'number', required: true, description: 'ID do colaborador' } },
        responses: {
          success: { status: 200, description: 'URL da foto', example: { success: true, data: { url: 'https://...' } } },
          errors: [{ status: 404, code: 'NOT_FOUND', message: 'Foto não encontrada' }],
        },
      },
    ],
  },

  // =============================================
  // MARCAÇÕES DE PONTO
  // =============================================
  {
    id: 'marcacoes',
    name: 'Marcações de Ponto',
    description: 'Registro e consulta de marcações de ponto',
    icon: 'Clock',
    endpoints: [
      {
        id: 'registrar-entrada',
        method: 'POST',
        path: '/api/v1/registrar-entrada',
        summary: 'Registra entrada do colaborador',
        auth: 'both',
        requestBody: {
          required: true,
          schema: {
            colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' },
            latitude: { type: 'number', description: 'Latitude da marcação' },
            longitude: { type: 'number', description: 'Longitude da marcação' },
            metodo: { type: 'string', description: 'Método de registro', enum: ['web', 'app', 'dispositivo', 'biometria'] },
          },
          example: { colaboradorId: 1, latitude: -23.5505, longitude: -46.6333, metodo: 'web' },
        },
        responses: {
          success: { status: 201, description: 'Entrada registrada', example: { success: true, data: { id: 1, mensagem: 'Entrada registrada com sucesso' } } },
          errors: [{ status: 400, code: 'ALREADY_REGISTERED', message: 'Entrada já registrada hoje' }],
        },
      },
      {
        id: 'registrar-saida',
        method: 'POST',
        path: '/api/v1/registrar-saida',
        summary: 'Registra saída do colaborador',
        auth: 'both',
        requestBody: {
          required: true,
          schema: {
            colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' },
            latitude: { type: 'number', description: 'Latitude da marcação' },
            longitude: { type: 'number', description: 'Longitude da marcação' },
          },
          example: { colaboradorId: 1, latitude: -23.5505, longitude: -46.6333 },
        },
        responses: {
          success: { status: 200, description: 'Saída registrada', example: { success: true, data: { mensagem: 'Saída registrada com sucesso' } } },
          errors: [{ status: 400, code: 'NO_ENTRY', message: 'Nenhuma entrada registrada hoje' }],
        },
      },
      {
        id: 'listar-marcacoes',
        method: 'GET',
        path: '/api/v1/listar-marcacoes',
        summary: 'Lista todas as marcações (paginado)',
        auth: 'both',
        queryParams: {
          pagina: { type: 'number', description: 'Página (padrão: 1)' },
          limite: { type: 'number', description: 'Limite por página (padrão: 50)' },
        },
        responses: {
          success: { status: 200, description: 'Lista de marcações', example: { success: true, data: [], paginacao: {} } },
          errors: [],
        },
      },
      {
        id: 'listar-marcacoes-hoje',
        method: 'GET',
        path: '/api/v1/listar-marcacoes-hoje',
        summary: 'Lista marcações do dia atual',
        auth: 'both',
        responses: {
          success: { status: 200, description: 'Marcações de hoje', example: { success: true, data: [] } },
          errors: [],
        },
      },
      {
        id: 'listar-marcacoes-colaborador',
        method: 'GET',
        path: '/api/v1/listar-marcacoes-colaborador/{colaboradorId}',
        summary: 'Lista marcações de um colaborador',
        auth: 'both',
        pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' } },
        responses: {
          success: { status: 200, description: 'Marcações do colaborador', example: { success: true, data: [] } },
          errors: [],
        },
      },
      {
        id: 'obter-marcacao',
        method: 'GET',
        path: '/api/v1/obter-marcacao/{id}',
        summary: 'Obtém uma marcação específica',
        auth: 'both',
        pathParams: { id: { type: 'number', required: true, description: 'ID da marcação' } },
        responses: {
          success: { status: 200, description: 'Detalhes da marcação', example: { success: true, data: {} } },
          errors: [{ status: 404, code: 'NOT_FOUND', message: 'Marcação não encontrada' }],
        },
      },
      {
        id: 'criar-marcacao',
        method: 'POST',
        path: '/api/v1/criar-marcacao',
        summary: 'Cria marcação manual (gestor/admin)',
        auth: 'jwt',
        responses: {
          success: { status: 201, description: 'Marcação criada', example: { success: true, data: { mensagem: 'Marcação criada com sucesso' } } },
          errors: [],
        },
      },
      {
        id: 'atualizar-marcacao',
        method: 'PUT',
        path: '/api/v1/atualizar-marcacao/{id}',
        summary: 'Atualiza uma marcação (gestor/admin)',
        auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID da marcação' } },
        responses: {
          success: { status: 200, description: 'Marcação atualizada', example: { success: true, data: { mensagem: 'Marcação atualizada' } } },
          errors: [],
        },
      },
      {
        id: 'excluir-marcacao',
        method: 'DELETE',
        path: '/api/v1/excluir-marcacao/{id}',
        summary: 'Remove uma marcação (gestor/admin)',
        auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID da marcação' } },
        responses: {
          success: { status: 200, description: 'Marcação removida', example: { success: true, data: { mensagem: 'Marcação excluída' } } },
          errors: [],
        },
      },
      {
        id: 'validar-geofence',
        method: 'POST',
        path: '/api/v1/validar-geofence',
        summary: 'Valida se localização está no geofence',
        auth: 'both',
        requestBody: {
          required: true,
          schema: {
            latitude: { type: 'number', required: true, description: 'Latitude' },
            longitude: { type: 'number', required: true, description: 'Longitude' },
          },
          example: { latitude: -23.5505, longitude: -46.6333 },
        },
        responses: {
          success: { status: 200, description: 'Resultado da validação', example: { success: true, data: { dentro: true, localizacao: 'Matriz' } } },
          errors: [],
        },
      },
    ],
  },

  // =============================================
  // JORNADAS
  // =============================================
  {
    id: 'jornadas',
    name: 'Jornadas',
    description: 'Jornadas de trabalho e horários',
    icon: 'Calendar',
    endpoints: [
      {
        id: 'listar-jornadas',
        method: 'GET',
        path: '/api/v1/listar-jornadas',
        summary: 'Lista todas as jornadas de trabalho',
        auth: 'both',
        responses: {
          success: { status: 200, description: 'Lista de jornadas', example: { success: true, data: [] } },
          errors: [],
        },
      },
      {
        id: 'obter-jornada',
        method: 'GET',
        path: '/api/v1/obter-jornada/{id}',
        summary: 'Obtém uma jornada específica',
        auth: 'both',
        pathParams: { id: { type: 'number', required: true, description: 'ID da jornada' } },
        responses: {
          success: { status: 200, description: 'Detalhes da jornada', example: { success: true, data: {} } },
          errors: [{ status: 404, code: 'NOT_FOUND', message: 'Jornada não encontrada' }],
        },
      },
      {
        id: 'obter-jornada-colaborador',
        method: 'GET',
        path: '/api/v1/obter-jornada-colaborador/{colaboradorId}',
        summary: 'Obtém jornada atribuída a um colaborador',
        auth: 'both',
        pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' } },
        responses: {
          success: { status: 200, description: 'Jornada do colaborador', example: { success: true, data: {} } },
          errors: [],
        },
      },
      {
        id: 'criar-jornada',
        method: 'POST',
        path: '/api/v1/criar-jornada',
        summary: 'Cria nova jornada de trabalho (gestor/admin)',
        auth: 'jwt',
        requestBody: {
          required: true,
          schema: {
            nome: { type: 'string', required: true, description: 'Nome da jornada' },
            tipo: { type: 'string', required: true, description: 'Tipo: simples ou circular', enum: ['simples', 'circular'] },
            toleranciaEntrada: { type: 'number', description: 'Tolerância de entrada em minutos' },
            toleranciaSaida: { type: 'number', description: 'Tolerância de saída em minutos' },
            horarios: { type: 'array', required: true, description: 'Array de horários' },
          },
          example: {
            nome: 'Comercial 8h', tipo: 'simples', toleranciaEntrada: 10, toleranciaSaida: 10,
            horarios: [{ diaSemana: 1, entrada1: '08:00', saida1: '12:00', entrada2: '13:00', saida2: '18:00', folga: false }],
          },
        },
        responses: {
          success: { status: 201, description: 'Jornada criada', example: { success: true, data: { id: 1, mensagem: 'Jornada criada com sucesso' } } },
          errors: [],
        },
      },
      {
        id: 'atualizar-jornada',
        method: 'PUT',
        path: '/api/v1/atualizar-jornada/{id}',
        summary: 'Atualiza uma jornada (gestor/admin)',
        auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID da jornada' } },
        responses: {
          success: { status: 200, description: 'Jornada atualizada', example: { success: true, data: { mensagem: 'Jornada atualizada' } } },
          errors: [],
        },
      },
      {
        id: 'excluir-jornada',
        method: 'DELETE',
        path: '/api/v1/excluir-jornada/{id}',
        summary: 'Remove uma jornada (admin)',
        auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID da jornada' } },
        responses: {
          success: { status: 200, description: 'Jornada removida', example: { success: true, data: { mensagem: 'Jornada excluída' } } },
          errors: [],
        },
      },
      {
        id: 'atribuir-jornada',
        method: 'POST',
        path: '/api/v1/atribuir-jornada',
        summary: 'Atribui jornada a colaborador(es) (gestor/admin)',
        auth: 'jwt',
        requestBody: {
          required: true,
          schema: {
            jornadaId: { type: 'number', required: true, description: 'ID da jornada' },
            colaboradorIds: { type: 'array', required: true, description: 'IDs dos colaboradores' },
            dataInicio: { type: 'string', description: 'Data de início (YYYY-MM-DD)' },
          },
          example: { jornadaId: 1, colaboradorIds: [2, 3, 4], dataInicio: '2026-01-27' },
        },
        responses: {
          success: { status: 200, description: 'Jornada atribuída', example: { success: true, data: { mensagem: 'Jornada atribuída com sucesso' } } },
          errors: [],
        },
      },
      {
        id: 'acompanhamento-jornada',
        method: 'GET',
        path: '/api/v1/acompanhamento-jornada',
        summary: 'Acompanhamento de jornada (estatísticas)',
        auth: 'both',
        responses: {
          success: { status: 200, description: 'Estatísticas de jornada', example: { success: true, data: {} } },
          errors: [],
        },
      },
    ],
  },

  // =============================================
  // EMPRESAS
  // =============================================
  {
    id: 'empresas',
    name: 'Empresas',
    description: 'Gerenciamento de empresas cadastradas',
    icon: 'Building2',
    endpoints: [
      {
        id: 'listar-empresas',
        method: 'GET',
        path: '/api/v1/listar-empresas',
        summary: 'Lista todas as empresas',
        auth: 'both',
        queryParams: {
          pagina: { type: 'number', description: 'Página' },
          limite: { type: 'number', description: 'Limite' },
          busca: { type: 'string', description: 'Busca por nome fantasia, razão social ou CNPJ' },
        },
        responses: {
          success: { status: 200, description: 'Lista de empresas', example: { success: true, data: [], paginacao: {} } },
          errors: [],
        },
      },
      {
        id: 'obter-empresa',
        method: 'GET',
        path: '/api/v1/obter-empresa/{id}',
        summary: 'Obtém dados de uma empresa',
        auth: 'both',
        pathParams: { id: { type: 'number', required: true, description: 'ID da empresa' } },
        responses: {
          success: { status: 200, description: 'Dados da empresa', example: { success: true, data: {} } },
          errors: [{ status: 404, code: 'NOT_FOUND', message: 'Empresa não encontrada' }],
        },
      },
      {
        id: 'criar-empresa',
        method: 'POST',
        path: '/api/v1/criar-empresa',
        summary: 'Cria nova empresa (admin)',
        auth: 'jwt',
        requestBody: {
          required: true,
          schema: {
            razaoSocial: { type: 'string', required: true, description: 'Razão social' },
            nomeFantasia: { type: 'string', required: true, description: 'Nome fantasia' },
            cnpj: { type: 'string', required: true, description: 'CNPJ' },
          },
          example: { razaoSocial: 'Empresa LTDA', nomeFantasia: 'Minha Empresa', cnpj: '11.222.333/0001-44' },
        },
        responses: {
          success: { status: 201, description: 'Empresa criada', example: { success: true, data: { id: 1, mensagem: 'Empresa criada' } } },
          errors: [],
        },
      },
      {
        id: 'atualizar-empresa',
        method: 'PUT',
        path: '/api/v1/atualizar-empresa/{id}',
        summary: 'Atualiza empresa (admin)',
        auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID da empresa' } },
        responses: {
          success: { status: 200, description: 'Empresa atualizada', example: { success: true, data: { mensagem: 'Empresa atualizada' } } },
          errors: [],
        },
      },
      {
        id: 'excluir-empresa',
        method: 'DELETE',
        path: '/api/v1/excluir-empresa/{id}',
        summary: 'Exclui empresa (admin)',
        auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID da empresa' } },
        responses: {
          success: { status: 200, description: 'Empresa removida', example: { success: true, data: { mensagem: 'Empresa excluída' } } },
          errors: [],
        },
      },
    ],
  },

  // =============================================
  // DEPARTAMENTOS
  // =============================================
  {
    id: 'departamentos',
    name: 'Departamentos',
    description: 'Gerenciamento de departamentos',
    icon: 'Building',
    endpoints: [
      {
        id: 'listar-departamentos', method: 'GET', path: '/api/v1/listar-departamentos', summary: 'Lista todos os departamentos', auth: 'both',
        responses: { success: { status: 200, description: 'Lista de departamentos', example: { success: true, data: [] } }, errors: [] },
      },
      {
        id: 'obter-departamento', method: 'GET', path: '/api/v1/obter-departamento/{id}', summary: 'Obtém um departamento', auth: 'both',
        pathParams: { id: { type: 'number', required: true, description: 'ID do departamento' } },
        responses: { success: { status: 200, description: 'Dados do departamento', example: { success: true, data: {} } }, errors: [{ status: 404, code: 'NOT_FOUND', message: 'Departamento não encontrado' }] },
      },
      {
        id: 'criar-departamento', method: 'POST', path: '/api/v1/criar-departamento', summary: 'Cria departamento (admin)', auth: 'jwt',
        requestBody: { required: true, schema: { nome: { type: 'string', required: true, description: 'Nome' }, descricao: { type: 'string', description: 'Descrição' }, gestorId: { type: 'number', description: 'ID do gestor' } }, example: { nome: 'Tecnologia', descricao: 'Departamento de TI', gestorId: 1 } },
        responses: { success: { status: 201, description: 'Departamento criado', example: { success: true, data: { id: 1 } } }, errors: [] },
      },
      {
        id: 'atualizar-departamento', method: 'PUT', path: '/api/v1/atualizar-departamento/{id}', summary: 'Atualiza departamento (admin)', auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID' } },
        responses: { success: { status: 200, description: 'Atualizado', example: { success: true, data: {} } }, errors: [] },
      },
      {
        id: 'excluir-departamento', method: 'DELETE', path: '/api/v1/excluir-departamento/{id}', summary: 'Remove departamento (admin)', auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID' } },
        responses: { success: { status: 200, description: 'Removido', example: { success: true, data: {} } }, errors: [] },
      },
    ],
  },

  // =============================================
  // CARGOS
  // =============================================
  {
    id: 'cargos',
    name: 'Cargos',
    description: 'Gerenciamento de cargos',
    icon: 'Briefcase',
    endpoints: [
      {
        id: 'listar-cargos', method: 'GET', path: '/api/v1/listar-cargos', summary: 'Lista todos os cargos', auth: 'both',
        responses: { success: { status: 200, description: 'Lista de cargos', example: { success: true, data: [], paginacao: {} } }, errors: [] },
      },
      {
        id: 'obter-cargo', method: 'GET', path: '/api/v1/obter-cargo/{id}', summary: 'Obtém um cargo', auth: 'both',
        pathParams: { id: { type: 'number', required: true, description: 'ID do cargo' } },
        responses: { success: { status: 200, description: 'Dados do cargo', example: { success: true, data: {} } }, errors: [{ status: 404, code: 'NOT_FOUND', message: 'Cargo não encontrado' }] },
      },
      {
        id: 'criar-cargo', method: 'POST', path: '/api/v1/criar-cargo', summary: 'Cadastra novo cargo (admin)', auth: 'jwt',
        requestBody: { required: true, schema: { nome: { type: 'string', required: true, description: 'Nome do cargo' }, cbo: { type: 'string', description: 'Código CBO' }, descricao: { type: 'string', description: 'Descrição' } }, example: { nome: 'Desenvolvedor Full Stack', cbo: '212405', descricao: 'Desenvolve sistemas' } },
        responses: { success: { status: 201, description: 'Cargo criado', example: { success: true, data: { id: 1 } } }, errors: [] },
      },
      {
        id: 'atualizar-cargo', method: 'PUT', path: '/api/v1/atualizar-cargo/{id}', summary: 'Atualiza cargo (admin)', auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID' } },
        responses: { success: { status: 200, description: 'Atualizado', example: { success: true, data: {} } }, errors: [] },
      },
      {
        id: 'excluir-cargo', method: 'DELETE', path: '/api/v1/excluir-cargo/{id}', summary: 'Exclui cargo (admin)', auth: 'jwt',
        pathParams: { id: { type: 'number', required: true, description: 'ID' } },
        responses: { success: { status: 200, description: 'Removido', example: { success: true, data: {} } }, errors: [] },
      },
    ],
  },

  // =============================================
  // FERIADOS
  // =============================================
  {
    id: 'feriados',
    name: 'Feriados',
    description: 'Gerenciamento de feriados',
    icon: 'CalendarDays',
    endpoints: [
      { id: 'listar-feriados', method: 'GET', path: '/api/v1/listar-feriados', summary: 'Lista todos os feriados', auth: 'both', responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
      { id: 'listar-feriados-ano', method: 'GET', path: '/api/v1/listar-feriados-ano/{ano}', summary: 'Lista feriados de um ano', auth: 'both', pathParams: { ano: { type: 'number', required: true, description: 'Ano' } }, responses: { success: { status: 200, description: 'Feriados do ano', example: { success: true, data: [] } }, errors: [] } },
      { id: 'obter-feriado', method: 'GET', path: '/api/v1/obter-feriado/{id}', summary: 'Obtém um feriado', auth: 'both', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Feriado', example: { success: true, data: {} } }, errors: [] } },
      { id: 'criar-feriado', method: 'POST', path: '/api/v1/criar-feriado', summary: 'Cria feriado (admin)', auth: 'jwt', responses: { success: { status: 201, description: 'Criado', example: { success: true, data: {} } }, errors: [] } },
      { id: 'atualizar-feriado', method: 'PUT', path: '/api/v1/atualizar-feriado/{id}', summary: 'Atualiza feriado (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Atualizado', example: { success: true, data: {} } }, errors: [] } },
      { id: 'excluir-feriado', method: 'DELETE', path: '/api/v1/excluir-feriado/{id}', summary: 'Exclui feriado (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Removido', example: { success: true, data: {} } }, errors: [] } },
    ],
  },

  // =============================================
  // LOCALIZAÇÕES
  // =============================================
  {
    id: 'localizacoes',
    name: 'Localizações',
    description: 'Geofences e localizações permitidas',
    icon: 'MapPin',
    endpoints: [
      { id: 'listar-localizacoes', method: 'GET', path: '/api/v1/listar-localizacoes', summary: 'Lista todas as localizações', auth: 'both', responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
      { id: 'obter-localizacao', method: 'GET', path: '/api/v1/obter-localizacao/{id}', summary: 'Obtém uma localização', auth: 'both', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Localização', example: { success: true, data: {} } }, errors: [] } },
      {
        id: 'criar-localizacao', method: 'POST', path: '/api/v1/criar-localizacao', summary: 'Cria localização (admin)', auth: 'jwt',
        requestBody: { required: true, schema: { nome: { type: 'string', required: true, description: 'Nome' }, latitude: { type: 'number', required: true, description: 'Latitude' }, longitude: { type: 'number', required: true, description: 'Longitude' }, raioPermitido: { type: 'number', required: true, description: 'Raio em metros' } }, example: { nome: 'Matriz', latitude: -23.5505, longitude: -46.6333, raioPermitido: 100 } },
        responses: { success: { status: 201, description: 'Criada', example: { success: true, data: {} } }, errors: [] },
      },
      { id: 'atualizar-localizacao', method: 'PUT', path: '/api/v1/atualizar-localizacao/{id}', summary: 'Atualiza localização (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Atualizada', example: { success: true, data: {} } }, errors: [] } },
      { id: 'excluir-localizacao', method: 'DELETE', path: '/api/v1/excluir-localizacao/{id}', summary: 'Exclui localização (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Removida', example: { success: true, data: {} } }, errors: [] } },
    ],
  },

  // =============================================
  // SOLICITAÇÕES
  // =============================================
  {
    id: 'solicitacoes',
    name: 'Solicitações',
    description: 'Férias, ajustes, atestados e mais',
    icon: 'FileText',
    endpoints: [
      { id: 'listar-solicitacoes', method: 'GET', path: '/api/v1/listar-solicitacoes', summary: 'Lista todas as solicitações', auth: 'both', responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [], paginacao: {} } }, errors: [] } },
      { id: 'listar-solicitacoes-pendentes', method: 'GET', path: '/api/v1/listar-solicitacoes-pendentes', summary: 'Lista solicitações pendentes (gestor)', auth: 'jwt', responses: { success: { status: 200, description: 'Pendentes', example: { success: true, data: [] } }, errors: [] } },
      { id: 'listar-solicitacoes-colaborador', method: 'GET', path: '/api/v1/listar-solicitacoes-colaborador/{colaboradorId}', summary: 'Lista solicitações de um colaborador', auth: 'both', pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
      { id: 'obter-solicitacao', method: 'GET', path: '/api/v1/obter-solicitacao/{id}', summary: 'Obtém detalhes de uma solicitação', auth: 'both', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Detalhes', example: { success: true, data: {} } }, errors: [] } },
      { id: 'criar-solicitacao', method: 'POST', path: '/api/v1/criar-solicitacao', summary: 'Cria nova solicitação', auth: 'both', responses: { success: { status: 201, description: 'Criada', example: { success: true, data: {} } }, errors: [] } },
      { id: 'aprovar-solicitacao', method: 'PATCH', path: '/api/v1/aprovar-solicitacao/{id}', summary: 'Aprova solicitação (gestor)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Aprovada', example: { success: true, data: {} } }, errors: [] } },
      { id: 'rejeitar-solicitacao', method: 'PATCH', path: '/api/v1/rejeitar-solicitacao/{id}', summary: 'Rejeita solicitação (gestor)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Rejeitada', example: { success: true, data: {} } }, errors: [] } },
      { id: 'listar-tipos-solicitacao', method: 'GET', path: '/api/v1/listar-tipos-solicitacao', summary: 'Lista tipos de solicitação disponíveis', auth: 'both', responses: { success: { status: 200, description: 'Tipos', example: { success: true, data: [] } }, errors: [] } },
    ],
  },

  // =============================================
  // BIOMETRIA FACIAL
  // =============================================
  {
    id: 'biometria',
    name: 'Biometria Facial',
    description: 'Cadastro e verificação de reconhecimento facial',
    icon: 'Scan',
    endpoints: [
      {
        id: 'cadastrar-face',
        method: 'POST',
        path: '/api/v1/biometria/cadastrar-face',
        summary: 'Cadastra face para reconhecimento facial',
        auth: 'both',
        requestBody: {
          required: true,
          schema: {
            colaboradorId: { type: 'number', description: 'ID do colaborador BluePoint (ou externalId)' },
            externalId: { type: 'string', description: 'ID externo no formato prefixo_id (ex: portal_918)' },
            imagem: { type: 'string', required: true, description: 'Imagem em base64 (jpeg/png)' },
          },
          example: { externalId: 'portal_918', imagem: 'data:image/jpeg;base64,/9j/4AAQ...' },
        },
        responses: {
          success: { status: 201, description: 'Face cadastrada', example: { success: true, data: { qualidade: 0.92, mensagem: 'Face cadastrada com sucesso' } } },
          errors: [
            { status: 400, code: 'FACE_NOT_DETECTED', message: 'Nenhuma face detectada na imagem' },
            { status: 400, code: 'LOW_QUALITY', message: 'Qualidade da imagem muito baixa' },
            { status: 429, code: 'RATE_LIMIT_EXCEEDED', message: 'Limite de requisições excedido' },
          ],
        },
        tutorial: `Autenticação para biometria:

# Com API Key (integrações externas):
curl -X POST "/api/v1/biometria/cadastrar-face" \\
  -H "Authorization: Bearer app_seuapp_chave..." \\
  -H "Content-Type: application/json" \\
  -d '{"externalId": "portal_918", "imagem": "data:image/jpeg;base64,..."}'

# Com JWT (usuários do BluePoint):
curl -X POST "/api/v1/biometria/cadastrar-face" \\
  -H "Authorization: Bearer eyJhbGciOi..." \\
  -H "Content-Type: application/json" \\
  -d '{"colaboradorId": 1, "imagem": "data:image/jpeg;base64,..."}'

# Com token fixo legado de biometria:
curl -X POST "/api/v1/biometria/cadastrar-face" \\
  -H "Authorization: Bearer bp_bio_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c" \\
  -H "Content-Type: application/json" \\
  -d '{"externalId": "portal_918", "imagem": "data:image/jpeg;base64,..."}'

Todos usam o mesmo header Authorization: Bearer <token>`,
      },
      {
        id: 'cadastrar-face-cpf',
        method: 'POST',
        path: '/api/v1/biometria/cadastrar-face-cpf',
        summary: 'Cadastra face via CPF (app mobile)',
        auth: 'both',
        requestBody: {
          required: true,
          schema: {
            cpf: { type: 'string', required: true, description: 'CPF do colaborador' },
            imagem: { type: 'string', required: true, description: 'Imagem em base64' },
          },
          example: { cpf: '123.456.789-00', imagem: 'data:image/jpeg;base64,/9j/4AAQ...' },
        },
        responses: {
          success: { status: 201, description: 'Face cadastrada via CPF', example: { success: true, data: { colaborador: { id: 45, nome: 'João Silva' }, biometria: { qualidade: 0.78 } } } },
          errors: [
            { status: 404, code: 'COLLABORATOR_NOT_FOUND', message: 'Colaborador não encontrado com este CPF' },
            { status: 403, code: 'FORBIDDEN', message: 'Sem permissão (requer admin/gestor/rh)' },
          ],
        },
      },
      {
        id: 'verificar-face',
        method: 'POST',
        path: '/api/v1/biometria/verificar-face',
        summary: 'Verifica/autentica face (público)',
        auth: 'both',
        description: 'Endpoint público para verificação facial. Identifica se a face pertence a um colaborador BluePoint ou usuário externo.',
        requestBody: {
          required: true,
          schema: { imagem: { type: 'string', required: true, description: 'Imagem em base64' } },
          example: { imagem: 'data:image/jpeg;base64,/9j/4AAQ...' },
        },
        responses: {
          success: { status: 200, description: 'Face verificada', example: { success: true, data: { identificado: true, tipo: 'bluepoint', colaborador: { id: 1, nome: 'João' }, confianca: 0.89 } } },
          errors: [{ status: 400, code: 'FACE_NOT_DETECTED', message: 'Nenhuma face detectada' }],
        },
      },
      {
        id: 'status-biometria',
        method: 'GET',
        path: '/api/v1/biometria/status/{colaboradorId}',
        summary: 'Status de biometria do colaborador',
        auth: 'both',
        pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' } },
        responses: {
          success: { status: 200, description: 'Status', example: { success: true, data: { colaboradorId: 1, cadastrado: true, qualidade: 0.95 } } },
          errors: [],
        },
      },
      {
        id: 'status-externo',
        method: 'GET',
        path: '/api/v1/biometria/status-externo/{externalId}',
        summary: 'Status de biometria por ID externo',
        auth: 'both',
        pathParams: { externalId: { type: 'string', required: true, description: 'ID externo (ex: portal_918)' } },
        responses: {
          success: { status: 200, description: 'Status', example: { success: true, data: { externalId: 'portal_918', cadastrado: true } } },
          errors: [],
        },
      },
      {
        id: 'remover-face',
        method: 'DELETE',
        path: '/api/v1/biometria/remover-face/{colaboradorId}',
        summary: 'Remove face de colaborador (admin)',
        auth: 'jwt',
        pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' } },
        responses: {
          success: { status: 200, description: 'Face removida', example: { success: true, data: { mensagem: 'Face removida com sucesso' } } },
          errors: [],
        },
      },
      {
        id: 'remover-face-externa',
        method: 'DELETE',
        path: '/api/v1/biometria/remover-face-externa',
        summary: 'Remove face por ID externo',
        auth: 'both',
        requestBody: {
          required: true,
          schema: { externalId: { type: 'string', required: true, description: 'ID externo a remover' } },
          example: { externalId: 'portal_918' },
        },
        responses: {
          success: { status: 200, description: 'Face removida', example: { success: true, data: { mensagem: 'Face removida com sucesso' } } },
          errors: [],
        },
      },
    ],
  },

  // =============================================
  // NOTIFICAÇÕES
  // =============================================
  {
    id: 'notificacoes',
    name: 'Notificações',
    description: 'Sistema de notificações',
    icon: 'Bell',
    endpoints: [
      { id: 'listar-notificacoes', method: 'GET', path: '/api/v1/listar-notificacoes', summary: 'Lista notificações do usuário', auth: 'both', responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
      { id: 'obter-notificacao', method: 'GET', path: '/api/v1/obter-notificacao/{id}', summary: 'Obtém uma notificação', auth: 'both', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Notificação', example: { success: true, data: {} } }, errors: [] } },
      { id: 'marcar-notificacao-lida', method: 'PATCH', path: '/api/v1/marcar-notificacao-lida/{id}', summary: 'Marca notificação como lida', auth: 'both', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Marcada como lida', example: { success: true, data: {} } }, errors: [] } },
      { id: 'marcar-todas-lidas', method: 'PATCH', path: '/api/v1/marcar-todas-lidas', summary: 'Marca todas como lidas', auth: 'both', responses: { success: { status: 200, description: 'Todas marcadas', example: { success: true, data: {} } }, errors: [] } },
      { id: 'excluir-notificacao', method: 'DELETE', path: '/api/v1/excluir-notificacao/{id}', summary: 'Remove notificação', auth: 'both', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Removida', example: { success: true, data: {} } }, errors: [] } },
    ],
  },

  // =============================================
  // ANEXOS
  // =============================================
  {
    id: 'anexos',
    name: 'Anexos',
    description: 'Upload e gerenciamento de anexos',
    icon: 'Paperclip',
    endpoints: [
      { id: 'enviar-anexo', method: 'POST', path: '/api/v1/enviar-anexo', summary: 'Faz upload de anexo', auth: 'both', responses: { success: { status: 201, description: 'Anexo enviado', example: { success: true, data: {} } }, errors: [] } },
      { id: 'obter-anexo', method: 'GET', path: '/api/v1/obter-anexo/{id}', summary: 'Download de um anexo', auth: 'both', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Anexo', example: { success: true, data: {} } }, errors: [] } },
      { id: 'excluir-anexo', method: 'DELETE', path: '/api/v1/excluir-anexo/{id}', summary: 'Remove um anexo', auth: 'both', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Removido', example: { success: true, data: {} } }, errors: [] } },
      { id: 'listar-anexos-solicitacao', method: 'GET', path: '/api/v1/listar-anexos-solicitacao/{solicitacaoId}', summary: 'Lista anexos de uma solicitação', auth: 'both', pathParams: { solicitacaoId: { type: 'number', required: true, description: 'ID da solicitação' } }, responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
    ],
  },

  // =============================================
  // BANCO DE HORAS
  // =============================================
  {
    id: 'banco-horas',
    name: 'Banco de Horas',
    description: 'Saldos, históricos e horas extras',
    icon: 'Activity',
    endpoints: [
      { id: 'obter-banco-horas', method: 'GET', path: '/api/v1/obter-banco-horas/{colaboradorId}', summary: 'Obtém banco de horas', auth: 'both', pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' } }, responses: { success: { status: 200, description: 'Banco de horas', example: { success: true, data: {} } }, errors: [] } },
      { id: 'obter-saldo-horas', method: 'GET', path: '/api/v1/obter-saldo-horas/{colaboradorId}', summary: 'Obtém saldo de horas', auth: 'both', pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Saldo', example: { success: true, data: {} } }, errors: [] } },
      { id: 'listar-historico-horas', method: 'GET', path: '/api/v1/listar-historico-horas/{colaboradorId}', summary: 'Histórico de movimentações', auth: 'both', pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Histórico', example: { success: true, data: [] } }, errors: [] } },
      { id: 'listar-horas-extras', method: 'GET', path: '/api/v1/listar-horas-extras', summary: 'Lista horas extras', auth: 'both', responses: { success: { status: 200, description: 'Horas extras', example: { success: true, data: [] } }, errors: [] } },
    ],
  },

  // =============================================
  // DISPOSITIVOS
  // =============================================
  {
    id: 'dispositivos',
    name: 'Dispositivos',
    description: 'Gerenciamento de dispositivos de ponto',
    icon: 'Tablet',
    endpoints: [
      { id: 'listar-dispositivos', method: 'GET', path: '/api/v1/dispositivos/listar-dispositivos', summary: 'Lista dispositivos (gestor)', auth: 'jwt', responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
      { id: 'obter-dispositivo', method: 'GET', path: '/api/v1/dispositivos/obter-dispositivo/{id}', summary: 'Obtém dispositivo (gestor)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Dispositivo', example: { success: true, data: {} } }, errors: [] } },
      { id: 'criar-dispositivo', method: 'POST', path: '/api/v1/dispositivos/criar-dispositivo', summary: 'Cria dispositivo (admin)', auth: 'jwt', responses: { success: { status: 201, description: 'Criado', example: { success: true, data: {} } }, errors: [] } },
      { id: 'excluir-dispositivo', method: 'DELETE', path: '/api/v1/dispositivos/excluir-dispositivo/{id}', summary: 'Exclui dispositivo (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Removido', example: { success: true, data: {} } }, errors: [] } },
      { id: 'ativar-dispositivo', method: 'POST', path: '/api/v1/dispositivos/ativar-dispositivo', summary: 'Ativa dispositivo com código', auth: 'both', responses: { success: { status: 200, description: 'Ativado', example: { success: true, data: {} } }, errors: [] } },
      { id: 'regenerar-codigo', method: 'POST', path: '/api/v1/dispositivos/regenerar-codigo/{id}', summary: 'Regenera código de ativação (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Código regenerado', example: { success: true, data: {} } }, errors: [] } },
    ],
  },

  // =============================================
  // RELATÓRIOS
  // =============================================
  {
    id: 'relatorios',
    name: 'Relatórios e Dashboard',
    description: 'Visão geral, espelho de ponto e relatórios',
    icon: 'BarChart3',
    endpoints: [
      { id: 'obter-visao-geral', method: 'GET', path: '/api/v1/obter-visao-geral', summary: 'Dashboard com totalizadores', auth: 'both', responses: { success: { status: 200, description: 'Visão geral', example: { success: true, data: {} } }, errors: [] } },
      { id: 'obter-status-tempo-real', method: 'GET', path: '/api/v1/obter-status-tempo-real', summary: 'Status em tempo real', auth: 'both', responses: { success: { status: 200, description: 'Status', example: { success: true, data: {} } }, errors: [] } },
      { id: 'gerar-espelho-ponto', method: 'GET', path: '/api/v1/gerar-espelho-ponto', summary: 'Gera espelho de ponto (JSON)', auth: 'both', responses: { success: { status: 200, description: 'Espelho de ponto', example: { success: true, data: {} } }, errors: [] } },
      { id: 'gerar-espelho-ponto-pdf', method: 'GET', path: '/api/v1/gerar-espelho-ponto-pdf', summary: 'Gera espelho de ponto (PDF)', auth: 'both', responses: { success: { status: 200, description: 'PDF gerado', example: { success: true, data: {} } }, errors: [] } },
      { id: 'gerar-relatorio-banco-horas', method: 'GET', path: '/api/v1/gerar-relatorio-banco-horas', summary: 'Relatório de banco de horas', auth: 'both', responses: { success: { status: 200, description: 'Relatório', example: { success: true, data: {} } }, errors: [] } },
    ],
  },

  // =============================================
  // CONFIGURAÇÕES
  // =============================================
  {
    id: 'configuracoes',
    name: 'Configurações',
    description: 'Configurações e tolerâncias do sistema',
    icon: 'Settings',
    endpoints: [
      { id: 'obter-configuracoes', method: 'GET', path: '/api/v1/obter-configuracoes', summary: 'Obtém configurações (admin)', auth: 'jwt', responses: { success: { status: 200, description: 'Configurações', example: { success: true, data: {} } }, errors: [] } },
      { id: 'atualizar-configuracoes', method: 'PUT', path: '/api/v1/atualizar-configuracoes', summary: 'Atualiza configurações (admin)', auth: 'jwt', responses: { success: { status: 200, description: 'Atualizado', example: { success: true, data: {} } }, errors: [] } },
      { id: 'obter-tolerancias', method: 'GET', path: '/api/v1/obter-tolerancias', summary: 'Obtém tolerâncias de ponto', auth: 'both', responses: { success: { status: 200, description: 'Tolerâncias', example: { success: true, data: {} } }, errors: [] } },
      { id: 'atualizar-tolerancias', method: 'PUT', path: '/api/v1/atualizar-tolerancias', summary: 'Atualiza tolerâncias (admin)', auth: 'jwt', responses: { success: { status: 200, description: 'Atualizado', example: { success: true, data: {} } }, errors: [] } },
    ],
  },

  // =============================================
  // API KEYS
  // =============================================
  {
    id: 'api-keys',
    name: 'API Keys',
    description: 'Gerenciamento de chaves de API para integrações',
    icon: 'Key',
    endpoints: [
      { id: 'listar-api-keys', method: 'GET', path: '/api/v1/api-keys', summary: 'Lista API keys (admin)', auth: 'jwt', responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
      { id: 'criar-api-key', method: 'POST', path: '/api/v1/api-keys', summary: 'Cria nova API key (admin)', auth: 'jwt', responses: { success: { status: 201, description: 'API key criada', example: { success: true, data: { chave: 'app_nome_hash...' } } }, errors: [] } },
      { id: 'obter-api-key', method: 'GET', path: '/api/v1/api-keys/{id}', summary: 'Obtém API key (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'API key', example: { success: true, data: {} } }, errors: [] } },
      { id: 'atualizar-api-key', method: 'PUT', path: '/api/v1/api-keys/{id}', summary: 'Atualiza API key (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Atualizada', example: { success: true, data: {} } }, errors: [] } },
      { id: 'excluir-api-key', method: 'DELETE', path: '/api/v1/api-keys/{id}', summary: 'Exclui API key (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Removida', example: { success: true, data: {} } }, errors: [] } },
      { id: 'regenerar-api-key', method: 'POST', path: '/api/v1/api-keys/{id}/regenerar', summary: 'Regenera token da API key (admin)', auth: 'jwt', pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Token regenerado', example: { success: true, data: { novaChave: 'app_nome_novohash...' } } }, errors: [] } },
    ],
  },

  // =============================================
  // AUDITORIA
  // =============================================
  {
    id: 'auditoria',
    name: 'Auditoria',
    description: 'Logs de auditoria do sistema',
    icon: 'Activity',
    endpoints: [
      { id: 'listar-logs-auditoria', method: 'GET', path: '/api/v1/listar-logs-auditoria', summary: 'Lista logs de auditoria (admin)', auth: 'jwt', responses: { success: { status: 200, description: 'Logs', example: { success: true, data: [], paginacao: {} } }, errors: [] } },
    ],
  },

  // =============================================
  // APPS
  // =============================================
  {
    id: 'apps',
    name: 'Apps',
    description: 'Gerenciamento de aplicativos (APK/IPA)',
    icon: 'Download',
    endpoints: [
      { id: 'listar-apps', method: 'GET', path: '/api/v1/apps', summary: 'Lista apps disponíveis', auth: 'jwt', responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
      { id: 'obter-app', method: 'GET', path: '/api/v1/apps/{nome}', summary: 'Obtém informações de um app', auth: 'both', pathParams: { nome: { type: 'string', required: true, description: 'Nome do app' } }, responses: { success: { status: 200, description: 'App', example: { success: true, data: {} } }, errors: [] } },
      { id: 'download-app', method: 'GET', path: '/api/v1/apps/{nome}/download', summary: 'Download de app', auth: 'both', pathParams: { nome: { type: 'string', required: true, description: 'Nome do app' } }, responses: { success: { status: 200, description: 'Download iniciado', example: { success: true, data: {} } }, errors: [] } },
      { id: 'excluir-app', method: 'DELETE', path: '/api/v1/apps/{nome}', summary: 'Exclui app (admin)', auth: 'jwt', pathParams: { nome: { type: 'string', required: true, description: 'Nome do app' } }, responses: { success: { status: 200, description: 'Removido', example: { success: true, data: {} } }, errors: [] } },
    ],
  },
];

// =====================================================
// HELPERS
// =====================================================

export function getCategoryById(id: string): ApiCategory | undefined {
  return API_CATEGORIES.find((c) => c.id === id);
}

export function getApiStats() {
  const allEndpoints = API_CATEGORIES.flatMap((c) => c.endpoints);
  return {
    totalEndpoints: allEndpoints.length,
    totalCategories: API_CATEGORIES.length,
    byMethod: {
      GET: allEndpoints.filter((e) => e.method === 'GET').length,
      POST: allEndpoints.filter((e) => e.method === 'POST').length,
      PUT: allEndpoints.filter((e) => e.method === 'PUT').length,
      PATCH: allEndpoints.filter((e) => e.method === 'PATCH').length,
      DELETE: allEndpoints.filter((e) => e.method === 'DELETE').length,
    },
  };
}
