import { query } from '@/lib/db';

export type PosicaoEsporte = 'linha' | 'goleiro';

export interface ParametrosEsportes {
  id: number | null;
  dia_semana: number;
  hora_inicio: string;
  total_jogadores: number;
  horas_jogo: number;
  local: string;
  ativo: boolean;
}

export function validarPosicao(valor: unknown): valor is PosicaoEsporte {
  return valor === 'linha' || valor === 'goleiro';
}

export async function buscarParametrosEsportes(): Promise<ParametrosEsportes> {
  const result = await query(
    `SELECT id, dia_semana, hora_inicio::text AS hora_inicio, total_jogadores, horas_jogo, local, ativo
     FROM bluepoint.bt_parametros_esportes
     ORDER BY id DESC
     LIMIT 1`,
  );

  if (result.rows.length === 0) {
    return {
      id: null,
      dia_semana: 2,
      hora_inicio: '18:30',
      total_jogadores: 14,
      horas_jogo: 2,
      local: 'Quadra Society',
      ativo: true,
    };
  }

  return result.rows[0] as ParametrosEsportes;
}

export async function calcularProximaDataSessao(diaSemana: number): Promise<{ proximaData: string; ehHoje: boolean }> {
  const result = await query(
    `SELECT
        (
          CURRENT_DATE
          + ((($1::int - EXTRACT(DOW FROM CURRENT_DATE)::int + 7) % 7) * INTERVAL '1 day')
        )::date::text AS proxima_data,
        (
          (
            CURRENT_DATE
            + ((($1::int - EXTRACT(DOW FROM CURRENT_DATE)::int + 7) % 7) * INTERVAL '1 day')
          )::date = CURRENT_DATE
        ) AS eh_hoje`,
    [diaSemana],
  );

  return {
    proximaData: result.rows[0].proxima_data,
    ehHoje: result.rows[0].eh_hoje === true,
  };
}

export async function obterOuCriarSessaoPorData(dataSessao: string, parametros: ParametrosEsportes): Promise<number> {
  const insertResult = await query(
    `INSERT INTO bluepoint.bt_esportes_sessoes (data_sessao, hora_inicio, horas_jogo, local, total_vagas)
     VALUES ($1, $2::time, $3, $4, $5)
     ON CONFLICT (data_sessao) DO NOTHING
     RETURNING id`,
    [dataSessao, parametros.hora_inicio, parametros.horas_jogo, parametros.local, parametros.total_jogadores],
  );

  if (insertResult.rows.length > 0) {
    return insertResult.rows[0].id as number;
  }

  const sessaoResult = await query(
    `SELECT id FROM bluepoint.bt_esportes_sessoes WHERE data_sessao = $1 LIMIT 1`,
    [dataSessao],
  );

  return sessaoResult.rows[0].id as number;
}
