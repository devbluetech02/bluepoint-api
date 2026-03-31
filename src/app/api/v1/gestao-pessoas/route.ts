import { NextRequest, NextResponse } from 'next/server';
import { query, getClient } from '@/lib/db';
import {
  successResponse,
  errorResponse,
  createdResponse,
  serverErrorResponse,
  getPaginationParams,
  buildPaginatedResponse,
} from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { cacheAside, buildListCacheKey, CACHE_KEYS, CACHE_TTL, invalidateGestaoPessoasCache } from '@/lib/cache';
import { getMinioClient, getBucketName, gerarUrlPublica } from '@/lib/storage';
import {
  EXTENSOES_PERMITIDAS,
  MAX_FILE_SIZE,
  detectarTipoAnexo,
  formatRegistro,
  fetchAnexosPorRegistros,
  fetchReunioesComParticipantes,
} from '@/lib/gestao-pessoas';

// =====================================================
// GET  /api/v1/gestao-pessoas
// =====================================================

export async function GET(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const { searchParams } = new URL(req.url);
      const { pagina, limite, offset } = getPaginationParams(searchParams);

      const busca = searchParams.get('busca');
      const tipo = searchParams.get('tipo');
      const status = searchParams.get('status');
      const departamento = searchParams.get('departamento');

      const cacheKey = buildListCacheKey(CACHE_KEYS.GESTAO_PESSOAS, {
        pagina, limite, busca, tipo, status, departamento,
      });

      const resultado = await cacheAside(cacheKey, async () => {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (busca) {
          conditions.push(`(c.nome ILIKE $${idx} OR gp.titulo ILIKE $${idx} OR gp.descricao ILIKE $${idx})`);
          params.push(`%${busca}%`);
          idx++;
        }
        if (tipo) {
          conditions.push(`gp.tipo = $${idx}`);
          params.push(tipo);
          idx++;
        }
        if (status) {
          conditions.push(`gp.status = $${idx}`);
          params.push(status);
          idx++;
        }
        if (departamento) {
          conditions.push(`d.nome ILIKE $${idx}`);
          params.push(`%${departamento}%`);
          idx++;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const countResult = await query(
          `SELECT COUNT(*) AS total
           FROM people.gestao_pessoas gp
           JOIN people.colaboradores c ON gp.colaborador_id = c.id
           LEFT JOIN people.departamentos d ON c.departamento_id = d.id
           ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total);

        const dataParams = [...params, limite, offset];
        const result = await query(
          `SELECT
             gp.id, gp.colaborador_id, gp.tipo, gp.status,
             gp.titulo, gp.descricao, gp.data_registro, gp.data_conclusao,
             c.nome AS colaborador_nome,
             cg.nome AS colaborador_cargo,
             d.nome AS colaborador_departamento,
             r.nome AS responsavel_nome
           FROM people.gestao_pessoas gp
           JOIN people.colaboradores c ON gp.colaborador_id = c.id
           LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
           LEFT JOIN people.departamentos d ON c.departamento_id = d.id
           JOIN people.colaboradores r ON gp.responsavel_id = r.id
           ${whereClause}
           ORDER BY gp.data_registro DESC, gp.id DESC
           LIMIT $${idx} OFFSET $${idx + 1}`,
          dataParams
        );

        const registroIds = result.rows.map(r => (r as { id: number }).id);
        const [anexosMap, reunioesMap] = await Promise.all([
          fetchAnexosPorRegistros(registroIds),
          fetchReunioesComParticipantes(registroIds),
        ]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dados = result.rows.map((row: any) =>
          formatRegistro(row, anexosMap.get(row.id) || [], reunioesMap.get(row.id) || null)
        );

        const resumoResult = await query(
          `SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE gp.status = 'pendente') AS pendentes,
             COUNT(*) FILTER (WHERE gp.tipo = 'advertencia') AS advertencias,
             COUNT(*) FILTER (WHERE gp.tipo IN ('feedback_positivo','feedback_negativo')) AS feedbacks,
             (SELECT COUNT(*) FROM people.gestao_pessoas_reunioes WHERE status = 'agendada') AS reunioes_agendadas
           FROM people.gestao_pessoas gp`
        );
        const sr = resumoResult.rows[0];
        const resumo = {
          total: parseInt(sr.total),
          pendentes: parseInt(sr.pendentes),
          advertencias: parseInt(sr.advertencias),
          feedbacks: parseInt(sr.feedbacks),
          reunioesAgendadas: parseInt(sr.reunioes_agendadas),
        };

        return { dados, total, pagina, limite, resumo };
      }, CACHE_TTL.SHORT);

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'visualizar',
        modulo: 'gestao_pessoas',
        descricao: 'Listagem de registros de gestão de pessoas',
      }));

      const paginatedResponse = buildPaginatedResponse(resultado.dados, resultado.total, resultado.pagina, resultado.limite);
      return NextResponse.json({ ...paginatedResponse, resumo: resultado.resumo });
    } catch (error) {
      console.error('Erro ao listar registros de gestão de pessoas:', error);
      return serverErrorResponse('Erro ao listar registros de gestão de pessoas');
    }
  });
}

// =====================================================
// POST /api/v1/gestao-pessoas  (multipart/form-data)
// =====================================================

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    const client = await getClient();
    try {
      const formData = await req.formData();

      const colaboradorId = parseInt(formData.get('colaboradorId') as string);
      const tipo = formData.get('tipo') as string;
      const titulo = (formData.get('titulo') as string || '').trim();
      const descricao = (formData.get('descricao') as string || '').trim();
      const reuniaoData = formData.get('reuniaoData') as string;
      const reuniaoHora = formData.get('reuniaoHora') as string;
      const participantesIdsRaw = formData.get('participantesIds') as string;
      const anexos = formData.getAll('anexos') as File[];

      if (!colaboradorId || isNaN(colaboradorId)) {
        return errorResponse('colaboradorId é obrigatório', 400);
      }
      const tiposValidos = ['advertencia', 'demissao', 'feedback_positivo', 'feedback_negativo'];
      if (!tipo || !tiposValidos.includes(tipo)) {
        return errorResponse(`tipo deve ser: ${tiposValidos.join(', ')}`, 400);
      }
      if (!titulo || titulo.length < 3) {
        return errorResponse('titulo é obrigatório (mín. 3 caracteres)', 400);
      }
      if (!descricao || descricao.length < 3) {
        return errorResponse('descricao é obrigatória (mín. 3 caracteres)', 400);
      }
      if (!reuniaoData || isNaN(Date.parse(reuniaoData))) {
        return errorResponse('reuniaoData é obrigatória (YYYY-MM-DD)', 400);
      }
      if (!reuniaoHora || !/^\d{2}:\d{2}$/.test(reuniaoHora)) {
        return errorResponse('reuniaoHora é obrigatória (HH:mm)', 400);
      }

      let participantesIds: number[];
      try {
        participantesIds = JSON.parse(participantesIdsRaw);
        if (!Array.isArray(participantesIds) || participantesIds.length === 0) throw new Error();
        participantesIds = participantesIds.map(Number).filter(n => !isNaN(n) && n > 0);
        if (participantesIds.length === 0) throw new Error();
      } catch {
        return errorResponse('participantesIds deve ser um JSON array com pelo menos 1 ID', 400);
      }

      const colabResult = await query(
        `SELECT c.id, c.nome, cg.nome AS cargo, d.nome AS departamento
         FROM people.colaboradores c
         LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
         LEFT JOIN people.departamentos d ON c.departamento_id = d.id
         WHERE c.id = $1`,
        [colaboradorId]
      );
      if (colabResult.rows.length === 0) {
        return errorResponse('Colaborador não encontrado', 404);
      }

      for (const anexo of anexos) {
        if (anexo.size > MAX_FILE_SIZE) {
          return errorResponse(`Arquivo "${anexo.name}" excede o limite de 50 MB`, 400);
        }
        const ext = (anexo.name.split('.').pop() || '').toLowerCase();
        if (!EXTENSOES_PERMITIDAS.has(ext)) {
          return errorResponse(`Extensão ".${ext}" não permitida`, 400);
        }
      }

      await client.query('BEGIN');

      const gpResult = await client.query(
        `INSERT INTO people.gestao_pessoas
           (colaborador_id, tipo, titulo, descricao, responsavel_id, data_registro)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
         RETURNING id, data_registro`,
        [colaboradorId, tipo, titulo, descricao, user.userId]
      );
      const gpId = gpResult.rows[0].id;

      const reuniaoResult = await client.query(
        `INSERT INTO people.gestao_pessoas_reunioes
           (gestao_pessoa_id, data, hora)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [gpId, reuniaoData, reuniaoHora]
      );
      const reuniaoId = reuniaoResult.rows[0].id;

      for (const pId of participantesIds) {
        await client.query(
          `INSERT INTO people.gestao_pessoas_participantes (reuniao_id, colaborador_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [reuniaoId, pId]
        );
      }

      const minioClient = getMinioClient();
      const bucket = getBucketName();
      const bucketExists = await minioClient.bucketExists(bucket);
      if (!bucketExists) await minioClient.makeBucket(bucket);

      const anexosInseridos: { id: number; nome: string; tipo: string; tamanho: number; url: string; criado_em: string }[] = [];

      for (const anexo of anexos) {
        const ext = (anexo.name.split('.').pop() || 'bin').toLowerCase();
        const tipoAnexo = detectarTipoAnexo(ext);
        const storagePath = `gestao-pessoas/${gpId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const buffer = Buffer.from(await anexo.arrayBuffer());

        await minioClient.putObject(bucket, storagePath, buffer, buffer.length, {
          'Content-Type': anexo.type,
        });

        const url = gerarUrlPublica(storagePath);
        const anexoResult = await client.query(
          `INSERT INTO people.gestao_pessoas_anexos
             (gestao_pessoa_id, nome, tipo, tamanho, url, caminho_storage)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, nome, tipo, tamanho, url, criado_em`,
          [gpId, anexo.name, tipoAnexo, anexo.size, url, storagePath]
        );
        anexosInseridos.push(anexoResult.rows[0]);
      }

      await client.query('COMMIT');

      await invalidateGestaoPessoasCache();

      const [anexosMap, reunioesMap] = await Promise.all([
        fetchAnexosPorRegistros([gpId]),
        fetchReunioesComParticipantes([gpId]),
      ]);

      const colab = colabResult.rows[0];
      const registro = formatRegistro(
        {
          id: gpId,
          colaborador_id: colaboradorId,
          colaborador_nome: colab.nome,
          colaborador_cargo: colab.cargo,
          colaborador_departamento: colab.departamento,
          tipo,
          status: 'pendente',
          titulo,
          descricao,
          data_registro: gpResult.rows[0].data_registro,
          data_conclusao: null,
          responsavel_nome: user.nome,
        },
        anexosMap.get(gpId) || [],
        reunioesMap.get(gpId) || null,
      );

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'criar',
        modulo: 'gestao_pessoas',
        descricao: `Registro criado: ${titulo} (${tipo}) — colaborador ${colab.nome}`,
        entidadeId: gpId,
        entidadeTipo: 'gestao_pessoas',
        colaboradorId,
        colaboradorNome: colab.nome,
        dadosNovos: { id: gpId, tipo, titulo, colaboradorId },
      }));

      return createdResponse(registro);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Erro ao criar registro de gestão de pessoas:', error);
      return serverErrorResponse('Erro ao criar registro de gestão de pessoas');
    } finally {
      client.release();
    }
  });
}
