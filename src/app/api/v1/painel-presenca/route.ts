import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { getDiasEmFeriasNoPeriodo } from '@/lib/periodos-ferias';

// =====================================================
// HELPERS
// =====================================================

/**
 * Determina o status de presença de um colaborador com base nas marcações do dia.
 */
function classificarPresenca(
  marcacoes: Array<{ data_hora: string; tipo: string }>,
  horaAtual: string,
  isFolga: boolean
): {
  status: 'trabalhando' | 'almoco' | 'ausente' | 'atrasado' | 'saiu' | 'folga' | 'pendente' | 'ferias';
  chegouAtrasado: boolean;
  primeiraEntrada: string | null;
  ultimaMarcacao: string | null;
  ultimoTipo: string | null;
} {
  const HORA_LIMITE = '09:00:00';

  // Dia de folga/feriado
  if (isFolga) {
    return {
      status: 'folga',
      chegouAtrasado: false,
      primeiraEntrada: null,
      ultimaMarcacao: null,
      ultimoTipo: null,
    };
  }

  // Sem marcações hoje
  if (marcacoes.length === 0) {
    // Se ainda não deu 9h, está "pendente" (ainda pode chegar)
    if (horaAtual < HORA_LIMITE) {
      return {
        status: 'pendente',
        chegouAtrasado: false,
        primeiraEntrada: null,
        ultimaMarcacao: null,
        ultimoTipo: null,
      };
    }

    // Passou das 9h sem bater ponto → ausente
    return {
      status: 'ausente',
      chegouAtrasado: false,
      primeiraEntrada: null,
      ultimaMarcacao: null,
      ultimoTipo: null,
    };
  }

  // Tem marcações → analisar
  const primeiraEntrada = marcacoes.find(m => m.tipo === 'entrada');
  const ultimaMarcacao = marcacoes[marcacoes.length - 1];

  // Hora da primeira entrada (HH:MM:SS)
  const horaPrimeiraEntrada = primeiraEntrada
    ? primeiraEntrada.data_hora.replace(' ', 'T').split('T')[1]?.substring(0, 8) || ''
    : '';

  const chegouAtrasado = primeiraEntrada ? horaPrimeiraEntrada > HORA_LIMITE : false;

  // Determinar status pelo último tipo de marcação
  let status: 'trabalhando' | 'almoco' | 'ausente' | 'atrasado' | 'saiu' | 'folga' | 'pendente';

  if (ultimaMarcacao.tipo === 'entrada' || ultimaMarcacao.tipo === 'retorno') {
    // Se chegou atrasado E está trabalhando, o status principal é "atrasado"
    status = chegouAtrasado ? 'atrasado' : 'trabalhando';
  } else if (ultimaMarcacao.tipo === 'almoco') {
    status = 'almoco';
  } else if (ultimaMarcacao.tipo === 'saida') {
    status = 'saiu';
  } else {
    status = 'trabalhando';
  }

  return {
    status,
    chegouAtrasado,
    primeiraEntrada: primeiraEntrada?.data_hora || null,
    ultimaMarcacao: ultimaMarcacao.data_hora,
    ultimoTipo: ultimaMarcacao.tipo,
  };
}

// =====================================================
// GET /api/v1/painel-presenca
// =====================================================

