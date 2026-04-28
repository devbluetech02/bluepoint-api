import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryRecrutamento } from '@/lib/db';
import { withGestor } from '@/lib/middleware';
import { errorResponse, serverErrorResponse } from '@/lib/api-response';
import {
  escolherTemplate,
  fetchDadosCargo,
  fetchDadosEmpresa,
  montarVariaveis,
  type CandidatoSnapshot,
} from '@/lib/recrutamento-dia-teste';

// POST /api/v1/recrutamento/dia-teste/preview
//
// Gera o PDF de preview do contrato de dia de teste com as variáveis
// preenchidas a partir do candidato + cargo + empresa + parâmetros do
// dia. Não cria nada no banco — só monta o body e proxa pra
// /api/v1/integration/documents/preview do SignProof, que devolve o
// PDF.

const schema = z.object({
  candidatoRecrutamentoId: z.number().int().positive(),
  candidatoCpf: z.string().min(11),
  empresaId: z.number().int().positive(),
  cargoId: z.number().int().positive(),
  diasQtd: z.number().int().min(1).max(2),
  valorDiaria: z.number().min(0).max(10000),
  cargaHoraria: z.number().int().min(1).max(12),
  dataPrimeiroDia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  templateOverride: z.string().min(1).max(120).optional().nullable(),
  rg: z.string().max(50).optional().nullable(),
  banco: z.string().max(100).optional().nullable(),
  chavePix: z.string().max(150).optional().nullable(),
});

export async function POST(request: NextRequest) {
  return withGestor(request, async (req) => {
    try {
      const body = await req.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(parsed.error.issues[0].message, 400);
      }
      const dados = parsed.data;
      const cpfNorm = dados.candidatoCpf.replace(/\D/g, '');

      const detRes = await queryRecrutamento<{
        nome: string | null;
        telefone: string | null;
        rg_candidato: string | null;
        cep: string | null;
        logradouro: string | null;
        bairro: string | null;
        cidade: string | null;
        uf: string | null;
        banco: string | null;
        chave_pix: string | null;
      }>(
        `SELECT nome, telefone, rg_candidato, cep, logradouro, bairro,
                cidade, uf, banco, chave_pix
           FROM public.candidatos
          WHERE id = $1
          LIMIT 1`,
        [dados.candidatoRecrutamentoId]
      );
      const det = detRes.rows[0];
      if (!det) return errorResponse('Candidato não encontrado', 404);

      const cargo = await fetchDadosCargo(dados.cargoId);
      if (!cargo) return errorResponse(`Cargo não encontrado: ${dados.cargoId}`, 400);
      // Contratos de dia de teste sempre no nome da Ethos (ID 11).
      const EMPRESA_CONTRATO_DIA_TESTE = 11;
      const empresa = await fetchDadosEmpresa(EMPRESA_CONTRATO_DIA_TESTE);
      if (!empresa) return errorResponse(`Empresa do contrato (Ethos) não encontrada`, 500);

      const candidatoSnap: CandidatoSnapshot = {
        nome: (det.nome ?? '').trim(),
        cpf: cpfNorm,
        rg: dados.rg ?? det.rg_candidato ?? null,
        endereco: {
          cep: det.cep,
          logradouro: det.logradouro,
          bairro: det.bairro,
          cidade: det.cidade,
          uf: det.uf,
        },
        telefone: (det.telefone ?? '').replace(/\D/g, '') || null,
        banco: dados.banco ?? det.banco ?? null,
        chavePix: dados.chavePix ?? det.chave_pix ?? null,
      };

      const templateId = (dados.templateOverride && dados.templateOverride.trim() !== '')
        ? dados.templateOverride.trim()
        : escolherTemplate(cargo);

      const variaveis = montarVariaveis(templateId, {
        candidato: candidatoSnap,
        cargo,
        empresa,
        dt: {
          diasQtd: dados.diasQtd,
          valorDiaria: dados.valorDiaria,
          cargaHoraria: dados.cargaHoraria,
          dataPrimeiroDia: dados.dataPrimeiroDia,
        },
      });

      const baseUrl = process.env.SIGNPROOF_API_URL;
      const apiKey = process.env.SIGNPROOF_API_KEY;
      if (!baseUrl || !apiKey) {
        return serverErrorResponse('SIGNPROOF_API_URL/KEY não configurado');
      }

      const previewBody = {
        template_id: templateId,
        title: `Preview Dia de Teste — ${candidatoSnap.nome.split(' ')[0]}`,
        variables: variaveis,
      };

      const resp = await fetch(`${baseUrl}/api/v1/integration/documents/preview`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(previewBody),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.error('[recrutamento/dia-teste/preview] SignProof falhou', resp.status, errBody.slice(0, 500));
        return errorResponse(`SignProof devolveu ${resp.status}: ${errBody.slice(0, 300)}`, 502);
      }

      const buffer = await resp.arrayBuffer();
      const headers = new Headers();
      headers.set('Content-Type', resp.headers.get('Content-Type') ?? 'application/pdf');
      // Devolve metadados como header pra o front mostrar qual template foi usado
      headers.set('X-Template-Id', templateId);
      return new NextResponse(buffer, { status: 200, headers });
    } catch (error) {
      console.error('[recrutamento/dia-teste/preview] erro:', error);
      return serverErrorResponse('Erro ao gerar preview do contrato');
    }
  });
}
