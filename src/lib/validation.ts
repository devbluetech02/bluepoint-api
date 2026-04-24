import { z } from 'zod';

// Helper: converte DD/MM/YYYY para YYYY-MM-DD (aceita ambos os formatos)
const toISODate = (val: string): string => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(val);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : val;
};

// =====================================================
// SCHEMAS DE AUTENTICAÇÃO
// =====================================================

export const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  senha: z.string().min(1, 'Senha é obrigatória'),
});

export const loginCpfSchema = z.object({
  cpf: z.string().min(11, 'CPF inválido').max(14),
});

export const criarUsuarioProvisorioSchema = z.object({
  nome:           z.string().min(3, 'Nome deve ter no mínimo 3 caracteres').max(255),
  cpf:            z.string().min(11, 'CPF inválido').max(14),
  empresaId:      z.number().int().positive('empresaId deve ser um inteiro positivo'),
  cargoId:        z.number().int().positive('cargoId deve ser um inteiro positivo'),
  departamentoId: z.number().int().positive('departamentoId deve ser um inteiro positivo'),
  jornadaId:      z.number().int().positive('jornadaId deve ser um inteiro positivo'),
  diasTeste:      z
    .number()
    .int('diasTeste deve ser inteiro')
    .min(0, 'diasTeste não pode ser negativo')
    .max(365, 'diasTeste não pode exceder 365')
    .optional()
    .nullable(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token é obrigatório'),
});

export const solicitarRecuperacaoSenhaSchema = z.object({
  email: z.string().email('Email inválido'),
});

export const redefinirSenhaSchema = z.object({
  token: z.string().min(1, 'Token é obrigatório'),
  novaSenha: z.string().min(6, 'Senha deve ter no mínimo 6 caracteres'),
  confirmarSenha: z.string().min(1, 'Confirmação de senha é obrigatória'),
}).refine((data) => data.novaSenha === data.confirmarSenha, {
  message: 'As senhas não conferem',
  path: ['confirmarSenha'],
});

// =====================================================
// SCHEMAS DE COLABORADOR
// =====================================================

export const enderecoSchema = z.object({
  cep: z.string().max(10).optional().nullable(),
  logradouro: z.string().max(255).optional().nullable(),
  numero: z.string().max(20).optional().nullable(),
  complemento: z.string().max(100).optional().nullable(),
  bairro: z.string().max(100).optional().nullable(),
  cidade: z.string().max(100).optional().nullable(),
  estado: z.string().max(2).optional().nullable(),
});

export const criarColaboradorSchema = z.object({
  nome: z.string().min(3, 'Nome deve ter no mínimo 3 caracteres').max(255),
  email: z.string().email('Email inválido'),
  cpf: z.string().min(11, 'CPF inválido').max(14),
  rg: z.string().max(20).optional().nullable(),
  telefone: z.string().max(20).optional().nullable(),
  pis: z.string().max(20).optional().nullable(),
  externalId: z.string().max(100).optional().nullable(),
  categoria: z.enum(['empregado', 'empregado_clt', 'usuario_interno']).optional().nullable(),
  observacao: z.string().optional().nullable(),
  empresaId: z.number().int().positive().optional().nullable(),
  endereco: enderecoSchema.optional().nullable(),
  departamentoId: z.number().int().positive().optional().nullable(),
  jornadaId: z.number().int().positive().optional().nullable(),
  cargoId: z.number().int().positive().optional().nullable(),
  dataAdmissao: z.string().transform(toISODate).refine((val) => !isNaN(Date.parse(val)), 'Data de admissão inválida'),
  dataNascimento: z.string().transform(toISODate).refine((val) => !val || !isNaN(Date.parse(val)), 'Data de nascimento inválida').optional().nullable(),
  dataDesligamento: z.string().transform(toISODate).refine((val) => !val || !isNaN(Date.parse(val)), 'Data de desligamento inválida').optional().nullable(),
  permitePontoMobile: z.boolean().optional().default(false),
  permitePontoQualquerEmpresa: z.boolean().optional().default(false),
  valeAlimentacao: z.boolean().optional().default(false),
  valeTransporte: z.boolean().optional().default(false),
  senha: z.string().min(6, 'Senha deve ter no mínimo 6 caracteres'),
});

export const atualizarColaboradorSchema = criarColaboradorSchema
  .partial()
  .omit({ senha: true })
  .extend({
    status: z
      .enum(['ativo', 'inativo'], { message: 'Status deve ser "ativo" ou "inativo"' })
      .optional(),
    novaSenha: z
      .string()
      .min(6, 'Nova senha deve ter no mínimo 6 caracteres')
      .optional(),
  });

// =====================================================
// SCHEMAS DE MARCAÇÃO
// =====================================================

export const criarMarcacaoSchema = z.object({
  colaboradorId: z.number().int().positive(),
  empresaId: z.number().int().positive().optional().nullable(),
  dataHora: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data/hora inválida'),
  tipo: z.enum(['entrada', 'saida', 'almoco', 'retorno']),
  observacao: z.string().optional(),
  justificativa: z.string().min(1, 'Justificativa é obrigatória para marcação manual'),
});

export const atualizarMarcacaoSchema = z.object({
  dataHora: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data/hora inválida'),
  tipo: z.enum(['entrada', 'saida', 'almoco', 'retorno']).optional(),
  observacao: z.string().optional(),
  justificativa: z.string().min(1, 'Justificativa é obrigatória'),
});

export const registrarPontoSchema = z.object({
  colaboradorId: z.number().int().positive(),
  empresaId: z.number().int().positive().optional().nullable(),
  localizacao: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }).optional(),
  foto: z.string().optional(),
  metodo: z.enum(['app', 'web', 'biometria']),
});

