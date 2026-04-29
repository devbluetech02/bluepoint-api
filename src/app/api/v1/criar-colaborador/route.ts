import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { createdResponse, errorResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withGestor } from '@/lib/middleware';
import { criarColaboradorSchema, validateBody } from '@/lib/validation';
import { registrarAuditoria, buildAuditParams } from '@/lib/audit';
import { cleanCPF, isValidCPF } from '@/lib/utils';
import { invalidateColaboradorCache } from '@/lib/cache';
import { detectarTipoPorCargo } from '@/lib/cargo-tipo';
import { embedTableRowAfterInsert } from '@/lib/embeddings';

export async function POST(request: NextRequest) {
  return withGestor(request, async (req, user) => {
    try {
      const body = await req.json();
      
      const validation = validateBody(criarColaboradorSchema, body);
      if (!validation.success) {
        return validationErrorResponse(validation.errors);
      }

      const data = validation.data;

      // Validar CPF
      if (!isValidCPF(data.cpf)) {
        return errorResponse('CPF inválido', 400);
      }

      const cpfLimpo = cleanCPF(data.cpf);

      // Verificar se email ou CPF já existe
      const existeResult = await query(
        `SELECT id FROM people.colaboradores WHERE email = $1 OR cpf = $2`,
        [data.email, cpfLimpo]
      );

      if (existeResult.rows.length > 0) {
        return errorResponse('Email ou CPF já cadastrado', 400);
      }

      // Mapear categoria para valor do ENUM do banco
      const categoriaMap: Record<string, string> = { 'empregado': 'empregado_clt' };
      const categoria = data.categoria ? (categoriaMap[data.categoria] || data.categoria) : null;

      // Hash da senha
      const senhaHash = await hashPassword(data.senha);

      // Detectar tipo do usuário baseado no cargo
      let tipoUsuario = 'colaborador';
      if (data.cargoId) {
        const cargoResult = await query(
          `SELECT nome FROM people.cargos WHERE id = $1`,
          [data.cargoId]
        );
        if (cargoResult.rows.length > 0) {
          tipoUsuario = detectarTipoPorCargo(cargoResult.rows[0].nome);
        }
      }

      // Inserir colaborador
      const result = await query(
        `INSERT INTO people.colaboradores (
          nome, email, senha_hash, cpf, rg, rg_orgao_emissor, rg_uf, telefone, pis, categoria, observacao, cargo_id,
          tipo, empresa_id, departamento_id, jornada_id, data_admissao, data_nascimento, data_desligamento,
          endereco_cep, endereco_logradouro, endereco_numero,
          endereco_complemento, endereco_bairro, endereco_cidade, endereco_estado,
          estado_civil, formacao, cor_raca,
          banco_nome, banco_tipo_conta, banco_agencia, banco_conta, pix_tipo, pix_chave,
          contato_emergencia_nome, contato_emergencia_telefone,
          uniforme_tamanho, altura_metros, peso_kg,
          permite_ponto_mobile, permite_ponto_qualquer_empresa,
          vale_alimentacao, vale_transporte, auxilio_combustivel
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19,
          $20, $21, $22, $23, $24, $25, $26,
          $27, $28, $29,
          $30, $31, $32, $33, $34, $35,
          $36, $37,
          $38, $39, $40,
          $41, $42,
          $43, $44, $45
        )
        RETURNING id, nome, email, tipo`,
        [
          data.nome,
          data.email,
          senhaHash,
          cpfLimpo,
          data.rg || null,
          data.rgOrgaoEmissor || null,
          data.rgUf || null,
          data.telefone || null,
          data.pis || null,
          categoria,
          data.observacao || null,
          data.cargoId || null,
          tipoUsuario,
          data.empresaId || null,
          data.departamentoId || null,
          data.jornadaId || null,
          data.dataAdmissao,
          data.dataNascimento || null,
          data.dataDesligamento || null,
          data.endereco?.cep || null,
          data.endereco?.logradouro || null,
          data.endereco?.numero || null,
          data.endereco?.complemento || null,
          data.endereco?.bairro || null,
          data.endereco?.cidade || null,
          data.endereco?.estado || null,
          data.estadoCivil || null,
          data.formacao || null,
          data.corRaca || null,
          data.dadosBancarios?.banco || null,
          data.dadosBancarios?.tipoConta || null,
          data.dadosBancarios?.agencia || null,
          data.dadosBancarios?.conta || null,
          data.dadosBancarios?.pixTipo || null,
          data.dadosBancarios?.pixChave || null,
          data.contatoEmergencia?.nome || null,
          data.contatoEmergencia?.telefone || null,
          data.uniformeTamanho || null,
          data.alturaMetros ?? null,
          data.pesoKg ?? null,
          data.permitePontoMobile ?? false,
          data.permitePontoQualquerEmpresa ?? false,
          data.valeAlimentacao ?? false,
          data.valeTransporte ?? false,
          data.auxilioCombustivel ?? false,
        ]
      );

      const novoColaborador = result.rows[0];

      // Invalidar cache
      await invalidateColaboradorCache();

      // Gerar embedding para busca vetorial
      await embedTableRowAfterInsert('colaboradores', novoColaborador.id);

      // Registrar auditoria
      await registrarAuditoria(buildAuditParams(request, user, {
        acao: 'criar',
        modulo: 'colaboradores',
        descricao: `Colaborador criado: ${novoColaborador.nome}`,
        colaboradorId: novoColaborador.id,
        colaboradorNome: novoColaborador.nome,
        entidadeId: novoColaborador.id,
        entidadeTipo: 'colaborador',
        dadosNovos: { id: novoColaborador.id, nome: data.nome, email: data.email },
      }));

      return createdResponse({
        id: novoColaborador.id,
        nome: novoColaborador.nome,
        email: novoColaborador.email,
        tipo: novoColaborador.tipo,
        mensagem: 'Colaborador criado com sucesso',
      });
    } catch (error) {
      console.error('Erro ao criar colaborador:', error);
      return serverErrorResponse('Erro ao criar colaborador');
    }
  });
}
