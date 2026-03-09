import { CategorySpec } from './types';

export const gestaoPessoasCategory: CategorySpec = {
  id: 'gestao-pessoas',
  name: 'Gestão de Pessoas',
  description: 'Advertências, feedbacks, demissões, reuniões e dossiê do colaborador',
  icon: 'Users',
  endpoints: [
    {
      id: 'listar-gestao-pessoas',
      method: 'GET',
      path: '/api/v1/gestao-pessoas',
      summary: 'Lista registros de gestão de pessoas (paginado)',
      auth: 'both',
      tags: ['gestao-pessoas'],
      queryParams: {
        busca: { type: 'string', description: 'Busca por nome do colaborador, título ou descrição' },
        tipo: { type: 'string', description: 'Tipo do registro', enum: ['advertencia', 'demissao', 'feedback_positivo', 'feedback_negativo'] },
        status: { type: 'string', description: 'Status do registro', enum: ['pendente', 'em_andamento', 'concluido', 'cancelado'] },
        departamento: { type: 'string', description: 'Nome do departamento' },
        pagina: { type: 'number', description: 'Página (default 1)' },
        limite: { type: 'number', description: 'Itens por página (default 20)' },
      },
      responses: {
        success: {
          status: 200,
          description: 'Lista de registros com resumo',
          example: {
            success: true,
            data: [{
              id: 1,
              colaboradorId: 3,
              colaboradorNome: 'João Pedro Santos',
              colaboradorCargo: 'Operador de Máquinas',
              colaboradorDepartamento: 'Produção',
              tipo: 'advertencia',
              status: 'concluido',
              titulo: 'Atraso reincidente sem justificativa',
              descricao: 'O colaborador acumulou 5 atrasos...',
              dataRegistro: '2026-02-15',
              dataConclusao: '2026-02-18',
              responsavel: 'Maria Fernanda Oliveira',
              anexos: [{ id: 1, nome: 'relatorio-atrasos.pdf', tipo: 'documento', tamanho: '245 KB', dataUpload: '2026-02-15', url: 'https://...' }],
              reuniao: {
                data: '2026-02-17',
                hora: '14:00',
                participantes: [{ id: 2, nome: 'Maria Fernanda Oliveira', cargo: 'Coordenadora de RH', departamento: 'RH' }],
                status: 'realizada',
                observacoes: 'Colaborador reconheceu os atrasos.',
              },
            }],
            paginacao: { total: 42, pagina: 1, limite: 20, totalPaginas: 3 },
            resumo: { total: 42, pendentes: 8, advertencias: 12, feedbacks: 22, reunioesAgendadas: 5 },
          },
        },
        errors: [
          { status: 401, code: 'UNAUTHORIZED', message: 'Não autenticado' },
          { status: 403, code: 'FORBIDDEN', message: 'Acesso negado' },
        ],
      },
    },
    {
      id: 'obter-gestao-pessoas',
      method: 'GET',
      path: '/api/v1/gestao-pessoas/{id}',
      summary: 'Obtém registro por ID',
      auth: 'both',
      tags: ['gestao-pessoas'],
      pathParams: { id: { type: 'number', required: true, description: 'ID do registro' } },
      responses: {
        success: {
          status: 200,
          description: 'Dados completos do registro',
          example: {
            success: true,
            data: {
              id: 1,
              colaboradorId: 3,
              colaboradorNome: 'João Pedro Santos',
              tipo: 'advertencia',
              status: 'concluido',
              titulo: 'Atraso reincidente',
              descricao: '...',
              dataRegistro: '2026-02-15',
              dataConclusao: '2026-02-18',
              responsavel: 'Maria Fernanda Oliveira',
              anexos: [],
              reuniao: { data: '2026-02-17', hora: '14:00', participantes: [], status: 'realizada', observacoes: null },
            },
          },
        },
        errors: [
          { status: 404, code: 'NOT_FOUND', message: 'Registro não encontrado' },
        ],
      },
    },
    {
      id: 'criar-gestao-pessoas',
      method: 'POST',
      path: '/api/v1/gestao-pessoas',
      summary: 'Cria registro de gestão de pessoas',
      auth: 'both',
      tags: ['gestao-pessoas'],
      requestBody: {
        required: true,
        contentType: 'multipart/form-data',
        schema: {
          colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' },
          tipo: { type: 'string', required: true, description: 'Tipo do registro', enum: ['advertencia', 'demissao', 'feedback_positivo', 'feedback_negativo'] },
          titulo: { type: 'string', required: true, description: 'Título do registro' },
          descricao: { type: 'string', required: true, description: 'Descrição detalhada' },
          reuniaoData: { type: 'string', required: true, description: 'Data da reunião (YYYY-MM-DD)' },
          reuniaoHora: { type: 'string', required: true, description: 'Hora da reunião (HH:mm)' },
          participantesIds: { type: 'string', required: true, description: 'JSON array de IDs: "[2, 3, 5]"' },
          anexos: { type: 'file', description: 'Arquivos binários (campo repetido, 0 ou mais)' },
        },
        example: {
          colaboradorId: 3,
          tipo: 'advertencia',
          titulo: 'Novo registro',
          descricao: 'Descrição do registro...',
          reuniaoData: '2026-03-10',
          reuniaoHora: '14:00',
          participantesIds: '[2, 3]',
        },
      },
      responses: {
        success: {
          status: 201,
          description: 'Registro criado',
          example: { success: true, data: { id: 9, tipo: 'advertencia', status: 'pendente', titulo: 'Novo registro' } },
        },
        errors: [
          { status: 400, code: 'BAD_REQUEST', message: 'Dados inválidos' },
          { status: 404, code: 'NOT_FOUND', message: 'Colaborador não encontrado' },
        ],
      },
    },
    {
      id: 'atualizar-gestao-pessoas',
      method: 'PUT',
      path: '/api/v1/gestao-pessoas/{id}',
      summary: 'Atualiza registro de gestão de pessoas',
      auth: 'both',
      tags: ['gestao-pessoas'],
      pathParams: { id: { type: 'number', required: true, description: 'ID do registro' } },
      requestBody: {
        required: true,
        schema: {
          status: { type: 'string', description: 'Status do registro', enum: ['pendente', 'em_andamento', 'concluido', 'cancelado'] },
          titulo: { type: 'string', description: 'Título atualizado' },
          descricao: { type: 'string', description: 'Descrição atualizada' },
          reuniaoData: { type: 'string', description: 'Nova data da reunião (YYYY-MM-DD)' },
          reuniaoHora: { type: 'string', description: 'Nova hora da reunião (HH:mm)' },
          reuniaoStatus: { type: 'string', description: 'Status da reunião', enum: ['agendada', 'realizada', 'cancelada'] },
          reuniaoObservacoes: { type: 'string', description: 'Observações / ata da reunião' },
          participantesIds: { type: 'array', description: 'IDs de participantes (substitui a lista)', items: { type: 'number', description: 'ID do colaborador' } },
        },
        example: {
          status: 'em_andamento',
          reuniaoStatus: 'realizada',
          reuniaoObservacoes: 'Colaborador reconheceu os atrasos.',
        },
      },
      responses: {
        success: {
          status: 200,
          description: 'Registro atualizado',
          example: { success: true, data: { id: 1, status: 'em_andamento' } },
        },
        errors: [
          { status: 404, code: 'NOT_FOUND', message: 'Registro não encontrado' },
          { status: 422, code: 'VALIDATION_ERROR', message: 'Erro de validação' },
        ],
      },
    },
    {
      id: 'excluir-gestao-pessoas',
      method: 'DELETE',
      path: '/api/v1/gestao-pessoas/{id}',
      summary: 'Exclui registro de gestão de pessoas',
      auth: 'both',
      tags: ['gestao-pessoas'],
      pathParams: { id: { type: 'number', required: true, description: 'ID do registro' } },
      responses: {
        success: {
          status: 200,
          description: 'Registro excluído',
          example: { success: true, message: 'Registro excluído com sucesso' },
        },
        errors: [
          { status: 404, code: 'NOT_FOUND', message: 'Registro não encontrado' },
        ],
      },
    },
    {
      id: 'dossie-gestao-pessoas',
      method: 'GET',
      path: '/api/v1/gestao-pessoas/dossie/{colaboradorId}',
      summary: 'Dossiê do colaborador (todos os registros)',
      auth: 'both',
      tags: ['gestao-pessoas'],
      pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' } },
      responses: {
        success: {
          status: 200,
          description: 'Dossiê completo',
          example: {
            success: true,
            data: {
              colaborador: { id: 3, nome: 'João Pedro Santos', cargo: 'Operador de Máquinas', departamento: 'Produção' },
              resumo: { total: 4, advertencias: 2, feedbacksPositivos: 1, feedbacksNegativos: 1, demissoes: 0 },
              registros: [],
            },
          },
        },
        errors: [
          { status: 404, code: 'NOT_FOUND', message: 'Colaborador não encontrado' },
        ],
      },
    },
    {
      id: 'adicionar-anexos-gestao-pessoas',
      method: 'POST',
      path: '/api/v1/gestao-pessoas/{id}/anexos',
      summary: 'Adiciona anexos a um registro existente',
      auth: 'both',
      tags: ['gestao-pessoas'],
      pathParams: { id: { type: 'number', required: true, description: 'ID do registro' } },
      requestBody: {
        required: true,
        contentType: 'multipart/form-data',
        schema: {
          anexos: { type: 'file', required: true, description: 'Arquivos (1 ou mais, campo repetido). Máx 50 MB cada.' },
        },
        example: {},
      },
      responses: {
        success: {
          status: 201,
          description: 'Anexos adicionados',
          example: {
            success: true,
            data: [{ id: 16, nome: 'novo-documento.pdf', tipo: 'documento', tamanho: '540 KB', dataUpload: '2026-03-05', url: 'https://...' }],
          },
        },
        errors: [
          { status: 400, code: 'BAD_REQUEST', message: 'Nenhum arquivo enviado ou extensão inválida' },
          { status: 404, code: 'NOT_FOUND', message: 'Registro não encontrado' },
        ],
      },
    },
    {
      id: 'excluir-anexo-gestao-pessoas',
      method: 'DELETE',
      path: '/api/v1/gestao-pessoas/{id}/anexos/{anexoId}',
      summary: 'Exclui um anexo de um registro',
      auth: 'both',
      tags: ['gestao-pessoas'],
      pathParams: {
        id: { type: 'number', required: true, description: 'ID do registro' },
        anexoId: { type: 'number', required: true, description: 'ID do anexo' },
      },
      responses: {
        success: {
          status: 200,
          description: 'Anexo excluído',
          example: { success: true, message: 'Anexo excluído com sucesso' },
        },
        errors: [
          { status: 404, code: 'NOT_FOUND', message: 'Anexo não encontrado' },
        ],
      },
    },
  ],
};
