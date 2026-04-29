import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { cacheAside, CACHE_KEYS, CACHE_TTL } from '@/lib/cache';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  return withAuth(request, async (req, user) => {
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
        FROM people.colaboradores c
        LEFT JOIN people.cargos cg ON c.cargo_id = cg.id
        LEFT JOIN people.departamentos d ON c.departamento_id = d.id
        LEFT JOIN people.jornadas j ON c.jornada_id = j.id
        LEFT JOIN people.empresas e ON c.empresa_id = e.id
        WHERE c.id = $1`,
        [colaboradorId]
      );

        if (result.rows.length === 0) {
          return null;
        }

        const row = result.rows[0];

        // Buscar documentos
        const docsResult = await query(
          `SELECT id, tipo, tipo_documento_id, nome, url, tamanho, data_upload, data_validade
           FROM people.documentos_colaborador
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
          rgOrgaoEmissor: row.rg_orgao_emissor,
          rgUf: row.rg_uf,
          telefone: row.telefone,
          pis: row.pis,
          externalId: row.external_id,
          tipo: row.tipo,
          categoria: row.categoria,
          observacao: row.observacao,
          estadoCivil: row.estado_civil,
          formacao: row.formacao,
          corRaca: row.cor_raca,
          endereco: {
            cep: row.endereco_cep,
            logradouro: row.endereco_logradouro,
            numero: row.endereco_numero,
            complemento: row.endereco_complemento,
            bairro: row.endereco_bairro,
            cidade: row.endereco_cidade,
            estado: row.endereco_estado,
          },
          dadosBancarios: {
            banco: row.banco_nome,
            tipoConta: row.banco_tipo_conta,
            agencia: row.banco_agencia,
            conta: row.banco_conta,
            pixTipo: row.pix_tipo,
            pixChave: row.pix_chave,
          },
          contatoEmergencia: {
            nome: row.contato_emergencia_nome,
            telefone: row.contato_emergencia_telefone,
          },
          uniformeTamanho: row.uniforme_tamanho,
          alturaMetros: row.altura_metros !== null && row.altura_metros !== undefined ? Number(row.altura_metros) : null,
          pesoKg: row.peso_kg !== null && row.peso_kg !== undefined ? Number(row.peso_kg) : null,
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
          auxilioCombustivel: row.auxilio_combustivel === true,
          criadoEm: row.criado_em,
          atualizadoEm: row.atualizado_em,
          documentos: (() => {
            type DocRow = { id: number; tipo: string; tipo_documento_id: number | null; nome: string; url: string; tamanho: number | null; data_upload: string; data_validade: string | null };
            const hoje = new Date().toISOString().substring(0, 10);
            const hojeDate = new Date(hoje);
            const diasParaVencer = (dataValidade: string | null): number | null => {
              if (dataValidade == null) return null;
              const diffMs = new Date(dataValidade).getTime() - hojeDate.getTime();
              return Math.floor(diffMs / (24 * 60 * 60 * 1000));
            };
            return (docsResult.rows as DocRow[]).map((doc) => ({
              id: doc.id,
              tipo: doc.tipo,
              tipoDocumentoId: doc.tipo_documento_id,
              nome: doc.nome,
              url: doc.url,
              tamanho: doc.tamanho,
              dataUpload: doc.data_upload,
              dataValidade: doc.data_validade,
              vencido: doc.data_validade != null && doc.data_validade < hoje,
              diasParaVencer: diasParaVencer(doc.data_validade),
            }));
          })(),
        };
      }, CACHE_TTL.SHORT);

      if (!colaborador) {
        return notFoundResponse('Colaborador não encontrado');
      }

      await registrarAuditoria(buildAuditParams(req, user, {
        acao: 'visualizar',
        modulo: 'usuarios',
        descricao: 'Visualização de dados do colaborador',
        colaboradorId,
        colaboradorNome: colaborador.nome,
        entidadeId: colaboradorId,
        entidadeTipo: 'colaborador',
      }));

      return successResponse(colaborador);
    } catch (error) {
      console.error('Erro ao obter colaborador:', error);
      return serverErrorResponse('Erro ao obter colaborador');
    }
  });
}
