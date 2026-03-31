import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { registrarAuditoria, getClientIp, getUserAgent } from '@/lib/audit';
import { cleanCPF, isValidCPF } from '@/lib/utils';
import { detectarTipoPorCargo } from '@/lib/cargo-tipo';
import { invalidateColaboradorCache, cacheDelPattern, CACHE_KEYS } from '@/lib/cache';

interface Params {
  params: Promise<{ id: string }>;
}

// Mapeamento de campos do body para campos do banco
const campoMap: Record<string, string> = {
  nome: 'nome',
  email: 'email',
  cpf: 'cpf',
  rg: 'rg',
  telefone: 'telefone',
  cargoId: 'cargo_id',
  departamentoId: 'departamento_id',
  jornadaId: 'jornada_id',
  dataAdmissao: 'data_admissao',
  dataNascimento: 'data_nascimento',
  status: 'status',
  valeAlimentacao: 'vale_alimentacao',
  valeTransporte: 'vale_transporte',
};

export async function PATCH(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const body = await req.json();

      // Verificar se colaborador existe
      const atualResult = await query(
        `SELECT * FROM people.colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (atualResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const dadosAnteriores = atualResult.rows[0];

      // Validações específicas
      if (body.cpf) {
        if (!isValidCPF(body.cpf)) {
          return errorResponse('CPF inválido', 400);
        }
        body.cpf = cleanCPF(body.cpf);

        const cpfExiste = await query(
          `SELECT id FROM people.colaboradores WHERE cpf = $1 AND id != $2`,
          [body.cpf, colaboradorId]
        );
        if (cpfExiste.rows.length > 0) {
          return errorResponse('CPF já cadastrado em outro colaborador', 400);
        }
      }

      if (body.email) {
        const emailExiste = await query(
          `SELECT id FROM people.colaboradores WHERE email = $1 AND id != $2`,
          [body.email, colaboradorId]
        );
        if (emailExiste.rows.length > 0) {
          return errorResponse('Email já cadastrado em outro colaborador', 400);
        }
      }

      // Construir query de atualização dinamicamente
      const updates: string[] = [];
      const values: unknown[] = [];
      const camposAtualizados: string[] = [];
      let paramIndex = 1;

      for (const [campo, valor] of Object.entries(body)) {
        const dbCampo = campoMap[campo];
        if (dbCampo && valor !== undefined) {
          updates.push(`${dbCampo} = $${paramIndex}`);
          values.push(valor);
          camposAtualizados.push(campo);
          paramIndex++;
        }
      }

      // Tratar campos de endereço
      if (body.endereco) {
        const enderecoFields: Record<string, string> = {
          cep: 'endereco_cep',
          logradouro: 'endereco_logradouro',
          numero: 'endereco_numero',
          complemento: 'endereco_complemento',
          bairro: 'endereco_bairro',
          cidade: 'endereco_cidade',
          estado: 'endereco_estado',
        };

        for (const [campo, valor] of Object.entries(body.endereco)) {
          const dbCampo = enderecoFields[campo];
          if (dbCampo && valor !== undefined) {
            updates.push(`${dbCampo} = $${paramIndex}`);
            values.push(valor);
            camposAtualizados.push(`endereco.${campo}`);
            paramIndex++;
          }
        }
      }

      // Tipo de acesso: se admin enviou "tipo" explícito, usa direto
      const TIPOS_VALIDOS = ['colaborador', 'gestor', 'gerente', 'supervisor', 'coordenador', 'admin'];

      if (body.tipo !== undefined && user.tipo === 'admin') {
        if (!TIPOS_VALIDOS.includes(body.tipo)) {
          return errorResponse(`Tipo inválido. Use: ${TIPOS_VALIDOS.join(', ')}`, 400);
        }
        updates.push(`tipo = $${paramIndex}`);
        values.push(body.tipo);
        camposAtualizados.push('tipo');
        paramIndex++;
      } else if (body.cargoId !== undefined) {
        const cargoResult = await query(
          `SELECT nome FROM people.cargos WHERE id = $1`,
          [body.cargoId]
        );
        if (cargoResult.rows.length > 0) {
          const novoTipo = detectarTipoPorCargo(cargoResult.rows[0].nome);
          updates.push(`tipo = $${paramIndex}`);
          values.push(novoTipo);
          camposAtualizados.push('tipo');
          paramIndex++;
        }
      }

      if (updates.length === 0) {
        return errorResponse('Nenhum campo para atualizar', 400);
      }

      updates.push('atualizado_em = NOW()');
      values.push(colaboradorId);

      await query(
        `UPDATE people.colaboradores SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        values
      );

      // Invalidar cache do colaborador e permissões (tipo pode ter mudado)
      await invalidateColaboradorCache(colaboradorId);
      if (body.cargoId !== undefined || body.tipo !== undefined) {
        await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}*`);
      }

      // Registrar auditoria
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: 'editar',
        modulo: 'colaboradores',
        descricao: `Colaborador atualizado parcialmente: ${dadosAnteriores.nome}`,
        ip: getClientIp(request),
        userAgent: getUserAgent(request),
        dadosAnteriores: { id: colaboradorId },
        dadosNovos: { id: colaboradorId, ...body },
      });

      return successResponse({
        id: colaboradorId,
        camposAtualizados,
        mensagem: 'Colaborador atualizado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar colaborador:', error);
      return serverErrorResponse('Erro ao atualizar colaborador');
    }
  });
}