export const registrarPontoComToleranciaSchema = z.object({
  colaboradorId: z.number().int().positive(),
  empresaId: z.number().int().positive().optional().nullable(),
  localizacao: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }).optional(),
  foto: z.string().optional(),
  metodo: z.enum(['app', 'web', 'biometria']),
});

export const solicitarAtrasoSchema = z.object({
  colaboradorId: z.number().int().positive(),
  empresaId: z.number().int().positive().optional().nullable(),
  justificativa: z.string().min(3, 'Justificativa deve ter no mínimo 3 caracteres'),
  localizacao: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }).optional(),
  foto: z.string().optional(),
  metodo: z.enum(['app', 'web', 'biometria']),
});

export const sincronizarMarcacoesSchema = z.object({
  marcacoes: z.array(z.object({
    colaboradorId: z.number().int().positive(),
    dataHora: z.string(),
    tipo: z.enum(['entrada', 'saida', 'almoco', 'retorno']),
    localizacao: z.object({
      latitude: z.number(),
      longitude: z.number(),
    }).optional(),
    metodo: z.enum(['app', 'web', 'biometria']),
  })),
});

// =====================================================
// SCHEMAS DE JORNADA
// =====================================================

const horaRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;

export const periodoSchema = z.object({
  entrada: z.string().regex(horaRegex, 'Formato de hora inválido'),
  saida: z.string().regex(horaRegex, 'Formato de hora inválido'),
});

export const horarioJornadaSchema = z.object({
  diaSemana: z.number().int().min(0).max(6).optional().nullable(), // 0-6 para simples, null para circular
  sequencia: z.number().int().min(1).optional().nullable(), // ordem no ciclo (para circular): 1, 2, 3...
  quantidadeDias: z.number().int().min(1).default(1), // quantos dias esse bloco dura (para circular)
  diasSemana: z.array(z.number().int().min(0).max(6)).optional().default([]), // [1,2,3,4,5] = seg a sex (para circular)
  periodos: z.array(periodoSchema).default([]),
  folga: z.boolean().default(false),
});

export const criarJornadaSchema = z.object({
  nome: z.string().min(3).max(100),
  descricao: z.string().optional(),
  tipo: z.enum(['simples', 'circular']).default('simples'),
  diasRepeticao: z.number().int().min(1).optional().nullable(),
  horarios: z.array(horarioJornadaSchema).min(1, 'Pelo menos um horário é obrigatório'),
  toleranciaEntrada: z.number().int().min(0).default(10),
  toleranciaSaida: z.number().int().min(0).default(10),
});

export const atualizarJornadaSchema = criarJornadaSchema.partial();

export const atribuirJornadaSchema = z.object({
  jornadaId: z.number().int().positive(),
  colaboradorIds: z.array(z.number().int().positive()).min(1),
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
});

// =====================================================
// SCHEMAS DE BANCO DE HORAS
// =====================================================

export const criarAjusteHorasSchema = z.object({
  colaboradorId: z.number().int().positive(),
  tipo: z.enum(['credito', 'debito']),
  horas: z.number().positive('Horas deve ser maior que zero'),
  motivo: z.string().min(1, 'Motivo é obrigatório'),
  observacao: z.string().optional(),
  data: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
});

