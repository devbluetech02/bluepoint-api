import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { withRole } from '@/lib/middleware';
import { JWTPayload } from '@/lib/auth';
import { extractFaceEncoding, encodingToBuffer } from '@/lib/face-recognition';
import { registrarAuditoria } from '@/lib/audit';
import { cacheDel, checkRateLimit, CACHE_KEYS } from '@/lib/cache';
import { z } from 'zod';

// Schema de validação - agora só precisa do CPF e imagem
const cadastrarFaceCpfSchema = z.object({
  // Identificação do colaborador
  cpf: z.string()
    .min(11, 'CPF deve ter 11 dígitos')
    .max(14, 'CPF inválido')
    .transform(val => val.replace(/\D/g, '')), // Remove pontuação
  
  // Imagem facial
  imagem: z.string().min(100, 'Imagem inválida'),
});

// Tipos de usuário que podem cadastrar biometria
const TIPOS_PERMITIDOS = ['admin', 'gestor', 'gerente', 'supervisor', 'coordenador', 'rh'];

// Response helper
function jsonResponse(data: object, status: number = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

// Função para obter IP do cliente
function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfIp = request.headers.get('cf-connecting-ip');
  
  if (cfIp) return cfIp;
  if (forwarded) return forwarded.split(',')[0].trim();
  if (realIp) return realIp;
  
  return 'unknown';
}

// Formata CPF para exibição (XXX.XXX.XXX-XX)
function formatarCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return cpf;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

