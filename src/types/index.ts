// Tipos de usuário
export type TipoUsuario = 'colaborador' | 'gestor' | 'gerente' | 'supervisor' | 'coordenador' | 'admin';

// Tipos com permissão de gestão (podem aprovar solicitações, gerenciar colaboradores, etc.)
export const TIPOS_GESTAO: TipoUsuario[] = ['gestor', 'gerente', 'supervisor', 'coordenador', 'admin'];
export type StatusRegistro = 'ativo' | 'inativo';
export type TipoMarcacao = 'entrada' | 'saida' | 'almoco' | 'retorno';
export type MetodoMarcacao = 'app' | 'web' | 'biometria';
export type TipoMovimentacaoHoras = 'credito' | 'debito' | 'compensacao' | 'ajuste' | 'hora_extra';
export type StatusSolicitacao = 'pendente' | 'aprovada' | 'rejeitada' | 'cancelada';
export type TipoSolicitacao = 'ajuste_ponto' | 'ferias' | 'atestado' | 'ausencia' | 'hora_extra' | 'atraso' | 'recurso_relatorio' | 'outros';
export type StatusRelatorioMensal = 'pendente' | 'assinado' | 'recurso' | 'recurso_resolvido';
export type TipoAnexo = 'atestado' | 'comprovante' | 'documento' | 'foto' | 'outros';
export type TipoLocalizacao = 'matriz' | 'filial' | 'obra' | 'cliente' | 'outros';
export type TipoFeriado = 'nacional' | 'estadual' | 'municipal' | 'empresa';
export type TipoNotificacao = 'sistema' | 'solicitacao' | 'marcacao' | 'alerta' | 'lembrete';

// Interfaces de entidades
export interface Colaborador {
  id: number;
  nome: string;
  email: string;
  cpf: string;
  rg?: string;
  telefone?: string;
  cargoId?: number;
  tipo: TipoUsuario;
  departamentoId?: number;
  jornadaId?: number;
  dataAdmissao: string;
  dataNascimento?: string;
  status: StatusRegistro;
  fotoUrl?: string;
  faceRegistrada: boolean;
  endereco?: Endereco;
}

export interface Endereco {
  cep?: string;
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
}

export interface Departamento {
  id: number;
  nome: string;
  descricao?: string;
  gestorId?: number;
  status: StatusRegistro;
}

export interface Jornada {
  id: number;
  nome: string;
  descricao?: string;
  cargaHorariaSemanal: number;
  toleranciaEntrada: number;
  toleranciaSaida: number;
  status: StatusRegistro;
  horarios: HorarioJornada[];
}

export interface HorarioJornada {
  diaSemana: number;
  entrada: string;
  saidaAlmoco?: string;
  retornoAlmoco?: string;
  saida: string;
}

export interface Marcacao {
  id: number;
  colaboradorId: number;
  dataHora: string;
  tipo: TipoMarcacao;
  latitude?: number;
  longitude?: number;
  endereco?: string;
  metodo: MetodoMarcacao;
  fotoUrl?: string;
  observacao?: string;
  justificativa?: string;
}

export interface BancoHoras {
  id: number;
  colaboradorId: number;
  data: string;
  tipo: TipoMovimentacaoHoras;
  descricao?: string;
  horas: number;
  saldoAnterior: number;
  saldoAtual: number;
  observacao?: string;
}

export interface Solicitacao {
  id: number;
  colaboradorId: number;
  tipo: TipoSolicitacao;
  status: StatusSolicitacao;
  dataSolicitacao: string;
  dataEvento?: string;
  dataEventoFim?: string;
  descricao?: string;
  justificativa?: string;
  dadosAdicionais?: Record<string, unknown>;
  gestorId?: number;
  aprovadorId?: number;
  dataAprovacao?: string;
  motivoRejeicao?: string;
}

export interface Anexo {
  id: number;
  colaboradorId?: number;
  solicitacaoId?: number;
  tipo: TipoAnexo;
  nome: string;
  url: string;
  tamanho?: number;
  descricao?: string;
}

export interface Localizacao {
  id: number;
  nome: string;
  tipo: TipoLocalizacao;
  endereco?: Endereco;
  latitude: number;
  longitude: number;
  raioPermitido: number;
  status: StatusRegistro;
}

export interface Feriado {
  id: number;
  nome: string;
  data: string;
  tipo: TipoFeriado;
  recorrente: boolean;
  abrangencia?: string;
  descricao?: string;
}

export interface Notificacao {
  id: number;
  usuarioId: number;
  tipo: TipoNotificacao;
  titulo: string;
  mensagem: string;
  lida: boolean;
  dataEnvio: string;
  dataLeitura?: string;
  link?: string;
  metadados?: Record<string, unknown>;
}

// Interfaces de resposta
export interface Paginacao {
  total: number;
  pagina: number;
  limite: number;
  totalPaginas: number;
}

export interface RespostaPaginada<T> {
  dados: T[];
  paginacao: Paginacao;
}

export interface RespostaLogin {
  token: string;
  refreshToken: string;
  usuario: {
    id: number;
    nome: string;
    email: string;
    tipo: TipoUsuario;
    foto?: string;
  };
}