// =====================================================
// SCHEMAS DE SOLICITAÇÃO
// =====================================================

export const solicitarHoraExtraSchema = z.object({
  colaboradorId: z.number().int().positive(),
  gestorId: z.number().int().positive({ message: 'ID do gestor é obrigatório' }),
  data: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  horaInicio: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Formato de hora inválido (HH:MM)'),
  horaFim: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Formato de hora inválido (HH:MM)'),
  motivo: z.string().min(1, 'Motivo é obrigatório'),
  observacao: z.string().optional(),
  anexosIds: z.array(z.number().int().positive()).optional(),
});

export const criarSolicitacaoSchema = z.object({
  tipo: z.enum(['ajuste_ponto', 'ferias', 'atestado', 'ausencia', 'hora_extra', 'atraso', 'outros']),
  gestorId: z.number().int().positive().optional(),
  dataEvento: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  dataEventoFim: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data fim inválida').optional(),
  descricao: z.string().min(1),
  justificativa: z.string().min(1),
  dadosAdicionais: z.record(z.string(), z.unknown()).optional(),
  anexosIds: z.array(z.number().int().positive()).optional(),
}).refine(
  (data) => data.tipo !== 'hora_extra' || data.gestorId !== undefined,
  { message: 'gestorId é obrigatório para solicitações de hora extra', path: ['gestorId'] }
);

export const atualizarSolicitacaoSchema = z.object({
  dataEvento: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida').optional(),
  descricao: z.string().optional(),
  justificativa: z.string().optional(),
  dadosAdicionais: z.record(z.string(), z.unknown()).optional(),
});

export const aprovarSolicitacaoSchema = z.object({
  observacao: z.string().optional(),
});

export const rejeitarSolicitacaoSchema = z.object({
  motivo: z.string().min(1, 'Motivo é obrigatório'),
});

export const criarPendenciaSchema = z.object({
  titulo: z.string().min(3, 'Título deve ter no mínimo 3 caracteres').max(255),
  descricao: z.string().min(3, 'Descrição deve ter no mínimo 3 caracteres'),
  tipo: z.string().min(2, 'Tipo é obrigatório').max(50),
  prioridade: z.enum(['baixa', 'media', 'alta', 'critica']).default('media'),
  destinatarioId: z.number().int().positive().optional().nullable(),
  departamentoId: z.number().int().positive().optional().nullable(),
  dataLimite: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data limite inválida').optional().nullable(),
  dadosAdicionais: z.record(z.string(), z.unknown()).optional(),
});

export const resolverPendenciaSchema = z.object({
  status: z.enum(['aprovada', 'rejeitada', 'cancelada']),
  observacao: z.string().optional(),
});

const ajustePontoItemSchema = z.object({
  marcacaoId: z.number().int().positive(),
  dataHoraCorreta: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data/hora inválida'),
});

export const solicitarAjustePontoSchema = z.object({
  ajustes: z.array(ajustePontoItemSchema).min(1, 'Informe ao menos um ajuste').max(10, 'Máximo de 10 ajustes por solicitação'),
  motivo: z.string().min(1),
  justificativa: z.string().min(1),
});

export const solicitarFeriasSchema = z.object({
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  dataFim: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  dias: z.number().int().positive(),
  observacao: z.string().optional(),
});

export const enviarAtestadoSchema = z.object({
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  dataFim: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  cid: z.string().optional(),
  observacao: z.string().optional(),
  anexoId: z.number().int().positive(),
});

export const justificarAusenciaSchema = z.object({
  data: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  motivo: z.string().min(1),
  justificativa: z.string().min(1),
  anexoId: z.number().int().positive().optional(),
});

export const justificarAtrasoSchema = z.object({
  marcacaoId: z.number().int().positive('ID da marcação é obrigatório'),
  justificativa: z.string().min(3, 'Justificativa deve ter no mínimo 3 caracteres'),
  motivo: z.enum([
    'transito',
    'transporte_publico',
    'problema_saude',
    'problema_familiar',
    'compromisso_medico',
    'outros',
  ], { message: 'Motivo inválido' }),
  anexoId: z.number().int().positive().optional(),
});

// =====================================================
// SCHEMAS DE DEPARTAMENTO
// =====================================================

export const criarDepartamentoSchema = z.object({
  nome: z.string().min(2).max(100),
  descricao: z.string().optional(),
  gestorId: z.number().int().positive().optional(),
});