// Gera dicas personalizadas baseadas na análise de qualidade
function gerarDicasQualidade(detalhes?: {
  scoreDeteccao: number;
  tamanhoFace: number;
  centralizacao: number;
}): string[] {
  const dicas: string[] = [];
  
  if (!detalhes) {
    return ['Melhore a iluminação e aproxime o rosto da câmera.'];
  }
  
  if (detalhes.scoreDeteccao < 0.7) {
    dicas.push('Melhore a iluminação do ambiente.');
  }
  if (detalhes.tamanhoFace < 0.6) {
    dicas.push('Aproxime mais o rosto da câmera.');
  }
  if (detalhes.centralizacao < 0.6) {
    dicas.push('Centralize o rosto na imagem.');
  }
  
  if (dicas.length === 0) {
    dicas.push('Tente capturar uma nova imagem com melhor iluminação.');
  }
  
  return dicas;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const clientIp = getClientIp(request);

  // Rate limiting: 20 cadastros por minuto por IP
  const rateLimit = await checkRateLimit(`biometria:cadastrar-cpf:${clientIp}`, 20, 60);
  
  const rateLimitHeaders = {
    'X-RateLimit-Limit': '20',
    'X-RateLimit-Remaining': rateLimit.remaining.toString(),
    'X-RateLimit-Reset': rateLimit.resetIn.toString(),
  };

  if (!rateLimit.allowed) {
    return jsonResponse({
      success: false,
      error: 'Muitas tentativas. Aguarde alguns segundos.',
      code: 'RATE_LIMIT_EXCEEDED',
    }, 429, rateLimitHeaders);
  }

  // Autenticação via JWT com validação de role
  return withRole(request, TIPOS_PERMITIDOS, async (req: NextRequest, user: JWTPayload) => {
    try {
      // Parse body
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({
          success: false,
          error: 'JSON inválido',
          code: 'INVALID_JSON',
        }, 400, rateLimitHeaders);
      }
      
      // Validar request
      const validation = cadastrarFaceCpfSchema.safeParse(body);
      if (!validation.success) {
        return jsonResponse({
          success: false,
          error: 'Erro de validação',
          code: 'VALIDATION_ERROR',
          details: validation.error.issues.map(i => ({
            field: i.path.join('.') || 'geral',
            message: i.message,
          })),
        }, 422, rateLimitHeaders);
      }

      const { cpf, imagem } = validation.data;

      // ========================================
      // 1. BUSCAR COLABORADOR PELO CPF
      // ========================================
      const colaboradorResult = await query(
        `SELECT id, nome, email, cpf, status, face_registrada
         FROM people.colaboradores 
         WHERE cpf = $1 OR cpf = $2`,
        [cpf, formatarCpf(cpf)] // Busca com e sem formatação
      );

      if (colaboradorResult.rows.length === 0) {
        return jsonResponse({
          success: false,
          error: 'Colaborador não encontrado com este CPF',
          code: 'COLLABORATOR_NOT_FOUND',
          cpfInformado: formatarCpf(cpf),
        }, 404, rateLimitHeaders);
      }

      const colaborador = colaboradorResult.rows[0];

      // Verificar se colaborador está ativo
      if (colaborador.status !== 'ativo') {
        return jsonResponse({
          success: false,
          error: 'Colaborador inativo. Não é possível cadastrar biometria.',
          code: 'COLLABORATOR_INACTIVE',
          colaborador: {
            nome: colaborador.nome,
            status: colaborador.status,
          },
        }, 400, rateLimitHeaders);
      }

      // ========================================
      // 2. EXTRAIR ENCODING FACIAL
      // ========================================
      const { 
        encoding, 
        qualidade, 
        qualidadeDetalhada,
        error 
      } = await extractFaceEncoding(imagem);

      if (!encoding || error) {
        return jsonResponse({
          success: false,
          error: error || 'Não foi possível detectar a face na imagem',
          code: 'FACE_NOT_DETECTED',
          dica: 'Certifique-se de que o rosto está bem iluminado, centralizado e visível na câmera.',
        }, 400, rateLimitHeaders);
      }

      // Para cadastro, exigimos qualidade um pouco maior
      if (qualidade < 0.4) {
        return jsonResponse({
          success: false,
          error: 'Qualidade da imagem insuficiente para cadastro. Por favor, capture uma imagem melhor.',
          code: 'LOW_QUALITY',
          qualidade,
          qualidadeDetalhada,
          minQualidade: 0.4,
          dicas: gerarDicasQualidade(qualidadeDetalhada),
        }, 400, rateLimitHeaders);
      }

      // ========================================
      // 3. SALVAR BIOMETRIA
      // ========================================
      const encodingBuffer = encodingToBuffer(encoding);
      const jaTemBiometria = colaborador.face_registrada;

      // Verificar se já existe registro
      const existeResult = await query(
        `SELECT id FROM people.biometria_facial WHERE colaborador_id = $1`,
        [colaborador.id]
      );

      if (existeResult.rows.length > 0) {
        // Atualizar registro existente
        await query(
          `UPDATE people.biometria_facial 
           SET encoding = $1, qualidade = $2, atualizado_em = NOW()
           WHERE colaborador_id = $3`,
          [encodingBuffer, qualidade, colaborador.id]
        );
      } else {
        // Criar novo registro
        await query(
          `INSERT INTO people.biometria_facial (colaborador_id, encoding, qualidade)
           VALUES ($1, $2, $3)`,
          [colaborador.id, encodingBuffer, qualidade]
        );
      }

      // Atualizar flag no colaborador
      await query(
        `UPDATE people.colaboradores 
         SET face_registrada = true, atualizado_em = NOW() 
         WHERE id = $1`,
        [colaborador.id]
      );

      // Invalidar cache de encodings
      await cacheDel(CACHE_KEYS.BIOMETRIA_ENCODINGS);

      // ========================================
      // 4. REGISTRAR AUDITORIA
      // ========================================
      await registrarAuditoria({
        usuarioId: user.userId,
        acao: jaTemBiometria ? 'UPDATE' : 'CREATE',
        modulo: 'biometria',
        descricao: `Face ${jaTemBiometria ? 'atualizada' : 'cadastrada'} para: ${colaborador.nome} (CPF: ${formatarCpf(cpf)})`,
        ip: clientIp,
        userAgent: request.headers.get('user-agent') || undefined,
        dadosNovos: { 
          colaboradorId: colaborador.id, 
          cpf: formatarCpf(cpf),
          qualidade,
          cadastradoPor: user.userId,
        },
      });

      console.log(`[Cadastrar Face CPF] Admin: ${user.nome} (${user.userId}) cadastrou face de: ${colaborador.nome}, Qualidade: ${qualidade}`);

      // ========================================
      // RESPOSTA DE SUCESSO
      // ========================================
      return jsonResponse({
        success: true,
        data: {
          colaborador: {
            id: colaborador.id,
            nome: colaborador.nome,
            cpf: formatarCpf(cpf),
          },
          biometria: {
            qualidade,
            qualidadeDetalhada,
            atualizado: jaTemBiometria,
          },
          cadastradoPor: {
            id: user.userId,
            nome: user.nome,
          },
          mensagem: jaTemBiometria 
            ? 'Biometria facial atualizada com sucesso' 
            : 'Biometria facial cadastrada com sucesso',
          processedIn: Date.now() - startTime,
        },
      }, jaTemBiometria ? 200 : 201, rateLimitHeaders);

    } catch (error) {
      console.error('Erro ao cadastrar face via CPF:', error);
      return jsonResponse({
        success: false,
        error: 'Erro interno ao processar cadastro facial',
        code: 'INTERNAL_ERROR',
      }, 500, rateLimitHeaders);
    }
  });
}

// Suporte a OPTIONS para CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
