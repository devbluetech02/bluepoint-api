/**
 * Lógica do "primeiro acesso": troca obrigatória de senha quando admin
 * definiu uma temporária e prompt de cadastro de biometria facial.
 *
 * Política de biometria (atual):
 *   - face_registrada=true  → não exibe prompt
 *   - face_registrada=false → SEMPRE exibe prompt (fase='inicial')
 *
 * O contador de dispensas (`biometria_dispensas_count`) e a data
 * (`biometria_dispensada_em`) continuam sendo preenchidos pelo endpoint
 * `/colaboradores/me/biometria/dispensar` pra fins de auditoria, mas
 * NÃO interferem mais na decisão de exibir o prompt — o app força o
 * cadastro a cada login enquanto o colaborador não tiver rosto salvo.
 */

export type FaseBiometriaPrompt = 'inicial' | 'reaviso';

export interface BiometriaPrompt {
  exibir: boolean;
  fase: FaseBiometriaPrompt | null;
}

export function calcularBiometriaPrompt(opts: {
  faceRegistrada: boolean;
  dispensasCount: number;
  dispensadaEm: Date | string | null;
}): BiometriaPrompt {
  if (opts.faceRegistrada) return { exibir: false, fase: null };
  return { exibir: true, fase: 'inicial' };
}
