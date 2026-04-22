import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponse, serverErrorResponse, successResponse } from '@/lib/api-response';
import { fetchFormularioAdmissaoPorToken } from '@/lib/formulario-admissao';
import { uploadArquivo } from '@/lib/storage';
import {
  extractFaceEncoding,
  encodingToBuffer,
  calcularThresholdDinamico,
} from '@/lib/face-recognition';

// Mesma qualidade mínima usada em biometria/cadastrar-face para cadastro principal
const QUALIDADE_MINIMA = 0.4;
// Qualidade mínima para encodings extras (mesmo valor de cadastrar-face com adicional=true)
const QUALIDADE_MINIMA_EXTRA = 0.25;
// Máximo de encodings extras (biometria_facial limita a 1 principal + 5 extras = 6 total)
const MAX_EXTRAS = 5;
const MAX_FRAME_SIZE = 5 * 1024 * 1024; // 5 MB por frame

// Gera dicas personalizadas — lógica idêntica à de biometria/cadastrar-face
function gerarDicasQualidade(detalhes?: {
  scoreDeteccao: number;
  tamanhoFace: number;
  centralizacao: number;
}): string[] {
  const dicas: string[] = [];
  if (!detalhes) {
    return ['Melhore a iluminação e aproxime o rosto da câmera.'];
  }
  if (detalhes.scoreDeteccao < 0.7) dicas.push('Melhore a iluminação do ambiente.');
  if (detalhes.tamanhoFace < 0.6) dicas.push('Aproxime mais o rosto da câmera.');
  if (detalhes.centralizacao < 0.6) dicas.push('Centralize o rosto na imagem.');
  if (dicas.length === 0) dicas.push('Tente capturar uma nova imagem com melhor iluminação.');
  return dicas;
}

/**
 * POST /api/v1/admissao/biometria-facial?token=TOKEN
 *
 * Público — candidato faz captura biométrica facial vinculada a uma solicitação de admissão.
 * Usa a mesma engine InsightFace/ArcFace de biometria/cadastrar-face, gerando o template
 * biométrico real. Como não existe colaboradorId ainda, o template é salvo em
 * people.biometria_facial_pendente e migrado para biometria_facial na admissão.
 *
 * Estratégia multi-frame: todos os frames são processados e o de maior qualidade
 * é usado como encoding principal / foto de referência.
 *
 * Body: multipart/form-data
 *   solicitacaoId  string (uuid)   obrigatório
 *   campoId        string (uuid)   obrigatório (id do campo no formulário)
 *   frame_0        File            obrigatório  image/jpeg, máx 5 MB
 *   frame_1        File            opcional
 *   frame_2        File            opcional
 *   ...            (aceita quantos frames vierem)
 *
 * Resposta sucesso: { data: { qualidade, fotoReferencia, mensagem } }
 * Resposta erro:    { error: "...", dicas: [...] }
 */
