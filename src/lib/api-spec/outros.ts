import { CategorySpec } from './types';

// Jornadas
export const jornadasCategory: CategorySpec = {
  id: 'jornadas',
  name: 'Jornadas',
  description: 'Gerenciamento de jornadas de trabalho',
  icon: 'Calendar',
  endpoints: [
    { id: 'criar-jornada', method: 'POST', path: '/api/v1/criar-jornada', summary: 'Criar jornada', auth: 'both', tags: ['jornadas'], requestBody: { required: true, schema: { nome: { type: 'string', required: true, description: 'Nome' }, horarios: { type: 'array', required: true, description: 'Horários' } }, example: { nome: 'Comercial 8h', horarios: [] } }, responses: { success: { status: 201, description: 'Criada', example: { success: true, data: { id: 1 } } }, errors: [] } },
    { id: 'listar-jornadas', method: 'GET', path: '/api/v1/listar-jornadas', summary: 'Listar jornadas', auth: 'both', tags: ['jornadas'], responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
    { id: 'obter-jornada', method: 'GET', path: '/api/v1/obter-jornada/{id}', summary: 'Obter jornada', auth: 'both', tags: ['jornadas'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Detalhes', example: { success: true, data: {} } }, errors: [{ status: 404, code: 'NOT_FOUND', message: 'Não encontrada' }] } },
    { id: 'atualizar-jornada', method: 'PUT', path: '/api/v1/atualizar-jornada/{id}', summary: 'Atualizar jornada', auth: 'both', tags: ['jornadas'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, requestBody: { required: true, schema: { nome: { type: 'string', description: 'Nome' } }, example: {} }, responses: { success: { status: 200, description: 'Atualizada', example: { success: true } }, errors: [] } },
    { id: 'excluir-jornada', method: 'DELETE', path: '/api/v1/excluir-jornada/{id}', summary: 'Excluir jornada', auth: 'both', tags: ['jornadas'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Excluída', example: { success: true } }, errors: [] } },
    { id: 'atribuir-jornada', method: 'POST', path: '/api/v1/atribuir-jornada', summary: 'Atribuir jornada', auth: 'both', tags: ['jornadas'], requestBody: { required: true, schema: { jornadaId: { type: 'number', required: true, description: 'ID da jornada' }, colaboradorIds: { type: 'array', required: true, description: 'IDs dos colaboradores' } }, example: { jornadaId: 1, colaboradorIds: [1, 2, 3] } }, responses: { success: { status: 200, description: 'Atribuída', example: { success: true } }, errors: [] } },
  ],
};

// Departamentos
export const departamentosCategory: CategorySpec = {
  id: 'departamentos',
  name: 'Departamentos',
  description: 'Estrutura organizacional',
  icon: 'Building2',
  endpoints: [
    { id: 'criar-departamento', method: 'POST', path: '/api/v1/criar-departamento', summary: 'Criar departamento', auth: 'both', tags: ['departamentos'], requestBody: { required: true, schema: { nome: { type: 'string', required: true, description: 'Nome' } }, example: { nome: 'TI' } }, responses: { success: { status: 201, description: 'Criado', example: { success: true, data: { id: 1 } } }, errors: [] } },
    { id: 'listar-departamentos', method: 'GET', path: '/api/v1/listar-departamentos', summary: 'Listar departamentos', auth: 'both', tags: ['departamentos'], responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
    { id: 'obter-departamento', method: 'GET', path: '/api/v1/obter-departamento/{id}', summary: 'Obter departamento', auth: 'both', tags: ['departamentos'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Detalhes', example: { success: true, data: {} } }, errors: [{ status: 404, code: 'NOT_FOUND', message: 'Não encontrado' }] } },
    { id: 'atualizar-departamento', method: 'PUT', path: '/api/v1/atualizar-departamento/{id}', summary: 'Atualizar departamento', auth: 'both', tags: ['departamentos'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, requestBody: { required: true, schema: { nome: { type: 'string', description: 'Nome' } }, example: {} }, responses: { success: { status: 200, description: 'Atualizado', example: { success: true } }, errors: [] } },
    { id: 'excluir-departamento', method: 'DELETE', path: '/api/v1/excluir-departamento/{id}', summary: 'Excluir departamento', auth: 'both', tags: ['departamentos'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Excluído', example: { success: true } }, errors: [] } },
  ],
};

// Cargos
export const cargosCategory: CategorySpec = {
  id: 'cargos',
  name: 'Cargos',
  description: 'Funções e cargos',
  icon: 'Briefcase',
  endpoints: [
    { id: 'criar-cargo', method: 'POST', path: '/api/v1/criar-cargo', summary: 'Criar cargo', auth: 'both', tags: ['cargos'], requestBody: { required: true, schema: { nome: { type: 'string', required: true, description: 'Nome' } }, example: { nome: 'Analista' } }, responses: { success: { status: 201, description: 'Criado', example: { success: true, data: { id: 1 } } }, errors: [] } },
    { id: 'listar-cargos', method: 'GET', path: '/api/v1/listar-cargos', summary: 'Listar cargos', auth: 'both', tags: ['cargos'], responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
    { id: 'obter-cargo', method: 'GET', path: '/api/v1/obter-cargo/{id}', summary: 'Obter cargo', auth: 'both', tags: ['cargos'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Detalhes', example: { success: true, data: {} } }, errors: [{ status: 404, code: 'NOT_FOUND', message: 'Não encontrado' }] } },
    { id: 'excluir-cargo', method: 'DELETE', path: '/api/v1/excluir-cargo/{id}', summary: 'Excluir cargo', auth: 'both', tags: ['cargos'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Excluído', example: { success: true } }, errors: [] } },
  ],
};

// Empresas
export const empresasCategory: CategorySpec = {
  id: 'empresas',
  name: 'Empresas',
  description: 'Multi-tenant',
  icon: 'Building',
  endpoints: [
    { id: 'criar-empresa', method: 'POST', path: '/api/v1/criar-empresa', summary: 'Criar empresa', auth: 'both', tags: ['empresas'], requestBody: { required: true, schema: { razaoSocial: { type: 'string', required: true, description: 'Razão social' }, cnpj: { type: 'string', required: true, description: 'CNPJ' } }, example: { razaoSocial: 'Empresa LTDA', cnpj: '12.345.678/0001-90' } }, responses: { success: { status: 201, description: 'Criada', example: { success: true, data: { id: 1 } } }, errors: [] } },
    { id: 'listar-empresas', method: 'GET', path: '/api/v1/listar-empresas', summary: 'Listar empresas', auth: 'both', tags: ['empresas'], responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
    { id: 'obter-empresa', method: 'GET', path: '/api/v1/obter-empresa/{id}', summary: 'Obter empresa', auth: 'both', tags: ['empresas'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Detalhes', example: { success: true, data: {} } }, errors: [{ status: 404, code: 'NOT_FOUND', message: 'Não encontrada' }] } },
    { id: 'excluir-empresa', method: 'DELETE', path: '/api/v1/excluir-empresa/{id}', summary: 'Excluir empresa', auth: 'both', tags: ['empresas'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Excluída', example: { success: true } }, errors: [] } },
  ],
};

// Feriados
export const feriadosCategory: CategorySpec = {
  id: 'feriados',
  name: 'Feriados',
  description: 'Calendário de feriados',
  icon: 'CalendarDays',
  endpoints: [
    { id: 'criar-feriado', method: 'POST', path: '/api/v1/criar-feriado', summary: 'Criar feriado', auth: 'both', tags: ['feriados'], requestBody: { required: true, schema: { nome: { type: 'string', required: true, description: 'Nome' }, data: { type: 'date', required: true, description: 'Data' }, tipo: { type: 'string', required: true, description: 'Tipo', enum: ['nacional', 'estadual', 'municipal', 'empresa'] } }, example: { nome: 'Natal', data: '2024-12-25', tipo: 'nacional' } }, responses: { success: { status: 201, description: 'Criado', example: { success: true, data: { id: 1 } } }, errors: [] } },
    { id: 'listar-feriados', method: 'GET', path: '/api/v1/listar-feriados', summary: 'Listar feriados', auth: 'both', tags: ['feriados'], responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
    { id: 'listar-feriados-ano', method: 'GET', path: '/api/v1/listar-feriados-ano/{ano}', summary: 'Feriados do ano', auth: 'both', tags: ['feriados'], pathParams: { ano: { type: 'number', required: true, description: 'Ano' } }, responses: { success: { status: 200, description: 'Lista', example: { success: true, data: { ano: 2024, feriados: [] } } }, errors: [] } },
    { id: 'excluir-feriado', method: 'DELETE', path: '/api/v1/excluir-feriado/{id}', summary: 'Excluir feriado', auth: 'both', tags: ['feriados'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Excluído', example: { success: true } }, errors: [] } },
  ],
};

// Localizações
export const localizacoesCategory: CategorySpec = {
  id: 'localizacoes',
  name: 'Localizações',
  description: 'Geofencing e locais',
  icon: 'MapPin',
  endpoints: [
    { id: 'criar-localizacao', method: 'POST', path: '/api/v1/criar-localizacao', summary: 'Criar localização', auth: 'both', tags: ['localizacoes'], requestBody: { required: true, schema: { nome: { type: 'string', required: true, description: 'Nome' }, coordenadas: { type: 'object', required: true, description: 'Lat/Lng' }, raioPermitido: { type: 'number', description: 'Raio em metros' } }, example: { nome: 'Sede', coordenadas: { latitude: -23.55, longitude: -46.63 }, raioPermitido: 100 } }, responses: { success: { status: 201, description: 'Criada', example: { success: true, data: { id: 1 } } }, errors: [] } },
    { id: 'listar-localizacoes', method: 'GET', path: '/api/v1/listar-localizacoes', summary: 'Listar localizações', auth: 'both', tags: ['localizacoes'], responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
    { id: 'validar-geofence', method: 'POST', path: '/api/v1/validar-geofence', summary: 'Validar geofence', auth: 'both', tags: ['localizacoes'], requestBody: { required: true, schema: { latitude: { type: 'number', required: true, description: 'Lat' }, longitude: { type: 'number', required: true, description: 'Lng' } }, example: { latitude: -23.55, longitude: -46.63 } }, responses: { success: { status: 200, description: 'Resultado', example: { success: true, data: { dentroDoRaio: true, distancia: 45 } } }, errors: [] } },
    { id: 'excluir-localizacao', method: 'DELETE', path: '/api/v1/excluir-localizacao/{id}', summary: 'Excluir localização', auth: 'both', tags: ['localizacoes'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Excluída', example: { success: true } }, errors: [] } },
  ],
};

// Solicitações
export const solicitacoesCategory: CategorySpec = {
  id: 'solicitacoes',
  name: 'Solicitações',
  description: 'Férias, ajustes, atestados',
  icon: 'FileText',
  endpoints: [
    { 
      id: 'criar-solicitacao', 
      method: 'POST', 
      path: '/api/v1/criar-solicitacao', 
      summary: 'Criar solicitação', 
      auth: 'both', 
      tags: ['solicitacoes'], 
      requestBody: { 
        required: true, 
        schema: { 
          tipo: { type: 'string', required: true, description: 'Tipo', enum: ['ajuste_ponto', 'ferias', 'atestado', 'ausencia', 'outros'] }, 
          dataEvento: { type: 'date', required: true, description: 'Data do evento' }, 
          descricao: { type: 'string', required: true, description: 'Descrição' },
          justificativa: { type: 'string', description: 'Justificativa' },
          dadosAdicionais: { type: 'object', description: 'Dados extras (JSON)' },
          anexosIds: { type: 'array', description: 'IDs dos anexos (array de números)' }
        }, 
        example: { tipo: 'ajuste_ponto', dataEvento: '2024-01-15', descricao: 'Esqueci de bater ponto', justificativa: 'Reunião externa' } 
      }, 
      responses: { 
        success: { status: 201, description: 'Criada', example: { success: true, data: { id: 1, tipo: 'ajuste_ponto', status: 'pendente', mensagem: 'Solicitação criada com sucesso' } } }, 
        errors: [] 
      } 
    },
    { id: 'listar-solicitacoes', method: 'GET', path: '/api/v1/listar-solicitacoes', summary: 'Listar solicitações', auth: 'both', tags: ['solicitacoes'], queryParams: { status: { type: 'string', description: 'Status', enum: ['pendente', 'aprovada', 'rejeitada'] } }, responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
    { 
      id: 'aprovar-solicitacao', 
      method: 'PATCH', 
      path: '/api/v1/aprovar-solicitacao/{id}', 
      summary: 'Aprovar solicitação', 
      auth: 'both', 
      tags: ['solicitacoes'], 
      pathParams: { id: { type: 'number', required: true, description: 'ID da solicitação' } }, 
      requestBody: { 
        required: false, 
        schema: { observacao: { type: 'string', description: 'Observação do aprovador' } }, 
        example: { observacao: 'Aprovado conforme política' } 
      },
      responses: { 
        success: { status: 200, description: 'Aprovada', example: { success: true, data: { id: 1, status: 'aprovada', mensagem: 'Solicitação aprovada com sucesso', acoes: ['Marcação ajustada', 'Notificação enviada'] } } }, 
        errors: [{ status: 403, code: 'FORBIDDEN', message: 'Sem permissão' }] 
      } 
    },
    { id: 'rejeitar-solicitacao', method: 'PATCH', path: '/api/v1/rejeitar-solicitacao/{id}', summary: 'Rejeitar solicitação', auth: 'both', tags: ['solicitacoes'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, requestBody: { required: true, schema: { motivo: { type: 'string', required: true, description: 'Motivo' } }, example: { motivo: 'Período indisponível' } }, responses: { success: { status: 200, description: 'Rejeitada', example: { success: true } }, errors: [] } },
    { 
      id: 'solicitar-ferias', 
      method: 'POST', 
      path: '/api/v1/solicitar-ferias', 
      summary: 'Solicitar férias', 
      auth: 'both', 
      tags: ['solicitacoes'], 
      requestBody: { 
        required: true, 
        schema: { 
          dataInicio: { type: 'date', required: true, description: 'Data início' }, 
          dataFim: { type: 'date', required: true, description: 'Data fim' }, 
          dias: { type: 'number', required: true, description: 'Quantidade de dias' },
          observacao: { type: 'string', description: 'Observação' }
        }, 
        example: { dataInicio: '2024-07-01', dataFim: '2024-07-15', dias: 15, observacao: 'Viagem planejada' } 
      }, 
      responses: { 
        success: { status: 201, description: 'Criada', example: { success: true, data: { solicitacaoId: 1, status: 'pendente', diasSolicitados: 15, saldoDisponivel: 30, mensagem: 'Solicitação de férias criada com sucesso' } } }, 
        errors: [] 
      } 
    },
    { id: 'enviar-atestado', method: 'POST', path: '/api/v1/enviar-atestado', summary: 'Enviar atestado', auth: 'both', tags: ['solicitacoes'], requestBody: { required: true, schema: { dataInicio: { type: 'date', required: true, description: 'Início' }, dataFim: { type: 'date', required: true, description: 'Fim' }, anexoId: { type: 'number', required: true, description: 'ID do anexo' } }, example: { dataInicio: '2024-01-15', dataFim: '2024-01-17', anexoId: 1 } }, responses: { success: { status: 201, description: 'Enviado', example: { success: true, data: { id: 1 } } }, errors: [] } },
    {
      id: 'justificar-atraso',
      method: 'POST',
      path: '/api/v1/justificar-atraso',
      summary: 'Justificar atraso',
      description: 'Permite ao colaborador justificar um atraso registrado. Ao bater o ponto com atraso, uma notificação é enviada automaticamente com o link para esta ação. A justificativa é registrada como solicitação e também enviada ao Portal do Colaborador.',
      auth: 'jwt',
      tags: ['solicitacoes'],
      requestBody: {
        required: true,
        schema: {
          marcacaoId: { type: 'number', required: true, description: 'ID da marcação de entrada/retorno com atraso' },
          motivo: { type: 'string', required: true, description: 'Motivo do atraso', enum: ['transito', 'transporte_publico', 'problema_saude', 'problema_familiar', 'compromisso_medico', 'outros'] },
          justificativa: { type: 'string', required: true, description: 'Texto livre da justificativa (mín. 3 caracteres)' },
          anexoId: { type: 'number', description: 'ID do anexo comprobatório (opcional)' },
        },
        example: { marcacaoId: 123, motivo: 'transito', justificativa: 'Acidente na BR-101 causou engarrafamento de 2h.' },
      },
      responses: {
        success: {
          status: 201,
          description: 'Justificativa criada',
          example: { success: true, data: { solicitacaoId: 45, marcacaoId: 123, status: 'pendente', mensagem: 'Justificativa de atraso enviada com sucesso' } },
        },
        errors: [
          { status: 404, code: 'NOT_FOUND', message: 'Marcação não encontrada ou não pertence a este colaborador' },
          { status: 400, code: 'INVALID_TYPE', message: 'Apenas marcações de entrada ou retorno podem ser justificadas como atraso' },
          { status: 409, code: 'CONFLICT', message: 'Já existe uma justificativa de atraso para esta marcação' },
        ],
      },
    },
  ],
};

// Notificações
export const notificacoesCategory: CategorySpec = {
  id: 'notificacoes',
  name: 'Notificações',
  description: 'Alertas e avisos',
  icon: 'Bell',
  endpoints: [
    { id: 'listar-notificacoes', method: 'GET', path: '/api/v1/listar-notificacoes', summary: 'Listar notificações', auth: 'both', tags: ['notificacoes'], responses: { success: { status: 200, description: 'Lista', example: { success: true, data: { naoLidas: 5, notificacoes: [] } } }, errors: [] } },
    { id: 'marcar-notificacao-lida', method: 'PATCH', path: '/api/v1/marcar-notificacao-lida/{id}', summary: 'Marcar como lida', auth: 'both', tags: ['notificacoes'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Marcada', example: { success: true } }, errors: [] } },
    { id: 'marcar-todas-lidas', method: 'PATCH', path: '/api/v1/marcar-todas-lidas', summary: 'Marcar todas como lidas', auth: 'both', tags: ['notificacoes'], responses: { success: { status: 200, description: 'Marcadas', example: { success: true, data: { marcadas: 5 } } }, errors: [] } },
  ],
};

// Anexos
export const anexosCategory: CategorySpec = {
  id: 'anexos',
  name: 'Anexos',
  description: 'Upload de arquivos',
  icon: 'Paperclip',
  endpoints: [
    { id: 'enviar-anexo', method: 'POST', path: '/api/v1/enviar-anexo', summary: 'Enviar anexo', auth: 'both', tags: ['anexos'], requestBody: { required: true, contentType: 'multipart/form-data', schema: { arquivo: { type: 'file', required: true, description: 'Arquivo (máx. 10MB)' } }, example: {} }, responses: { success: { status: 201, description: 'Enviado', example: { success: true, data: { id: 1, url: '/storage/anexos/1.pdf' } } }, errors: [{ status: 400, code: 'FILE_TOO_LARGE', message: 'Arquivo muito grande' }] } },
    { id: 'obter-anexo', method: 'GET', path: '/api/v1/obter-anexo/{id}', summary: 'Obter anexo', auth: 'both', tags: ['anexos'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'URL', example: { success: true, data: { url: '/storage/anexos/1.pdf' } } }, errors: [{ status: 404, code: 'NOT_FOUND', message: 'Não encontrado' }] } },
    { id: 'excluir-anexo', method: 'DELETE', path: '/api/v1/excluir-anexo/{id}', summary: 'Excluir anexo', auth: 'both', tags: ['anexos'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Excluído', example: { success: true } }, errors: [] } },
  ],
};

// Dispositivos
export const dispositivosCategory: CategorySpec = {
  id: 'dispositivos',
  name: 'Dispositivos',
  description: 'Tablets e totens de ponto',
  icon: 'Tablet',
  endpoints: [
    { 
      id: 'criar-dispositivo', 
      method: 'POST', 
      path: '/api/v1/dispositivos/criar-dispositivo', 
      summary: 'Criar dispositivo', 
      auth: 'both', 
      tags: ['dispositivos'], 
      requestBody: { 
        required: true, 
        schema: { 
          nome: { type: 'string', required: true, description: 'Nome (3-100 caracteres)' }, 
          descricao: { type: 'string', description: 'Descrição (máx. 500)' },
          empresaId: { type: 'number', description: 'ID da empresa' },
          localizacaoId: { type: 'number', description: 'ID da localização (geofence)' },
          permiteEntrada: { type: 'boolean', description: 'Permite entrada (default: true)' }, 
          permiteSaida: { type: 'boolean', description: 'Permite saída (default: true)' },
          requerFoto: { type: 'boolean', description: 'Requer foto no ponto (default: true)' },
          requerGeolocalizacao: { type: 'boolean', description: 'Requer geolocalização (default: false)' },
          modelo: { type: 'string', description: 'Modelo do dispositivo' },
          sistemaOperacional: { type: 'string', description: 'Sistema operacional' }
        }, 
        example: { nome: 'Totem Recepção', descricao: 'Totem principal da entrada', permiteEntrada: true, permiteSaida: true, requerFoto: true } 
      }, 
      responses: { 
        success: { status: 201, description: 'Criado', example: { success: true, data: { id: 1, codigo: 'ABC123', nome: 'Totem Recepção', mensagem: 'Dispositivo criado com sucesso' } } }, 
        errors: [] 
      }, 
      tutorial: `## Configurando Dispositivo\n\n1. Crie o dispositivo via API\n2. Obtenha o código de 6 caracteres\n3. No app, use o código para ativar\n4. Pronto para registrar ponto via biometria` 
    },
    { 
      id: 'listar-dispositivos', 
      method: 'GET', 
      path: '/api/v1/dispositivos/listar-dispositivos', 
      summary: 'Listar dispositivos', 
      auth: 'both', 
      tags: ['dispositivos'],
      queryParams: {
        pagina: { type: 'number', description: 'Página (default: 1)' },
        limite: { type: 'number', description: 'Itens por página (default: 50)' },
        status: { type: 'string', description: 'Status', enum: ['ativo', 'inativo', 'pendente'] },
        empresaId: { type: 'number', description: 'Filtrar por empresa' },
        busca: { type: 'string', description: 'Busca por nome/código' }
      },
      responses: { 
        success: { 
          status: 200, 
          description: 'Lista paginada', 
          example: { 
            success: true, 
            data: [{ id: 1, codigo: 'ABC123', nome: 'Totem', descricao: 'Recepção', status: 'ativo', permiteEntrada: true, permiteSaida: true, requerFoto: true, requerGeolocalizacao: false, modelo: 'Samsung Tab', sistemaOperacional: 'Android 12', versaoApp: '1.0.0', ultimoAcesso: '2024-01-15T10:00:00Z', totalRegistros: 150, empresa: { id: 1, nome: 'Empresa' }, localizacao: { id: 1, nome: 'Sede' } }], 
            paginacao: { total: 10, pagina: 1, limite: 50, totalPaginas: 1 } 
          } 
        }, 
        errors: [] 
      } 
    },
    { 
      id: 'ativar-dispositivo', 
      method: 'POST', 
      path: '/api/v1/dispositivos/ativar-dispositivo', 
      summary: 'Ativar dispositivo', 
      description: 'Ativa um dispositivo usando o código de 6 caracteres. Endpoint público.',
      auth: 'none', 
      tags: ['dispositivos'], 
      requestBody: { 
        required: true, 
        schema: { 
          codigo: { type: 'string', required: true, description: 'Código de ativação (6 caracteres)' },
          modelo: { type: 'string', description: 'Modelo do dispositivo' },
          sistemaOperacional: { type: 'string', description: 'Sistema operacional' },
          versaoApp: { type: 'string', description: 'Versão do app' }
        }, 
        example: { codigo: 'ABC123', modelo: 'Samsung Tab A', sistemaOperacional: 'Android 12', versaoApp: '1.0.0' } 
      }, 
      responses: { 
        success: { 
          status: 200, 
          description: 'Ativado', 
          example: { 
            success: true, 
            data: { 
              ativado: true,
              dispositivo: { id: 1, nome: 'Totem Recepção', permiteEntrada: true, permiteSaida: true, requerFoto: true, requerGeolocalizacao: false },
              empresa: { id: 1, nome: 'Empresa LTDA' },
              localizacao: { id: 1, nome: 'Sede', latitude: -23.55, longitude: -46.63, raioPermitido: 100 },
              mensagem: 'Dispositivo ativado com sucesso'
            } 
          } 
        }, 
        errors: [{ status: 404, code: 'NOT_FOUND', message: 'Código inválido ou expirado' }] 
      } 
    },
    { id: 'regenerar-codigo-dispositivo', method: 'POST', path: '/api/v1/dispositivos/regenerar-codigo/{id}', summary: 'Regenerar código', auth: 'both', tags: ['dispositivos'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Novo código', example: { success: true, data: { codigo: 'XYZ789' } } }, errors: [] } },
    { id: 'excluir-dispositivo', method: 'DELETE', path: '/api/v1/dispositivos/excluir-dispositivo/{id}', summary: 'Excluir dispositivo', auth: 'both', tags: ['dispositivos'], pathParams: { id: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Excluído', example: { success: true } }, errors: [] } },
  ],
};

// Relatórios
export const relatoriosCategory: CategorySpec = {
  id: 'relatorios',
  name: 'Relatórios',
  description: 'Espelho de ponto, banco de horas e dashboard',
  icon: 'BarChart3',
  endpoints: [
    { 
      id: 'gerar-espelho-ponto', 
      method: 'GET', 
      path: '/api/v1/gerar-espelho-ponto', 
      summary: 'Gerar espelho de ponto', 
      description: 'Gera relatório detalhado de marcações por período. Pode filtrar por colaborador ou departamento.',
      auth: 'both', 
      tags: ['relatorios'], 
      queryParams: { 
        dataInicio: { type: 'date', required: true, description: 'Data inicial (YYYY-MM-DD)' }, 
        dataFim: { type: 'date', required: true, description: 'Data final (YYYY-MM-DD)' },
        colaboradorId: { type: 'number', description: 'Filtrar por colaborador' },
        departamentoId: { type: 'number', description: 'Filtrar por departamento' }
      }, 
      responses: { 
        success: { 
          status: 200, 
          description: 'Espelho de ponto', 
          example: { 
            success: true, 
            data: { 
              periodo: { inicio: '2024-01-01', fim: '2024-01-31' },
              geradoEm: '2024-02-01T10:00:00Z',
              colaboradores: [{
                id: 1,
                nome: 'João Silva',
                departamento: 'TI',
                dias: [{ data: '2024-01-15', diaSemana: 'segunda', marcacoes: ['08:00', '12:00', '13:00', '17:00'], horasTrabalhadas: '08:00', horasExtras: '00:00', observacoes: null }],
                totalizadores: { diasTrabalhados: 22, horasTotais: '176:00', horasExtras: '12:30', faltas: 0, atrasos: 2 }
              }]
            } 
          } 
        }, 
        errors: [] 
      } 
    },
    { 
      id: 'obter-banco-horas', 
      method: 'GET', 
      path: '/api/v1/obter-banco-horas/{colaboradorId}', 
      summary: 'Banco de horas', 
      description: 'Retorna saldo detalhado do banco de horas do colaborador.',
      auth: 'both', 
      tags: ['relatorios'], 
      pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID do colaborador' } },
      queryParams: { 
        dataInicio: { type: 'date', description: 'Data inicial' }, 
        dataFim: { type: 'date', description: 'Data final' }
      }, 
      responses: { 
        success: { 
          status: 200, 
          description: 'Banco de horas', 
          example: { 
            success: true, 
            data: { 
              colaborador: { id: 1, nome: 'João Silva' },
              periodo: { inicio: '2024-01-01', fim: '2024-01-31' },
              saldoAtual: { horas: '12:30', tipo: 'credito' },
              horasExtras: 15.5,
              horasDevidas: 3.0,
              horasCompensadas: 0
            } 
          } 
        }, 
        errors: [] 
      } 
    },
    { id: 'obter-saldo-horas', method: 'GET', path: '/api/v1/obter-saldo-horas/{colaboradorId}', summary: 'Saldo de horas', auth: 'both', tags: ['relatorios'], pathParams: { colaboradorId: { type: 'number', required: true, description: 'ID' } }, responses: { success: { status: 200, description: 'Saldo', example: { success: true, data: { saldo: '+12:30' } } }, errors: [] } },
    { 
      id: 'obter-visao-geral', 
      method: 'GET', 
      path: '/api/v1/obter-visao-geral', 
      summary: 'Visão geral (dashboard)', 
      description: 'Retorna dados consolidados para o dashboard administrativo.',
      auth: 'both', 
      tags: ['relatorios'], 
      responses: { 
        success: { 
          status: 200, 
          description: 'Dashboard', 
          example: { 
            success: true, 
            data: { 
              periodo: { inicio: '2024-01-01', fim: '2024-01-31' },
              totalizadores: {
                totalColaboradores: 50,
                colaboradoresAtivos: 48,
                presencaHoje: 45,
                ausenciasHoje: 3,
                atrasosHoje: 2,
                horasExtrasMes: 125.5
              },
              graficos: {
                presencaSemanal: [{ data: '2024-01-15', presentes: 45 }],
                departamentos: [{ nome: 'TI', total: 15 }],
                tendencias: []
              }
            } 
          } 
        }, 
        errors: [] 
      } 
    },
    { id: 'listar-logs-auditoria', method: 'GET', path: '/api/v1/listar-logs-auditoria', summary: 'Logs de auditoria', auth: 'both', tags: ['relatorios'], queryParams: { dataInicio: { type: 'date', description: 'Início' }, dataFim: { type: 'date', description: 'Fim' } }, responses: { success: { status: 200, description: 'Logs', example: { success: true, data: [] } }, errors: [{ status: 403, code: 'FORBIDDEN', message: 'Apenas admin' }] } },
  ],
};

// Configurações
export const configuracoesCategory: CategorySpec = {
  id: 'configuracoes',
  name: 'Configurações',
  description: 'Parâmetros do sistema',
  icon: 'Settings',
  endpoints: [
    { id: 'obter-configuracoes', method: 'GET', path: '/api/v1/obter-configuracoes', summary: 'Obter configurações', auth: 'both', tags: ['configuracoes'], responses: { success: { status: 200, description: 'Configurações', example: { success: true, data: {} } }, errors: [] } },
    { id: 'atualizar-configuracoes', method: 'PUT', path: '/api/v1/atualizar-configuracoes', summary: 'Atualizar configurações', auth: 'both', tags: ['configuracoes'], requestBody: { required: true, schema: { categoria: { type: 'string', required: true, description: 'Categoria' }, configuracoes: { type: 'object', required: true, description: 'Configs' } }, example: { categoria: 'ponto', configuracoes: { toleranciaEntrada: 15 } } }, responses: { success: { status: 200, description: 'Atualizadas', example: { success: true } }, errors: [{ status: 403, code: 'FORBIDDEN', message: 'Apenas admin' }] } },
    { id: 'obter-tolerancias', method: 'GET', path: '/api/v1/obter-tolerancias', summary: 'Obter tolerâncias', auth: 'both', tags: ['configuracoes'], responses: { success: { status: 200, description: 'Tolerâncias', example: { success: true, data: { toleranciaEntrada: 10, toleranciaSaida: 10 } } }, errors: [] } },
  ],
};

// Apps
export const appsCategory: CategorySpec = {
  id: 'apps',
  name: 'Apps',
  description: 'APKs e storage',
  icon: 'Download',
  endpoints: [
    { id: 'listar-apps', method: 'GET', path: '/api/v1/apps', summary: 'Listar apps', auth: 'both', tags: ['apps'], responses: { success: { status: 200, description: 'Lista', example: { success: true, data: [] } }, errors: [] } },
    { id: 'download-app', method: 'GET', path: '/api/v1/apps/{nome}/download', summary: 'Download do app', auth: 'none', tags: ['apps'], pathParams: { nome: { type: 'string', required: true, description: 'Nome do app' } }, responses: { success: { status: 200, description: 'Arquivo APK', example: {} }, errors: [{ status: 404, code: 'NOT_FOUND', message: 'App não encontrado' }] } },
    { id: 'acessar-storage', method: 'GET', path: '/api/v1/storage/{path}', summary: 'Acessar storage', auth: 'none', tags: ['apps'], pathParams: { path: { type: 'string', required: true, description: 'Caminho do arquivo' } }, responses: { success: { status: 200, description: 'Arquivo', example: {} }, errors: [{ status: 404, code: 'NOT_FOUND', message: 'Arquivo não encontrado' }] } },
  ],
};

// Health
export const healthCategory: CategorySpec = {
  id: 'health',
  name: 'Health',
  description: 'Status da API',
  icon: 'Activity',
  endpoints: [
    { id: 'health-check', method: 'GET', path: '/api/v1/health', summary: 'Health check', auth: 'none', tags: ['health'], responses: { success: { status: 200, description: 'API saudável', example: { success: true, data: { status: 'healthy', version: '1.0.0', services: { database: 'ok', redis: 'ok', minio: 'ok' } } } }, errors: [{ status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Serviço indisponível' }] } },
  ],
};
