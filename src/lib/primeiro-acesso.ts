/**
 * Lógica do "primeiro acesso": troca obrigatória de senha quando admin
 * definiu uma temporária e prompt de cadastro de biometria facial.
 *
 * O prompt de biometria é exibido em até dois momentos:
 *  - Inicial: count=0 (nunca dispensou)
 *  - Reaviso: count=1 e a dispensa anterior foi há >=7 dias
 *
 * Após o segundo skip (count >= 2) o prompt nunca mais aparece.
 */

export type FaseBiometriaPrompt = 'inicial' | 'reaviso';

export interface BiometriaPrompt {
  exibir: boolean;
  fase: FaseBiometriaPrompt | null;
}

const REAVISO_DIAS = 7;

export function calcularBiometriaPrompt(opts: {
  faceRegistrada: boolean;
  dispensasCount: number;
  dispensadaEm: Date | string | null;
}): BiometriaPrompt {
  if (opts.faceRegistrada) return { exibir: false, fase: null };

  const count = opts.dispensasCount ?? 0;

  if (count === 0) return { exibir: true, fase: 'inicial' };

  if (count === 1) {
    if (!opts.dispensadaEm) return { exibir: true, fase: 'reaviso' };
    const dispensaTs = typeof opts.dispensadaEm === 'string'
      ? new Date(opts.dispensadaEm).getTime()
      : opts.dispensadaEm.getTime();
    const diasDesdeDispensa = (Date.now() - dispensaTs) / (1000 * 60 * 60 * 24);
    if (diasDesdeDispensa >= REAVISO_DIAS) return { exibir: true, fase: 'reaviso' };
    return { exibir: false, fase: null };
  }

  return { exibir: false, fase: null };
}