export const atualizarDepartamentoSchema = z.object({
  nome: z.string().min(2).max(100).optional(),
  descricao: z.string().optional(),
  gestorId: z.number().int().positive().nullable().optional(),
  status: z.enum(['ativo', 'inativo']).optional(),
});

// =====================================================
// SCHEMAS DE LOCALIZAÇÃO
// =====================================================

export const criarLocalizacaoSchema = z.object({
  nome: z.string().min(2).max(100),
  tipo: z.enum(['matriz', 'filial', 'obra', 'cliente', 'outros']),
  endereco: enderecoSchema.optional(),
  coordenadas: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }),
  raioPermitido: z.number().int().positive().default(100),
  horariosFuncionamento: z.array(z.object({
    diaSemana: z.number().int().min(0).max(6),
    abertura: z.string(),
    fechamento: z.string(),
  })).optional(),
});

export const atualizarLocalizacaoSchema = criarLocalizacaoSchema.partial();

export const validarGeofenceSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  localizacaoId: z.number().int().positive().optional(),
});

// =====================================================
// SCHEMAS DE FERIADO
// =====================================================

export const criarFeriadoSchema = z.object({
  nome: z.string().min(2).max(100),
  data: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  tipo: z.enum(['nacional', 'estadual', 'municipal', 'empresa']),
  recorrente: z.boolean().default(false),
  abrangencia: z.string().max(100).optional(),
  descricao: z.string().optional(),
});

export const atualizarFeriadoSchema = criarFeriadoSchema.partial();

// =====================================================
// SCHEMAS DE NOTIFICAÇÃO
// =====================================================

export const marcarNotificacaoLidaSchema = z.object({
  id: z.number().int().positive(),
});

// =====================================================
// SCHEMAS DE CONFIGURAÇÃO
// =====================================================

export const atualizarConfiguracoesSchema = z.object({
  categoria: z.string().min(1),
  configuracoes: z.record(z.string(), z.string()),
});

export const atualizarConfiguracoesEmpresaSchema = z.object({
  razaoSocial: z.string().max(255).optional(),
  nomeFantasia: z.string().max(255).optional(),
  cnpj: z.string().max(18).optional(),
  endereco: enderecoSchema.optional(),
  contato: z.object({
    telefone: z.string().optional(),
    email: z.string().email().optional(),
  }).optional(),
});

export const atualizarToleranciasSchema = z.object({
  toleranciaEntrada: z.number().int().min(0),
  toleranciaSaida: z.number().int().min(0),
  toleranciaIntervalo: z.number().int().min(0),
  considerarFimSemana: z.boolean(),
  considerarFeriados: z.boolean(),
});

// =====================================================
// SCHEMAS DE PARÂMETROS DE HORA EXTRA
// =====================================================

export const parametrosToleranciaAtrasoSchema = z.object({
  toleranciaPeriodoMin: z.number().int().min(0, 'Deve ser >= 0').max(480, 'Deve ser <= 480'),
  toleranciaDiarioMaxMin: z.number().int().min(0, 'Deve ser >= 0').max(480, 'Deve ser <= 480'),
  ativo: z.boolean(),
});

export const parametrosHoraExtraSchema = z.object({
  minutosTolerancia: z.number().int().min(0, 'Minutos de tolerância deve ser >= 0').max(480, 'Minutos de tolerância deve ser <= 480'),
  diasPermitidosPorMes: z.number().int().min(0, 'Dias permitidos deve ser >= 0').max(31, 'Dias permitidos deve ser <= 31'),
  ativo: z.boolean(),
});

export const parametrosBeneficiosSchema = z.object({
  valorValeTransporte: z.number().min(0, 'Valor VT deve ser >= 0'),
  valorValeAlimentacaoColaborador: z.number().min(0, 'Valor VA colaborador deve ser >= 0'),
  valorValeAlimentacaoSupervisor: z.number().min(0, 'Valor VA supervisor deve ser >= 0'),
  valorValeAlimentacaoCoordenador: z.number().min(0, 'Valor VA coordenador deve ser >= 0'),
  horasMinimasParaValeAlimentacao: z.number().min(0, 'Horas mínimas deve ser >= 0').max(24, 'Horas mínimas deve ser <= 24'),
  diasUteisMes: z.number().int().min(1, 'Dias úteis deve ser >= 1').max(31, 'Dias úteis deve ser <= 31'),
  descontoFaltaAlimentacao: z.number().min(0, 'Desconto deve ser >= 0').optional(),
  descontoFaltaCombustivel: z.number().min(0, 'Desconto deve ser >= 0').optional(),
});

