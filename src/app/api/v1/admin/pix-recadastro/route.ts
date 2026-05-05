import { NextRequest } from 'next/server';
import { withAdmin } from '@/lib/middleware';
import {
  successResponse,
  errorResponse,
  serverErrorResponse,
} from '@/lib/api-response';
import {
  listarBeneficiariosPorChave,
  excluirBeneficiarioPix,
  cadastrarBeneficiarioPix,
  PIX_CNPJ_DEFAULT,
} from '@/lib/pix-pagamentos';
import { z } from 'zod';

const bodySchema = z.object({
  chavePix: z.string().min(3),
  tipoChave: z.string().min(2),
  nomeBeneficiario: z.string().min(1).max(200),
  documentoBeneficiario: z.string().regex(/^\d{11}$|^\d{14}$/, 'CPF (11) ou CNPJ (14) só dígitos'),
  cnpjPagador: z.string().regex(/^\d{14}$/).optional(),
  valorMaximoCentavos: z.number().int().nonnegative().default(0),
});

// POST /api/v1/admin/pix-recadastro
//
// Body: { chavePix, tipoChave, nomeBeneficiario, documentoBeneficiario, cnpjPagador?, valorMaximoCentavos? }
//
// Lista beneficiários atuais pela chave, deleta cada um, recadastra com
// dados novos. Útil quando o registro antigo está com nome/CPF errado e
// o cadastro retorna 409 conflito sem atualizar.

export async function POST(request: NextRequest) {
  return withAdmin(request, async () => {
    try {
      const body = await request.json().catch(() => null);
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(`body inválido: ${parsed.error.issues.map(i => i.message).join('; ')}`, 400);
      }
      const { chavePix, tipoChave, nomeBeneficiario, documentoBeneficiario, cnpjPagador, valorMaximoCentavos } = parsed.data;
      const cnpj = cnpjPagador ?? PIX_CNPJ_DEFAULT;

      const lista = await listarBeneficiariosPorChave(chavePix, tipoChave);
      console.log(`[admin/pix-recadastro] lista chave=${chavePix} tipo=${tipoChave} ok=${lista.ok}` +
        (lista.ok ? ` count=${lista.data.length} data=${JSON.stringify(lista.data)}` : ` erro=${lista.erro} status=${lista.status ?? 'n/d'}`));

      const deletados: Array<{ id: unknown; ok: boolean; erro?: string; status?: number }> = [];
      if (lista.ok) {
        for (const benef of lista.data) {
          const id = benef.id ?? benef.uuid ?? benef.beneficiarioId ?? benef.identifier;
          if (id === undefined || id === null) {
            deletados.push({ id: null, ok: false, erro: 'id ausente no payload' });
            continue;
          }
          const del = await excluirBeneficiarioPix(id as string | number);
          if (del.ok) {
            console.log(`[admin/pix-recadastro] delete id=${id} ok=true`);
            deletados.push({ id, ok: true });
          } else {
            console.log(`[admin/pix-recadastro] delete id=${id} ok=false erro=${del.erro} status=${del.status ?? 'n/d'}`);
            deletados.push({ id, ok: false, erro: del.erro, status: del.status });
          }
        }
      }

      const cad = await cadastrarBeneficiarioPix({
        chavePix,
        tipoChave,
        nomeBeneficiario,
        documentoBeneficiario,
        cnpj,
        valorMaximoCentavos,
      });
      console.log(`[admin/pix-recadastro] cadastro ok=${cad.ok}` +
        (cad.ok ? ` data=${JSON.stringify(cad.data)}` : ` erro=${cad.erro} status=${cad.status ?? 'n/d'}`));

      return successResponse({
        listagem: lista.ok ? { count: lista.data.length, items: lista.data } : { erro: lista.erro, status: lista.status },
        deletados,
        cadastro: cad.ok ? { ok: true, data: cad.data } : { ok: false, erro: cad.erro, status: cad.status },
      });
    } catch (error) {
      console.error('[admin/pix-recadastro] erro:', error);
      return serverErrorResponse('Erro ao recadastrar beneficiário PIX');
    }
  });
}
