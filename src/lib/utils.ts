// Utilitários gerais

// Formatar CPF
export function formatCPF(cpf: string): string {
  const numbers = cpf.replace(/\D/g, '');
  return numbers.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

// Limpar CPF (apenas números)
export function cleanCPF(cpf: string): string {
  return cpf.replace(/\D/g, '');
}

// Validar CPF
export function isValidCPF(cpf: string): boolean {
  const numbers = cleanCPF(cpf);
  
  if (numbers.length !== 11) return false;
  if (/^(\d)\1+$/.test(numbers)) return false;
  
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(numbers[i]) * (10 - i);
  }
  let digit = 11 - (sum % 11);
  if (digit > 9) digit = 0;
  if (digit !== parseInt(numbers[9])) return false;
  
  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(numbers[i]) * (11 - i);
  }
  digit = 11 - (sum % 11);
  if (digit > 9) digit = 0;
  if (digit !== parseInt(numbers[10])) return false;
  
  return true;
}

// Formatar CNPJ
export function formatCNPJ(cnpj: string): string {
  const numbers = cnpj.replace(/\D/g, '');
  return numbers.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}

// Formatar telefone
export function formatPhone(phone: string): string {
  const numbers = phone.replace(/\D/g, '');
  if (numbers.length === 11) {
    return numbers.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  }
  return numbers.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
}

// Formatar CEP
export function formatCEP(cep: string): string {
  const numbers = cep.replace(/\D/g, '');
  return numbers.replace(/(\d{5})(\d{3})/, '$1-$2');
}

// Converter minutos para formato HH:MM
export function minutesToHHMM(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absMinutes = Math.abs(minutes);
  const hours = Math.floor(absMinutes / 60);
  const mins = absMinutes % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

// Converter HH:MM para minutos
export function HHMMToMinutes(time: string): number {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

// Calcular diferença em minutos entre dois horários
export function timeDiffMinutes(start: string, end: string): number {
  return HHMMToMinutes(end) - HHMMToMinutes(start);
}

// Obter dia da semana (0=domingo, 6=sábado)
export function getDayOfWeek(date: Date): number {
  return date.getDay();
}

// Formatar data para YYYY-MM-DD
export function formatDateISO(date: Date): string {
  return date.toISOString().split('T')[0];
}

// Formatar data para DD/MM/YYYY
export function formatDateBR(date: Date): string {
  return date.toLocaleDateString('pt-BR');
}

// Formatar data e hora para DD/MM/YYYY HH:MM
export function formatDateTimeBR(date: Date): string {
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Verificar se é dia útil (segunda a sexta)
export function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

// Calcular distância entre dois pontos (Haversine formula)
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371e3; // raio da Terra em metros
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // retorna distância em metros
}

// Gerar código alfanumérico
export function generateCode(length: number = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Converter snake_case para camelCase
export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

// Converter objeto com snake_case para camelCase
export function objectSnakeToCamel<T extends Record<string, unknown>>(
  obj: T
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = snakeToCamel(key);
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      result[camelKey] = objectSnakeToCamel(value as Record<string, unknown>);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

// Nome do dia da semana
export function getDayName(dayIndex: number): string {
  const days = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
  return days[dayIndex] || '';
}

// Calcular carga horária de um horário de jornada
export function calcularCargaHoraria(
  periodos: Array<{ entrada: string; saida: string }> | null,
  folga: boolean = false
): number {
  if (folga || !periodos || periodos.length === 0) return 0;
  
  let minutos = 0;
  
  for (const periodo of periodos) {
    if (periodo.entrada && periodo.saida) {
      minutos += timeDiffMinutes(periodo.entrada, periodo.saida);
    }
  }
  
  return minutos / 60; // retorna em horas
}
