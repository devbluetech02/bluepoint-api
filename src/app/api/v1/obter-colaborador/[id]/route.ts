import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async () => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const colaborador = await cacheAside(`${CACHE_KEYS.COLABORADOR}${colaboradorId}`, async () => {
        const result = await query(
        `SELECT 
          c.*,
          cg.id as cargo_id,
          cg.nome as cargo_nome,
          d.id as departamento_id,
          d.nome as departamento_nome,
          j.id as jornada_id,
          j.nome as jornada_nome,
          e.nome_fantasia as empresa_nome_fantasia,
          e.cnpj as empresa_cnpj,
          e.estado as empresa_estado,
          e.cidade as empresa_cidade
        FROM bluepoint.bt_colaboradores c
        LEFT JOIN bluepoint.bt_cargos cg ON c.cargo_id = cg.id
        LEFT JOIN bluepoint.bt_departamentos d ON c.departamento_id = d.id
        LEFT JOIN bluepoint.bt_jornadas j ON c.jornada_id = j.id
        LEFT JOIN bluepoint.bt_empresas e ON c.empresa_id = e.id
        WHERE c.id = $1`,
        [colaboradorId]
      );

        if (result.rows.length === 0) {
          return null;
        }

        const row = result.rows[0];

        // Buscar documentos
        const docsResult = await query(
          `SELECT id, tipo, nome, url, data_upload
           FROM bt_documentos_colaborador
           WHERE colaborador_id = $1
           ORDER BY data_upload DESC`,
          [colaboradorId]
        );

        return {
          id: row.id,
          nome: row.nome,
          email: row.email,
          cpf: row.cpf,
          rg: row.rg,
          telefone: row.telefone,
          pis: row.pis,
          externalId: row.external_id,
          tipo: row.tipo,
          categoria: row.categoria,
          observacao: row.observacao,
          endereco: {
            cep: row.endereco_cep,
            logradouro: row.endereco_logradouro,
            numero: row.endereco_numero,
            complemento: row.endereco_complemento,
            bairro: row.endereco_bairro,
            cidade: row.endereco_cidade,
            estado: row.endereco_estado,
          },
          empresa: row.empresa_id ? {
            id: row.empresa_id,
            nomeFantasia: row.empresa_nome_fantasia,
            cnpj: row.empresa_cnpj,
            estado: row.empresa_estado,
            cidade: row.empresa_cidade,
          } : null,
          departamento: row.departamento_id ? { id: row.departamento_id, nome: row.departamento_nome } : null,
          jornada: row.jornada_id ? { id: row.jornada_id, nome: row.jornada_nome } : null,
          cargo: row.cargo_id ? { id: row.cargo_id, nome: row.cargo_nome } : null,
          dataAdmissao: row.data_admissao,
          dataNascimento: row.data_nascimento,
          dataDesligamento: row.data_desligamento,
          status: row.status,
          foto: row.foto_url,
          faceRegistrada: row.face_registrada,
          permitePontoMobile: row.permite_ponto_mobile,
          permitePontoQualquerEmpresa: row.permite_ponto_qualquer_empresa,
          valeAlimentacao: row.vale_alimentacao === true,
          valeTransporte: row.vale_transporte === true,
          criadoEm: row.criado_em,
          atualizadoEm: row.atualizado_em,
          documentos: docsResult.rows.map(doc => ({
            id: doc.id,
            tipo: doc.tipo,
            nome: doc.nome,
            url: doc.url,
            dataUpload: doc.data_upload,
          })),
        };
      }, CACHE_TTL.SHORT);

      if (!colaborador) {
        return notFoundResponse('Colaborador não encontrado');
      }

      return successResponse(colaborador);
    } catch (error) {
      console.error('Erro ao obter colaborador:', error);
      return serverErrorResponse('Erro ao obter colaborador');
    }
  });
}