// =====================================================
// SCHEMAS DE PARÂMETROS DE RH
// =====================================================

export const parametrosRhSchema = z.object({
  telefoneRh: z.string().max(30, 'Telefone deve ter no máximo 30 caracteres').optional(),
  emailRh: z.string().max(120, 'E-mail deve ter no máximo 120 caracteres').optional(),
  diasExperienciaPadrao: z.number().int().min(0, 'Dias deve ser >= 0').max(365, 'Dias deve ser <= 365').optional(),
  diasProrrogacaoPadrao: z.number().int().min(0, 'Dias deve ser >= 0').max(365, 'Dias deve ser <= 365').optional(),
  diasUteisDataAdmissao: z.number().int().min(0, 'Dias deve ser >= 0').max(90, 'Dias deve ser <= 90').optional(),
  vigenciaConfidencialidadeMeses: z.number().int().min(0, 'Meses deve ser >= 0').max(600, 'Meses deve ser <= 600').optional(),
  aplicarBeneficiosEmDiaTeste: z.boolean().optional(),
});

// =====================================================
// SCHEMAS DE PARÂMETROS DE ASSIDUIDADE
// =====================================================

export const parametrosAssiduidadeSchema = z.object({
  limitePontosZerar: z.number().int().min(0, 'Limite deve ser >= 0').max(100, 'Limite deve ser <= 100'),
  minDiasAdmissaoMes: z.number().int().min(1, 'Dias deve ser >= 1').max(31, 'Dias deve ser <= 31'),
  valorInicial: z.number().min(0, 'Valor deve ser >= 0').max(10000, 'Valor deve ser <= 10000'),
  incrementoMensal: z.number().min(0, 'Valor deve ser >= 0').max(10000, 'Valor deve ser <= 10000'),
  valorMaximo: z.number().min(0, 'Valor deve ser >= 0').max(10000, 'Valor deve ser <= 10000'),
  cargosExcluidos: z.array(z.string().min(1)).default([]),
  ativo: z.boolean(),
});

export const parametrosEsportesSchema = z.object({
  dia_semana: z.number().int().min(0, 'dia_semana deve ser entre 0 e 6').max(6, 'dia_semana deve ser entre 0 e 6'),
  hora_inicio: z.string().regex(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/, 'hora_inicio deve estar no formato HH:MM'),
  total_jogadores: z.number().int().min(2, 'total_jogadores deve ser >= 2').max(200, 'total_jogadores deve ser <= 200'),
  horas_jogo: z.number().int().min(1, 'horas_jogo deve ser >= 1').max(12, 'horas_jogo deve ser <= 12'),
  local: z.string().min(2, 'local é obrigatório').max(255, 'local deve ter no máximo 255 caracteres'),
  ativo: z.boolean(),
});

export const inscricaoEsportesSchema = z.object({
  posicao: z.enum(['linha', 'goleiro'], { message: "posicao aceita apenas 'linha' ou 'goleiro'" }),
});

// =====================================================
// SCHEMAS DE SOLICITAÇÃO DE HORAS EXTRAS (CUSTOS)
// =====================================================

export const criarSolicitacaoHorasExtrasSchema = z.object({
  solicitante: z.string().min(1, 'Nome do solicitante é obrigatório'),
  gestor: z.string().min(1, 'Gestor é obrigatório'),
  data: z.string().refine((val) => /^\d{4}-\d{2}-\d{2}$/.test(val), 'Data deve estar no formato YYYY-MM-DD'),
  de: z.string().min(1, 'Horário inicial é obrigatório'),
  ate: z.string().min(1, 'Horário final é obrigatório'),
  colaborador_id: z.number().int().positive().optional().nullable(),
});

export const limitesHeGestoresSchema = z.object({
  gestor_id: z.number().int().positive('ID do gestor é obrigatório'),
  limite_mensal: z.union([
    z.number().nonnegative(),
    z.null(),
    z.literal(''),
  ]),
  pode_extrapolar: z.boolean().optional().default(true),
});

// =====================================================
// SCHEMAS DE LIMITES HE POR EMPRESA / DEPARTAMENTO
// =====================================================

export const limitesHeEmpresasSchema = z.object({
  empresa_id: z.number().int().positive('ID da empresa é obrigatório'),
  limite_mensal: z.number().nonnegative('Limite mensal deve ser não-negativo'),
});

export const limitesHeDepartamentosSchema = z.object({
  empresa_id: z.number().int().positive('ID da empresa é obrigatório'),
  departamento_id: z.number().int().positive('ID do departamento é obrigatório'),
  limite_mensal: z.number().nonnegative('Limite mensal deve ser não-negativo'),
});

