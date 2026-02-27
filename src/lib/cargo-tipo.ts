// =====================================================
// Mapeamento automático: Cargo → Tipo de Usuário
// =====================================================
// Detecta o tipo de usuário baseado no nome do cargo.
// Cargos de gestão recebem tipos com permissão elevada.
// =====================================================

import { TipoUsuario } from '@/types';

/**
 * Palavras-chave que indicam cargo de gestão, em ordem de prioridade.
 * A primeira correspondência encontrada no nome do cargo define o tipo.
 */
const CARGO_TIPO_MAP: { palavras: string[]; tipo: TipoUsuario }[] = [
  { palavras: ['diretor', 'diretora', 'ceo', 'cto', 'cfo', 'coo'], tipo: 'admin' },
  { palavras: ['gerente'], tipo: 'gerente' },
  { palavras: ['supervisor', 'supervisora'], tipo: 'supervisor' },
  { palavras: ['coordenador', 'coordenadora'], tipo: 'coordenador' },
  { palavras: ['gestor', 'gestora'], tipo: 'gestor' },
];

/**
 * Detecta o tipo de usuário baseado no nome do cargo.
 *
 * Exemplos:
 *   "Gerente de Operações"  → 'gerente'
 *   "Supervisor de Vendas"  → 'supervisor'
 *   "Coordenador Financeiro" → 'coordenador'
 *   "Gestor de Projetos"    → 'gestor'
 *   "Diretor Comercial"     → 'admin'
 *   "Analista de TI"        → 'colaborador'
 *   "Vendedor"              → 'colaborador'
 *
 * @param cargoNome Nome do cargo
 * @returns O tipo de usuário correspondente
 */
export function detectarTipoPorCargo(cargoNome: string): TipoUsuario {
  if (!cargoNome) return 'colaborador';

  const nomeNormalizado = cargoNome.toLowerCase().trim();

  for (const { palavras, tipo } of CARGO_TIPO_MAP) {
    if (palavras.some((p) => nomeNormalizado.includes(p))) {
      return tipo;
    }
  }

  return 'colaborador';
}
