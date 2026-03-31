import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { successResponse, notFoundResponse, serverErrorResponse, validationErrorResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/middleware';
import { z } from 'zod';

const CODIGOS_ECONTADOR_VALIDOS = new Set([
  '001', '002', '003', '004', '005', '006', '007', '008', '009', '010',
  '011', '012', '013', '014', '015', '016', '017', '018', '019', '020',
  '021', '022', '023', '024', '025', '026', '027', '028', '029', '030',
  '031', '032', '033', '034', '035', '036', '037', '038', '039', '040',
  '041', '042', '043', '044', '045', '046', '047', '048', '049', '050',
  '051', '052', '053', '054', '055', '056', '057', '058', '059', '060',
  '061', '062', '063', '064', '065', '066', '067', '068', '069', '070',
  '071', '072', '073', '074', '075', '076', '077', '078', '079', '080',
  '081', '082', '083', '084', '085', '086', '087', '088', '089', '090',
  '091', '092', '093', '094', '095', '096', '097', '098', '099', '100',
  '627', '628', '629', '630',
]);

const validarCodigosSchema = z.object({
  modeloId: z.number().int().positive('modeloId é obrigatório'),
});

export async function POST(request: NextRequest) {
  return withAuth(request, async (req) => {
    try {
      const body = await req.json();

      const validation = validarCodigosSchema.safeParse(body);
      if (!validation.success) {
        const errors: Record<string, string[]> = {};
        validation.error.issues.forEach(issue => {
          const path = issue.path.join('.') || 'geral';
          if (!errors[path]) errors[path] = [];
          errors[path].push(issue.message);
        });
        return validationErrorResponse(errors);
      }

      const { modeloId } = validation.data;

      const modeloResult = await query(
        `SELECT id FROM people.modelos_exportacao WHERE id = $1`,
        [modeloId]
      );

      if (modeloResult.rows.length === 0) {
        return notFoundResponse('Modelo de exportação não encontrado');
      }

      const codigosResult = await query(
        `SELECT id, codigo, descricao, status_arquivo, status_econtador
         FROM people.codigos_exportacao
         WHERE modelo_id = $1
         ORDER BY id`,
        [modeloId]
      );

      const detalhes: Array<{
        codigoId: number;
        codigo: string;
        descricao: string;
        statusArquivo: string;
        statusEContador: string;
        motivoInvalido: string | null;
      }> = [];

      let validosArquivo = 0;
      let invalidosArquivo = 0;
      let validosEContador = 0;
      let invalidosEContador = 0;

      const updatePromises: Promise<unknown>[] = [];

      for (const row of codigosResult.rows) {
        const codigoStr = row.codigo.toString().padStart(3, '0');
        const isValidoArquivo = /^\d{1,5}$/.test(row.codigo);
        const isValidoEContador = CODIGOS_ECONTADOR_VALIDOS.has(codigoStr);

        const statusArquivo = isValidoArquivo ? 'valido' : 'invalido';
        const statusEContador = isValidoEContador ? 'valido' : 'invalido';

        if (isValidoArquivo) validosArquivo++;
        else invalidosArquivo++;

        if (isValidoEContador) validosEContador++;
        else invalidosEContador++;

        if (statusArquivo !== row.status_arquivo || statusEContador !== row.status_econtador) {
          updatePromises.push(
            query(
              `UPDATE people.codigos_exportacao
               SET status_arquivo = $1, status_econtador = $2, atualizado_em = NOW()
               WHERE id = $3`,
              [statusArquivo, statusEContador, row.id]
            )
          );
        }

        if (!isValidoArquivo || !isValidoEContador) {
          let motivoInvalido: string | null = null;
          if (!isValidoArquivo) {
            motivoInvalido = 'Código deve conter apenas dígitos (máx. 5 caracteres)';
          } else if (!isValidoEContador) {
            motivoInvalido = 'Código não reconhecido pelo eContador';
          }

          detalhes.push({
            codigoId: row.id,
            codigo: row.codigo,
            descricao: row.descricao,
            statusArquivo,
            statusEContador,
            motivoInvalido,
          });
        }
      }

      await Promise.all(updatePromises);

      return successResponse({
        totalCodigos: codigosResult.rows.length,
        validosArquivo,
        invalidosArquivo,
        validosEContador,
        invalidosEContador,
        detalhes,
      });
    } catch (error) {
      console.error('Erro ao validar códigos de exportação:', error);
      return serverErrorResponse('Erro ao validar códigos de exportação');
    }
  });
}