export const liderancasDepartamentoSchema = z.object({
  empresa_id: z.number().int().positive('ID da empresa é obrigatório'),
  departamento_id: z.number().int().positive('ID do departamento é obrigatório'),
  supervisor_ids: z.array(z.number().int().positive()).optional().default([]),
  coordenador_ids: z.array(z.number().int().positive()).optional().default([]),
  gerente_ids: z.array(z.number().int().positive()).optional().default([]),
});

// =====================================================
// SCHEMAS DE INTEGRAÇÃO
// =====================================================

export const exportarWinthorSchema = z.object({
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  dataFim: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  formato: z.string().optional(),
  incluirBancoHoras: z.boolean(),
});

export const exportarAlterdataSchema = z.object({
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  dataFim: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  tipoArquivo: z.string(),
  incluirEventos: z.boolean(),
});

export const processarWebhookSchema = z.object({
  origem: z.string(),
  evento: z.string(),
  dados: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
});

// =====================================================
// SCHEMAS DE BIOMETRIA FACIAL
// =====================================================

export const cadastrarFaceSchema = z.object({
  colaboradorId: z.number().int().positive(),
  fotos: z.array(z.string()).min(1, 'Pelo menos uma foto é obrigatória'),
  qualidade: z.enum(['baixa', 'media', 'alta']).optional(),
});

/** Tipos de marcação aceitos no POST biometria/verificar-face (tipoPonto). */
const TIPO_MARCACAO_BIOMETRIA = ['entrada', 'saida', 'almoco', 'retorno'] as const;

/**
 * Campo tipoPonto: aceita maiúsculas, acentos (saída, almoço), string vazia/null (vira omitido),
 * "auto" (detecção automática, igual a omitir) e sufixo após "." (ex.: serialização de enum Dart).
 */
export const tipoPontoBiometriaSchema = z.preprocess((val: unknown) => {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') return val;
  let s = val.trim().toLowerCase();
  if (s === '') return undefined;
  const dot = s.lastIndexOf('.');
  if (dot >= 0) s = s.slice(dot + 1);
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (s === '' || s === 'auto') return undefined;
  return s;
}, z.enum(TIPO_MARCACAO_BIOMETRIA).optional());

export const verificarFaceSchema = z.object({
  foto: z.string().min(1, 'Foto é obrigatória'),
  localizacao: z.object({
    latitude: z.number(),
    longitude: z.number(),
  }).optional(),
});

// =====================================================
// SCHEMAS DE RELATÓRIO
// =====================================================

export const relatorioCustomizadoSchema = z.object({
  nome: z.string().min(1),
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  dataFim: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data inválida'),
  campos: z.array(z.string()),
  filtros: z.record(z.string(), z.unknown()).optional(),
  agrupamento: z.string().optional(),
  ordenacao: z.string().optional(),
  formato: z.enum(['json', 'pdf', 'excel']).optional(),
});

// =====================================================
// SCHEMAS DE CONFIGURAÇÕES DO SISTEMA (por empresa)
// =====================================================

export const configGeralSchema = z.object({
  nomeEmpresa: z.string().min(1, 'Nome da empresa é obrigatório').max(255),
  fusoHorario: z.string().min(1).max(100),
  formatoData: z.string().min(1).max(20),
  formatoHora: z.enum(['24h', '12h']),
  idioma: z.string().min(2).max(10),
});

export const configPontoSchema = z.object({
  toleranciaEntrada: z.number().int().min(0).max(120),
  toleranciaSaida: z.number().int().min(0).max(120),
  intervaloMinimoMarcacoes: z.number().int().min(0).max(60),
  permitirMarcacaoOffline: z.boolean(),
  exigirFotoPadrao: z.boolean(),
  exigirGeolocalizacaoPadrao: z.boolean(),
  raioMaximoGeolocalizacao: z.number().int().min(10).max(10000),
  permitirMarcacaoForaPerimetro: z.boolean(),
  bloquearMarcacaoDuplicada: z.boolean(),
  tempoBloqueioDuplicada: z.number().int().min(1).max(60),
});

export const configNotificacoesSchema = z.object({
  notificarAtrasos: z.boolean(),
  notificarFaltasMarcacao: z.boolean(),
  notificarHorasExtras: z.boolean(),
  notificarAprovacoesPendentes: z.boolean(),
  emailNotificacoes: z.boolean(),
  pushNotificacoes: z.boolean(),
  resumoDiario: z.boolean(),
  horarioResumoDiario: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Formato de hora inválido (HH:MM)'),
});

