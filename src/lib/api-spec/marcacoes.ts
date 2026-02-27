import { CategorySpec } from './types';

export const marcacoesCategory: CategorySpec = {
  id: 'marcacoes',
  name: 'Marcações',
  description: 'Registro e gerenciamento de marcações de ponto',
  icon: 'Clock',
  endpoints: [
    {
      id: 'criar-marcacao',
      method: 'POST',
      path: '/api/v1/criar-marcacao',
      summary: 'Criar marcação manual',
      description: 'Cria uma marcação manual (requer justificativa). Usado para correções.',
      auth: 'both',
      tags: ['marcacoes'],
      requestBody: {
        required: true,
        schema: {
          colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' },
          empresaId: { type: 'number', description: 'ID da empresa' },
          dataHora: { type: 'string', required: true, description: 'Data/hora (ISO 8601)' },
          tipo: { type: 'string', required: true, description: 'Tipo', enum: ['entrada', 'saida', 'almoco', 'retorno'] },
          justificativa: { type: 'string', required: true, description: 'Justificativa obrigatória' },
          observacao: { type: 'string', description: 'Observação adicional' },
        },
        example: { colaboradorId: 1, dataHora: '2024-01-15T08:00:00', tipo: 'entrada', justificativa: 'Esqueceu de bater ponto' },
      },
      responses: {
        success: { status: 201, description: 'Criada', example: { success: true, data: { id: 123, mensagem: 'Marcação criada com sucesso', marcacao: { id: 123, dataHora: '2024-01-15T08:00:00Z', tipo: 'entrada' } } } },
        errors: [{ status: 400, code: 'VALIDATION_ERROR', message: 'Justificativa obrigatória' }],
      },
    },
    {
      id: 'listar-marcacoes',
      method: 'GET',
      path: '/api/v1/listar-marcacoes',
      summary: 'Listar marcações',
      auth: 'both',
      tags: ['marcacoes'],
      queryParams: {
        dataInicio: { type: 'date', description: 'Data inicial' },
        dataFim: { type: 'date', description: 'Data final' },
        colaboradorId: { type: 'number', description: 'Filtrar por colaborador' },
        tipo: { type: 'string', description: 'Tipo', enum: ['entrada', 'saida', 'almoco', 'retorno'] },
      },
      responses: {
        success: { status: 200, description: 'Lista', example: { success: true, data: { marcacoes: [], total: 100 } } },
        errors: [],
      },
    },
    {
      id: 'obter-marcacao',
      method: 'GET',
      path: '/api/v1/obter-marcacao/{id}',
      summary: 'Obter marcação',
      auth: 'both',
      tags: ['marcacoes'],
      pathParams: { id: { type: 'number', required: true, description: 'ID da marcação' } },
      responses: {
        success: { status: 200, description: 'Detalhes', example: { success: true, data: { id: 1, dataHora: '2024-01-15T08:00:00Z', tipo: 'entrada' } } },
        errors: [{ status: 404, code: 'NOT_FOUND', message: 'Marcação não encontrada' }],
      },
    },
    {
      id: 'atualizar-marcacao',
      method: 'PUT',
      path: '/api/v1/atualizar-marcacao/{id}',
      summary: 'Atualizar marcação',
      auth: 'both',
      tags: ['marcacoes'],
      pathParams: { id: { type: 'number', required: true, description: 'ID da marcação' } },
      requestBody: {
        required: true,
        schema: {
          dataHora: { type: 'string', required: true, description: 'Nova data/hora' },
          justificativa: { type: 'string', required: true, description: 'Justificativa' },
        },
        example: { dataHora: '2024-01-15T08:05:00', justificativa: 'Correção' },
      },
      responses: {
        success: { status: 200, description: 'Atualizada', example: { success: true } },
        errors: [{ status: 404, code: 'NOT_FOUND', message: 'Marcação não encontrada' }],
      },
    },
    {
      id: 'excluir-marcacao',
      method: 'DELETE',
      path: '/api/v1/excluir-marcacao/{id}',
      summary: 'Excluir marcação',
      auth: 'both',
      tags: ['marcacoes'],
      pathParams: { id: { type: 'number', required: true, description: 'ID da marcação' } },
      responses: {
        success: { status: 200, description: 'Excluída', example: { success: true } },
        errors: [{ status: 404, code: 'NOT_FOUND', message: 'Marcação não encontrada' }],
      },
    },
    {
      id: 'registrar-entrada',
      method: 'POST',
      path: '/api/v1/registrar-entrada',
      summary: 'Registrar entrada',
      description: 'Registra entrada do colaborador. Detecta automaticamente se é "entrada" (início do dia) ou "retorno" (volta do almoço). Retorna status e próxima marcação esperada.',
      auth: 'both',
      tags: ['marcacoes'],
      requestBody: {
        required: true,
        schema: {
          colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' },
          empresaId: { type: 'number', description: 'ID da empresa' },
          metodo: { type: 'string', required: true, description: 'Método', enum: ['app', 'web', 'biometria'] },
          localizacao: { type: 'object', description: 'Geolocalização (objeto com latitude e longitude)' },
          foto: { type: 'string', description: 'Foto em base64 (se requerido)' },
        },
        example: { colaboradorId: 1, metodo: 'app', localizacao: { latitude: -23.55, longitude: -46.63 } },
      },
      responses: {
        success: { 
          status: 201, 
          description: 'Entrada registrada', 
          example: { 
            success: true, 
            data: { 
              id: 123, 
              dataHora: '2024-01-15T08:05:00Z',
              tipo: 'entrada',
              status: 'atrasado',
              divergencia: { minutos: 5, mensagem: 'Entrada 5 minutos após o horário' },
              proximaMarcacao: 'saida'
            } 
          } 
        },
        errors: [{ status: 400, code: 'ALREADY_CLOCKED_IN', message: 'Já existe entrada sem saída' }],
      },
    },
    {
      id: 'registrar-saida',
      method: 'POST',
      path: '/api/v1/registrar-saida',
      summary: 'Registrar saída',
      description: 'Registra saída do colaborador. Detecta automaticamente se é "almoco" (primeira saída do dia) ou "saida" (saída final). Retorna resumo do dia.',
      auth: 'both',
      tags: ['marcacoes'],
      requestBody: {
        required: true,
        schema: {
          colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' },
          empresaId: { type: 'number', description: 'ID da empresa' },
          metodo: { type: 'string', required: true, description: 'Método', enum: ['app', 'web', 'biometria'] },
          localizacao: { type: 'object', description: 'Geolocalização (objeto com latitude e longitude)' },
          foto: { type: 'string', description: 'Foto em base64 (se requerido)' },
        },
        example: { colaboradorId: 1, metodo: 'app' },
      },
      responses: {
        success: { 
          status: 201, 
          description: 'Saída registrada', 
          example: { 
            success: true, 
            data: { 
              id: 124, 
              dataHora: '2024-01-15T17:00:00Z',
              tipo: 'saida',
              status: 'no_horario',
              resumoDia: { horasTrabalhadas: '08:00', horasExtras: '00:00', saldo: '+00:00' }
            } 
          } 
        },
        errors: [{ status: 400, code: 'NO_ENTRY', message: 'Não há entrada registrada' }],
      },
    },
    {
      id: 'listar-marcacoes-colaborador',
      method: 'GET',
      path: '/api/v1/listar-marcacoes-colaborador/{colaboradorId}',
      summary: 'Marcações do colaborador',
      auth: 'both',
      tags: ['marcacoes'],
      pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' } },
      queryParams: { dataInicio: { type: 'date', description: 'Data inicial' }, dataFim: { type: 'date', description: 'Data final' } },
      responses: {
        success: { status: 200, description: 'Marcações', example: { success: true, data: [] } },
        errors: [{ status: 404, code: 'NOT_FOUND', message: 'Colaborador não encontrado' }],
      },
    },
    {
      id: 'listar-marcacoes-hoje',
      method: 'GET',
      path: '/api/v1/listar-marcacoes-hoje',
      summary: 'Marcações de hoje',
      auth: 'both',
      tags: ['marcacoes'],
      responses: {
        success: { status: 200, description: 'Marcações', example: { success: true, data: { data: '2024-01-15', marcacoes: [], totalPresentes: 25 } } },
        errors: [],
      },
    },
    {
      id: 'sincronizar-marcacoes-offline',
      method: 'POST',
      path: '/api/v1/sincronizar-marcacoes-offline',
      summary: 'Sincronizar offline',
      auth: 'both',
      tags: ['marcacoes'],
      requestBody: {
        required: true,
        schema: { marcacoes: { type: 'array', required: true, description: 'Lista de marcações (array de objetos com colaboradorId, dataHora, tipo, metodo)' } },
        example: { marcacoes: [{ colaboradorId: 1, dataHora: '2024-01-15T08:00:00', tipo: 'entrada', metodo: 'app' }] },
      },
      responses: {
        success: { status: 200, description: 'Sincronizadas', example: { success: true, data: { sincronizadas: 2, erros: 0 } } },
        errors: [],
      },
    },
  ],
};
