import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { atualizarColaboradorSchema, validateBody } from '@/lib/validation';
import { hashPassword } from '@/lib/auth';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { cleanCPF, isValidCPF } from '@/lib/utils';
import { invalidateColaboradorCache, cacheDelPattern, CACHE_KEYS } from '@/lib/cache';
import { detectarTipoPorCargo } from '@/lib/cargo-tipo';

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withGestor(request, async (req, user) => {
    try {
      const { id } = await params;
      const colaboradorId = parseInt(id);

      if (isNaN(colaboradorId)) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const body = await req.json();
      const tipoExplicito: string | undefined = body.tipo;
      
      const validation = validateBody(atualizarColaboradorSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Buscar colaborador atual
      const atualResult = await query(
        `SELECT * FROM bluepoint.bt_colaboradores WHERE id = $1`,
        [colaboradorId]
      );

      if (atualResult.rows.length === 0) {
        return notFoundResponse('Colaborador não encontrado');
      }

      const dadosAnteriores = atualResult.rows[0];

      // Validar CPF se foi alterado
      if (data.cpf) {
        if (!isValidCPF(data.cpf)) {
          return errorResponse('CPF inválido', 400);
        }
        data.cpf = cleanCPF(data.cpf);

        // Verificar se CPF já existe em outro colaborador
        const cpfExiste = await query(
          `SELECT id FROM bluepoint.bt_colaboradores WHERE cpf = $1 AND id != $2`,
          [data.cpf, colaboradorId]
        );
        if (cpfExiste.rows.length > 0) {
          return errorResponse('CPF já cadastrado em outro colaborador', 400);
        }
      }

      // Verificar se email já existe em outro colaborador
      if (data.email) {
        const emailExiste = await query(
          `SELECT id FROM bluepoint.bt_colaboradores WHERE email = $1 AND id != $2`,
          [data.email, colaboradorId]
        );
        if (emailExiste.rows.length > 0) {
          return errorResponse('Email já cadastrado em outro colaborador', 400);
        }
      }

      // Construir campos para atualização
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      const fieldsMap: Record<string, string> = {
        nome: 'nome',
        email: 'email',
        cpf: 'cpf',
        rg: 'rg',
        telefone: 'telefone',
        pis: 'pis',
        categoria: 'categoria',
        observacao: 'observacao',
        cargoId: 'cargo_id',
        empresaId: 'empresa_id',
        departamentoId: 'departamento_id',
        jornadaId: 'jornada_id',
        dataAdmissao: 'data_admissao',
        dataNascimento: 'data_nascimento',
        dataDesligamento: 'data_desligamento',
        permitePontoMobile: 'permite_ponto_mobile',
        permitePontoQualquerEmpresa: 'permite_ponto_qualquer_empresa',
        valeAlimentacao: 'vale_alimentacao',
        valeTransporte: 'vale_transporte',
        status: 'status',
      };

      // Mapear categoria para valor do ENUM do banco
      const categoriaMap: Record<string, string> = { 'empregado': 'empregado_clt' };

      // Campos simples
      for (const [jsField, dbField] of Object.entries(fieldsMap)) {
        if (data[jsField as keyof typeof data] !== undefined) {
          setClauses.push(`${dbField} = $${paramIndex}`);
          let valor = data[jsField as keyof typeof data];
          // Converter categoria se necessário
          if (jsField === 'categoria' && typeof valor === 'string' && categoriaMap[valor]) {
            valor = categoriaMap[valor];
          }
          values.push(valor);
          paramIndex++;
        }
      }

      // Atualizar senha, se informada (apenas gestores/admins via this endpoint)
      if (data.novaSenha) {
        const senhaHash = await hashPassword(data.novaSenha);
        setClauses.push(`senha_hash = $${paramIndex}`);
        values.push(senhaHash);
        paramIndex++;
      }

      // Campos de endereço
      if (data.endereco) {
        const enderecoFields: Record<string, string> = {
          cep: 'endereco_cep',
          logradouro: 'endereco_logradouro',
          numero: 'endereco_numero',
          complemento: 'endereco_complemento',
          bairro: 'endereco_bairro',
          cidade: 'endereco_cidade',
          estado: 'endereco_estado',
        };
        for (const [jsField, dbField] of Object.entries(enderecoFields)) {
          if (data.endereco[jsField as keyof typeof data.endereco] !== undefined) {
            setClauses.push(`${dbField} = $${paramIndex}`);
            values.push(data.endereco[jsField as keyof typeof data.endereco]);
            paramIndex++;
          }
        }
      }

      // Tipo de acesso: se admin enviou "tipo" explícito, usa direto
      const TIPOS_VALIDOS = ['colaborador', 'gestor', 'gerente', 'supervisor', 'coordenador', 'admin'];

      if (tipoExplicito !== undefined && user.tipo === 'admin') {
        if (!TIPOS_VALIDOS.includes(tipoExplicito)) {
          return errorResponse(`Tipo inválido. Use: ${TIPOS_VALIDOS.join(', ')}`, 400);
        }
        setClauses.push(`tipo = $${paramIndex}`);
        values.push(tipoExplicito);
        paramIndex++;
      } else if (data.cargoId !== undefined) {
        // Sem tipo explícito: recalcular pelo cargo
        const cargoResult = await query(
          `SELECT nome FROM bluepoint.bt_cargos WHERE id = $1`,
          [data.cargoId]
        );
        if (cargoResult.rows.length > 0) {
          const novoTipo = detectarTipoPorCargo(cargoResult.rows[0].nome);
          setClauses.push(`tipo = $${paramIndex}`);
          values.push(novoTipo);
          paramIndex++;
        }
      }

      // Sempre atualiza o timestamp
      setClauses.push('atualizado_em = NOW()');

      // Adiciona o ID como último parâmetro
      values.push(colaboradorId);

      // Atualizar colaborador
      await query(
        `UPDATE bluepoint.bt_colaboradores SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
        values
      );

      // Invalidar cache do colaborador e permissões (tipo pode ter mudado)
      await invalidateColaboradorCache(colaboradorId);
      if (data.cargoId !== undefined || tipoExplicito !== undefined) {
        await cacheDelPattern(`${CACHE_KEYS.PAPEL_PERMISSOES}*`);
      }

      // Registrar auditoria
      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'editar',
        modulo: 'colaboradores',
        descricao: `Colaborador atualizado: ${data.nome || dadosAnteriores.nome}`,
        colaboradorId,
        colaboradorNome: (data.nome || dadosAnteriores.nome) as string,
        entidadeId: colaboradorId,
        entidadeTipo: 'colaborador',
        dadosAnteriores: { id: colaboradorId, ...dadosAnteriores },
        dadosNovos: { id: colaboradorId, ...data },
      }));

      return successResponse({
        id: colaboradorId,
        nome: data.nome || dadosAnteriores.nome,
        mensagem: 'Colaborador atualizado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao atualizar colaborador:', error);
      return serverErrorResponse('Erro ao atualizar colaborador');
    }
  });
}