export const configSegurancaSchema = z.object({
  tempoSessao: z.number().int().min(5).max(1440),
  exigirSenhaForte: z.boolean(),
  tamanhoMinimoSenha: z.number().int().min(4).max(64),
  exigirTrocaSenhaPeriodica: z.boolean(),
  diasTrocaSenha: z.number().int().min(1).max(365),
  tentativasLoginMax: z.number().int().min(1).max(20),
  tempoBloqueioLogin: z.number().int().min(1).max(1440),
  autenticacaoDoisFatores: z.boolean(),
});

export const configAparenciaSchema = z.object({
  tema: z.enum(['claro', 'escuro']),
  corPrimaria: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve estar no formato hexadecimal (#RRGGBB)'),
  mostrarLogoSidebar: z.boolean(),
  compactarSidebar: z.boolean(),
});

export const atualizarConfigSistemaSchema = z.object({
  geral: configGeralSchema.optional(),
  ponto: configPontoSchema.optional(),
  notificacoes: configNotificacoesSchema.optional(),
  seguranca: configSegurancaSchema.optional(),
  aparencia: configAparenciaSchema.optional(),
}).refine(
  (data) => data.geral || data.ponto || data.notificacoes || data.seguranca || data.aparencia,
  { message: 'Pelo menos uma seção de configuração deve ser enviada' }
);

// =====================================================
// SCHEMAS DE PRESTADORES DE SERVIÇOS
// =====================================================

export const criarPrestadorSchema = z.object({
  razaoSocial: z.string().min(2, 'Razão social deve ter no mínimo 2 caracteres').max(255),
  nomeFantasia: z.string().max(255).optional().nullable(),
  cnpjCpf: z.string().min(11, 'CNPJ/CPF inválido').max(20),
  tipo: z.any().optional().transform(() => 'PJ' as const),
  email: z.string().email('Email inválido').optional().nullable(),
  telefone: z.string().max(20).optional().nullable(),
  endereco: z.string().max(500).optional().nullable(),
  areaAtuacao: z.string().max(100).optional().nullable(),
  status: z.enum(['ativo', 'inativo', 'bloqueado'], { message: 'Status deve ser ativo, inativo ou bloqueado' }).optional().default('ativo'),
  observacoes: z.string().optional().nullable(),
});

export const atualizarPrestadorSchema = criarPrestadorSchema.partial();

export const criarContratoPrestadorSchema = z.object({
  prestadorId: z.number().int().positive('Prestador é obrigatório'),
  numero: z.string().min(1, 'Número do contrato é obrigatório').max(50),
  descricao: z.string().optional().nullable(),
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data início inválida'),
  dataFim: z.string().refine((val) => !val || !isNaN(Date.parse(val)), 'Data fim inválida').optional().nullable(),
  valor: z.number().min(0, 'Valor deve ser >= 0'),
  formaPagamento: z.enum(['mensal', 'quinzenal', 'por_demanda', 'unico'], { message: 'Forma de pagamento inválida' }),
  status: z.enum(['vigente', 'vencido', 'renovado', 'cancelado'], { message: 'Status do contrato inválido' }).optional().default('vigente'),
  alertaRenovacaoDias: z.number().int().min(0).max(365).optional().default(30),
  observacoes: z.string().optional().nullable(),
  arquivoUrl: z.string().max(500).optional().nullable(),
});

export const atualizarContratoPrestadorSchema = criarContratoPrestadorSchema.partial();

export const criarNfePrestadorSchema = z.object({
  prestadorId: z.number().int().positive('Prestador é obrigatório'),
  contratoId: z.number().int().positive().optional().nullable(),
  numero: z.string().max(20).optional().nullable(),
  serie: z.string().max(5).optional().nullable(),
  chaveAcesso: z.string().max(50).optional().nullable(),
  dataEmissao: z.string().refine((val) => !val || !isNaN(Date.parse(val)), 'Data de emissão inválida').optional().nullable(),
  valor: z.number().min(0, 'Valor deve ser >= 0').optional(),
  status: z.enum(['pendente', 'aprovada', 'rejeitada', 'paga'], { message: 'Status da NFe inválido' }).optional().default('pendente'),
  arquivoUrl: z.string().max(500).optional().nullable(),
  observacoes: z.string().optional().nullable(),
});

export const atualizarNfePrestadorSchema = criarNfePrestadorSchema.partial();

// =====================================================
// HELPER DE VALIDAÇÃO
// =====================================================

// =====================================================
// SCHEMAS DE FÉRIAS (DESIGNAÇÃO DIRETA)
// =====================================================

export const designarFeriasSchema = z.object({
  colaboradorId: z.number().int().positive('Colaborador é obrigatório'),
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data início inválida'),
  dataFim: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data fim inválida'),
  observacao: z.string().optional(),
}).refine(
  (data) => new Date(data.dataFim) >= new Date(data.dataInicio),
  { message: 'Data fim deve ser maior ou igual à data início', path: ['dataFim'] }
);

export const atualizarFeriasSchema = z.object({
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data início inválida').optional(),
  dataFim: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data fim inválida').optional(),
  observacao: z.string().optional(),
});

export function validateBody<T>(schema: z.ZodSchema<T>, body: unknown): { 
  success: true; 
  data: T; 
} | { 
  success: false; 
  errors: Record<string, string[]>; 
} {
  const result = schema.safeParse(body);
  
  if (result.success) {
    return { success: true, data: result.data };
  }
  
  const errors: Record<string, string[]> = {};
  result.error.issues.forEach((err) => {
    const path = err.path.join('.');
    if (!errors[path]) {
      errors[path] = [];
    }
    errors[path].push(err.message);
  });
  
  return { success: false, errors };
}

// =====================================================
// SCHEMAS DE GESTÃO DE PESSOAS
// =====================================================

export const atualizarGestaoPessoasSchema = z.object({
  status: z.enum(['pendente', 'em_andamento', 'concluido', 'cancelado']).optional(),
  titulo: z.string().min(3, 'Título deve ter no mínimo 3 caracteres').max(255).optional(),
  descricao: z.string().min(3, 'Descrição deve ter no mínimo 3 caracteres').optional(),
  reuniaoData: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data da reunião inválida').optional(),
  reuniaoHora: z.string().regex(/^\d{2}:\d{2}$/, 'Hora deve estar no formato HH:mm').optional(),
  reuniaoStatus: z.enum(['agendada', 'realizada', 'cancelada']).optional(),
  reuniaoObservacoes: z.string().optional().nullable(),
  participantesIds: z.array(z.number().int().positive()).min(1, 'Pelo menos 1 participante').optional(),
});

// =====================================================
// SCHEMAS DE REUNIÕES (Jitsi)
// =====================================================

export const agendarReuniaoSchema = z.object({
  titulo: z.string().min(3, 'Título deve ter no mínimo 3 caracteres').max(255),
  descricao: z.string().optional(),
  dataInicio: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data de início inválida'),
  dataFim: z.string().refine((val) => !isNaN(Date.parse(val)), 'Data de fim inválida'),
  participantesIds: z.array(z.number().int().positive()).min(1, 'Pelo menos 1 participante'),
});

// =====================================================
// SCHEMAS DE FORMULÁRIO DE ADMISSÃO
// =====================================================

export const formularioAdmissaoCampoSchema = z.object({
  id: z.string().optional().nullable(),
  label: z.string().min(1, 'Label é obrigatório').max(255),
  tipo: z.enum(['text', 'number', 'email', 'phone', 'cpf', 'date', 'select', 'checkbox', 'file', 'exam_schedule', 'photo', 'face_capture'] as const),
  obrigatorio: z.boolean().default(false),
  ativo: z.boolean().default(true),
  ordem: z.number().int().min(1, 'Ordem deve ser maior que 0'),
  opcoes: z.array(z.string()).default([]),
  secaoNome: z.string().max(255).optional().nullable(),
});

const formularioDocumentoRequeridoSchema = z.object({
  tipoDocumentoId: z.number().int().positive('tipoDocumentoId inválido'),
  obrigatorio: z.boolean().default(false),
  cargosOpcoes: z.array(z.string()).optional().default([]),
});

export const salvarFormularioAdmissaoSchema = z.object({
  id: z.string().uuid('ID inválido').optional(),
  titulo: z.string().min(3, 'Título deve ter no mínimo 3 caracteres').max(255),
  descricao: z.string().max(2000).optional().nullable(),
  campos: z.array(formularioAdmissaoCampoSchema).min(1, 'Pelo menos 1 campo é obrigatório'),
  documentosRequeridos: z.array(formularioDocumentoRequeridoSchema).optional().default([]),
});

export const gerarLinkFormularioAdmissaoSchema = z.object({
  id: z.string().uuid('ID inválido').optional(),
});