export async function GET(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const { searchParams } = new URL(req.url);

      // ---------- Parâmetros ----------
      const empresaId = searchParams.get('empresaId');
      const departamentoId = searchParams.get('departamentoId');

      // Gerar chave de cache (TTL curto pois é tempo real)
      const cacheKey = buildListCacheKey(CACHE_KEYS.STATUS_TEMPO_REAL, {
        tipo: 'painel-presenca',
        empresaId,
        departamentoId,
      });

      const resultado = await cacheAside(cacheKey, async () => {

        // Obter data/hora atual do banco (timezone America/Sao_Paulo)
        const nowResult = await query<{ agora: string; hoje: string; hora_atual: string }>(
          "SELECT NOW()::timestamp AS agora, CURRENT_DATE::text AS hoje, TO_CHAR(NOW(), 'HH24:MI:SS') AS hora_atual"
        );
        const hoje = nowResult.rows[0].hoje;
        const horaAtual = nowResult.rows[0].hora_atual;

        // ---------- Filtros de colaboradores ----------
        const conditions: string[] = ["c.status = 'ativo'"];
        const params: unknown[] = [];
        let pi = 1;

        if (empresaId) {
          conditions.push(`c.empresa_id = $${pi}`);
          params.push(parseInt(empresaId));
          pi++;
        }

        if (departamentoId) {
          conditions.push(`c.departamento_id = $${pi}`);
          params.push(parseInt(departamentoId));
          pi++;
        }

        const where = `WHERE ${conditions.join(' AND ')}`;

        // ---------- Buscar todos os colaboradores ativos ----------
        const colabResult = await query(
          `SELECT
             c.id, c.nome, c.cpf, c.foto_url, c.cargo_id, cg.nome AS cargo_nome,
             c.departamento_id, d.nome AS departamento_nome,
             c.empresa_id, e.nome_fantasia AS empresa_nome,
             c.jornada_id
           FROM bluepoint.bt_colaboradores c
           LEFT JOIN bluepoint.bt_cargos cg       ON c.cargo_id        = cg.id
           LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
           LEFT JOIN bluepoint.bt_empresas e      ON c.empresa_id      = e.id
           ${where}
           ORDER BY c.nome ASC`,
          params
        );

        if (colabResult.rows.length === 0) {
          return {
            resumo: {
              total: 0,
              trabalhando: 0,
              atrasados: 0,
              ausentes: 0,
              almoco: 0,
              saiu: 0,
              folga: 0,
              pendente: 0,
              ferias: 0,
            },
            colaboradores: [],
            horaConsulta: horaAtual,
            dataConsulta: hoje,
          };
        }

        const colabIds = colabResult.rows.map((r) => (r as { id: number }).id);
        const jornadaIds = [
          ...new Set(
            colabResult.rows
              .map((r) => (r as { jornada_id: number | null }).jornada_id)
              .filter(Boolean) as number[]
          ),
        ];

        // ---------- Buscar marcações de hoje ----------
        const marcResult = await query(
          `SELECT colaborador_id, data_hora, tipo
           FROM bluepoint.bt_marcacoes
           WHERE colaborador_id = ANY($1)
             AND data_hora::date = $2::date
           ORDER BY data_hora ASC`,
          [colabIds, hoje]
        );

        // Indexar marcações por colaborador
        const marcMap = new Map<number, Array<{ data_hora: string; tipo: string }>>();
        for (const m of marcResult.rows) {
          const key = m.colaborador_id as number;
          if (!marcMap.has(key)) marcMap.set(key, []);
          marcMap.get(key)!.push({ data_hora: m.data_hora, tipo: m.tipo });
        }

        // ---------- Buscar jornadas para verificar folga ----------
        const jornadaFolgaMap = new Map<number, boolean>(); // jornadaId → isFolga hoje

        if (jornadaIds.length > 0) {
          const dow = new Date(hoje + 'T12:00:00').getDay(); // 0=dom … 6=sab

          const horResult = await query(
            `SELECT jornada_id, dia_semana, dias_semana, folga
             FROM bluepoint.bt_jornada_horarios
             WHERE jornada_id = ANY($1)`,
            [jornadaIds]
          );

          for (const jId of jornadaIds) {
            const horarios = horResult.rows.filter(
              (r) => (r as { jornada_id: number }).jornada_id === jId
            );

            // Procurar horário para o dia de hoje
            const horario = horarios.find((h) => {
              const hTyped = h as { dia_semana: number | null; dias_semana: number[] | string | null; folga: boolean };
              const diasSemana =
                typeof hTyped.dias_semana === 'string'
                  ? JSON.parse(hTyped.dias_semana)
                  : hTyped.dias_semana || [];
              return (
                hTyped.dia_semana === dow ||
                (hTyped.dia_semana === null && Array.isArray(diasSemana) && diasSemana.includes(dow))
              );
            });

            if (!horario) {
              // Sem jornada para hoje: assume folga em sab/dom
              jornadaFolgaMap.set(jId, dow === 0 || dow === 6);
            } else {
              jornadaFolgaMap.set(jId, (horario as { folga: boolean }).folga === true);
            }
          }
        }

        // ---------- Verificar feriados ----------
        const feriadosResult = await query(
          `SELECT data::text AS data, recorrente
           FROM bluepoint.bt_feriados
           WHERE (recorrente = false AND data = $1::date)
              OR recorrente = true`,
          [hoje]
        );

        const mmdd = hoje.substring(5); // "MM-DD"
        const ehFeriadoHoje = feriadosResult.rows.some((f) => {
          const fTyped = f as { data: string; recorrente: boolean };
          if (fTyped.data === hoje) return true;
          if (fTyped.recorrente && fTyped.data.substring(5) === mmdd) return true;
          return false;
        });

        // ---------- Colaboradores em férias hoje ----------
        const feriasHojeSet = new Set<number>();
        await Promise.all(
          colabIds.map(async (cid) => {
            const dias = await getDiasEmFeriasNoPeriodo(cid, hoje, hoje);
            if (dias.has(hoje)) feriasHojeSet.add(cid);
          })
        );

        // ---------- Classificar cada colaborador ----------
        const colaboradores: Array<{
          id: number;
          nome: string;
          cpf: string;
          foto: string | null;
          cargo: { id: number; nome: string } | null;
          departamento: { id: number; nome: string } | null;
          empresa: { id: number; nome: string } | null;
          status: string;
          chegouAtrasado: boolean;
          primeiraEntrada: string | null;
          ultimaMarcacao: string | null;
        }> = [];

        const resumo: Record<string, number> = {
          total: colabResult.rows.length,
          trabalhando: 0,
          atrasado: 0,
          ausente: 0,
          almoco: 0,
          saiu: 0,
          folga: 0,
          pendente: 0,
          ferias: 0,
        };

        for (const colab of colabResult.rows) {
          const marcacoes = marcMap.get(colab.id) || [];
          const isFeriasHoje = feriasHojeSet.has(colab.id);

          // Verificar se é dia de folga
          let isFolga = ehFeriadoHoje;
          if (!isFolga && colab.jornada_id) {
            isFolga = jornadaFolgaMap.get(colab.jornada_id) || false;
          } else if (!isFolga && !colab.jornada_id) {
            // Sem jornada: assume folga em sab/dom
            const dow = new Date(hoje + 'T12:00:00').getDay();
            isFolga = dow === 0 || dow === 6;
          }

          // Em férias hoje sem marcação → status "ferias" (não conta como ausente)
          let presenca: ReturnType<typeof classificarPresenca>;
          if (isFeriasHoje && marcacoes.length === 0) {
            presenca = {
              status: 'ferias',
              chegouAtrasado: false,
              primeiraEntrada: null,
              ultimaMarcacao: null,
              ultimoTipo: null,
            };
          } else {
            presenca = classificarPresenca(marcacoes, horaAtual, isFolga);
          }

          // Incrementar contadores
          resumo[presenca.status]++;

          colaboradores.push({
            id: colab.id,
            nome: colab.nome,
            cpf: colab.cpf,
            foto: colab.foto_url,
            cargo: colab.cargo_id
              ? { id: colab.cargo_id, nome: colab.cargo_nome }
              : null,
            departamento: colab.departamento_id
              ? { id: colab.departamento_id, nome: colab.departamento_nome }
              : null,
            empresa: colab.empresa_id
              ? { id: colab.empresa_id, nome: colab.empresa_nome }
              : null,
            status: presenca.status,
            chegouAtrasado: presenca.chegouAtrasado,
            primeiraEntrada: presenca.primeiraEntrada,
            ultimaMarcacao: presenca.ultimaMarcacao,
          });
        }

        return {
          resumo,
          colaboradores,
          horaConsulta: horaAtual,
          dataConsulta: hoje,
        };

      }, CACHE_TTL.SHORT); // Cache curto (60s) por ser dados em tempo real

      return successResponse(resultado);
    } catch (error) {
      console.error('Erro ao buscar painel de presença:', error);
      return serverErrorResponse('Erro ao buscar painel de presença');
    }
  });
}