export async function POST(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token');
    if (!token) {
      return errorResponse('Token obrigatório', 401);
    }

    const formulario = await fetchFormularioAdmissaoPorToken(token);
    if (!formulario) {
      return errorResponse('Token inválido ou expirado', 403);
    }

    const formData = await request.formData();
    const solicitacaoId = formData.get('solicitacaoId') as string | null;

    if (!solicitacaoId) {
      return errorResponse('Campo solicitacaoId é obrigatório', 400);
    }

    // Valida que a solicitação pertence a este formulário
    const solResult = await query(
      `SELECT id, status FROM people.solicitacoes_admissao
       WHERE id = $1 AND formulario_id = $2`,
      [solicitacaoId, formulario.id]
    );

    if (solResult.rows.length === 0) {
      return errorResponse('Solicitação não encontrada', 404);
    }

    const sol = solResult.rows[0] as { id: string; status: string };
    if (sol.status === 'admitido') {
      return errorResponse('Solicitação já concluída', 400);
    }

    // Coleta todos os frames (frame_0, frame_1, frame_2, ...)
    const frameFiles: File[] = [];
    for (let i = 0; ; i++) {
      const f = formData.get(`frame_${i}`) as File | null;
      if (!f) break;
      frameFiles.push(f);
    }

    if (frameFiles.length === 0) {
      return errorResponse('Pelo menos um frame é obrigatório (frame_0)', 400);
    }

    // Processa cada frame com a engine de FR
    type FrameResult = {
      index: number;
      encoding: Float32Array;
      qualidade: number;
      qualidadeDetalhada?: { scoreDeteccao: number; tamanhoFace: number; centralizacao: number };
      buffer: Buffer;
      contentType: string;
    };

    const resultados: FrameResult[] = [];
    // Mantém dicas do melhor frame com face detectada (mesmo que qualidade baixa)
    let dicasRef: string[] = ['Centralize o rosto na imagem.', 'Melhore a iluminação.'];

    for (let i = 0; i < frameFiles.length; i++) {
      const frame = frameFiles[i];

      if (frame.size > MAX_FRAME_SIZE) {
        console.warn(`[biometria-facial] Frame ${i} muito grande (${frame.size} bytes), ignorando`);
        continue;
      }

      const buffer = Buffer.from(await frame.arrayBuffer());
      // extractFaceEncoding espera data URI base64
      const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;

      const { encoding, qualidade, qualidadeDetalhada, error } = await extractFaceEncoding(base64);

      if (!encoding || error) {
        console.warn(`[biometria-facial] Frame ${i} sem face detectada: ${error}`);
        // Guarda dicas deste frame como fallback para retornar ao candidato
        if (qualidadeDetalhada) {
          dicasRef = gerarDicasQualidade(qualidadeDetalhada);
        }
        continue;
      }

      // Atualiza dicas para o frame detectado de maior qualidade
      if (resultados.length === 0 || qualidade > resultados[resultados.length - 1].qualidade) {
        dicasRef = gerarDicasQualidade(qualidadeDetalhada);
      }

      resultados.push({
        index: i,
        encoding,
        qualidade,
        qualidadeDetalhada,
        buffer,
        contentType: frame.type || 'image/jpeg',
      });
    }

    if (resultados.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Não foi possível detectar uma face válida nos frames enviados.',
          dicas: dicasRef,
        },
        { status: 400 }
      );
    }

    // Seleciona o frame com maior qualidade
    resultados.sort((a, b) => b.qualidade - a.qualidade);
    const melhor = resultados[0];

    if (melhor.qualidade < QUALIDADE_MINIMA) {
      return NextResponse.json(
        {
          success: false,
          error: 'Qualidade insuficiente para cadastro biométrico. Capture uma imagem melhor.',
          qualidade: melhor.qualidade,
          minQualidade: QUALIDADE_MINIMA,
          dicas: gerarDicasQualidade(melhor.qualidadeDetalhada),
        },
        { status: 400 }
      );
    }

    console.log(`[biometria-facial] Melhor qualidade: ${melhor.qualidade} (frame ${melhor.index} de ${frameFiles.length})`);

    // Upload de todos os frames no MinIO para auditoria
    const framesUrls: string[] = [];
    for (const r of resultados) {
      try {
        const url = await uploadArquivo(
          `admissao/${solicitacaoId}/biometria/frame_${r.index}.jpg`,
          r.buffer,
          r.contentType
        );
        framesUrls.push(url);
      } catch (err) {
        console.warn(`[biometria-facial] Erro ao fazer upload do frame ${r.index}:`, err);
      }
    }

    // Upload do melhor frame como foto de referência
    let fotoReferenciaUrl = framesUrls[0] || '';
    try {
      fotoReferenciaUrl = await uploadArquivo(
        `admissao/${solicitacaoId}/biometria/referencia.jpg`,
        melhor.buffer,
        melhor.contentType
      );
    } catch (err) {
      console.warn('[biometria-facial] Erro ao fazer upload da foto de referência:', err);
    }

    // Seleciona templates extras: demais frames com qualidade >= EXTRA, até MAX_EXTRAS.
    // resultados já está ordenado por qualidade DESC, o primeiro é o principal (melhor).
    const extras = resultados
      .slice(1)
      .filter(r => r.qualidade >= QUALIDADE_MINIMA_EXTRA)
      .slice(0, MAX_EXTRAS);

    const templatesExtras = extras.map(r => encodingToBuffer(r.encoding));
    const qualidadesExtras = extras.map(r => r.qualidade);

    console.log(`[biometria-facial] Multi-sample: principal=${melhor.qualidade.toFixed(3)}, extras=${extras.length} (${qualidadesExtras.map(q => q.toFixed(3)).join(', ')})`);

    // Salva template em biometria_facial_pendente (upsert — reutiliza se já existe)
    const encodingBuffer = encodingToBuffer(melhor.encoding);
    await query(
      `INSERT INTO people.biometria_facial_pendente
         (solicitacao_id, template, foto_referencia_url, qualidade, frames_urls,
          templates_extras, qualidades_extras)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (solicitacao_id) DO UPDATE
         SET template            = EXCLUDED.template,
             foto_referencia_url = EXCLUDED.foto_referencia_url,
             qualidade           = EXCLUDED.qualidade,
             frames_urls         = EXCLUDED.frames_urls,
             templates_extras    = EXCLUDED.templates_extras,
             qualidades_extras   = EXCLUDED.qualidades_extras,
             created_at          = NOW()`,
      [solicitacaoId, encodingBuffer, fotoReferenciaUrl, melhor.qualidade, framesUrls,
       templatesExtras, qualidadesExtras]
    );

    return successResponse({
      qualidade: melhor.qualidade,
      fotoReferencia: fotoReferenciaUrl,
      totalAmostras: 1 + extras.length,
      mensagem: 'Biometria capturada com sucesso',
    });
  } catch (error) {
    console.error('[biometria-facial] Erro ao processar:', error);
    return serverErrorResponse('Erro ao processar biometria facial');
  }
}
