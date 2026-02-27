import * as Minio from 'minio';

// =====================================================
// CONFIGURAÇÃO DO MINIO (LAZY-LOADED EM RUNTIME)
// =====================================================

let _minioClient: Minio.Client | null = null;

function getMinioClient(): Minio.Client {
  if (!_minioClient) {
    const endpoint = process.env.MINIO_ENDPOINT || 'localhost';
    const port = parseInt(process.env.MINIO_PORT || '9000');
    console.log(`[MINIO] Inicializando cliente: ${endpoint}:${port}`);
    
    _minioClient = new Minio.Client({
      endPoint: endpoint,
      port: port,
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || '',
      secretKey: process.env.MINIO_SECRET_KEY || '',
    });
  }
  return _minioClient;
}

function getBucketName(): string {
  return process.env.MINIO_BUCKET || 'bluepoint';
}

// =====================================================
// HELPERS
// =====================================================

/**
 * Normaliza nome para usar como pasta (remove acentos, caracteres especiais)
 */
export function normalizarNomePasta(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')     // Remove caracteres especiais
    .trim()
    .replace(/\s+/g, '_');           // Espaços viram underscore
}

/**
 * Garante que o bucket existe
 */
export async function garantirBucket(): Promise<void> {
  const bucketName = getBucketName();
  const client = getMinioClient();
  console.log(`[MINIO] Verificando bucket '${bucketName}'...`);
  const exists = await client.bucketExists(bucketName);
  console.log(`[MINIO] Bucket existe: ${exists}`);
  if (!exists) {
    await client.makeBucket(bucketName);
    console.log(`[MINIO] Bucket '${bucketName}' criado com sucesso`);
  }
}

/**
 * Gera URL interna do MinIO (para uso da API)
 */
export function gerarUrlInterna(caminho: string): string {
  const endpoint = process.env.MINIO_ENDPOINT || 'minio';
  const port = process.env.MINIO_PORT || '9000';
  const useSSL = process.env.MINIO_USE_SSL === 'true';
  const protocol = useSSL ? 'https' : 'http';
  
  return `${protocol}://${endpoint}:${port}/${getBucketName()}/${caminho}`;
}

/**
 * Gera URL pública via proxy da API
 * Formato: /storage/{caminho}
 */
export function gerarUrlPublica(caminho: string): string {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3003';
  return `${baseUrl}/api/v1/storage/${encodeURIComponent(caminho)}`;
}

// =====================================================
// OPERAÇÕES DE ARQUIVOS
// =====================================================

/**
 * Lista arquivos em um diretório
 */
export async function listarArquivos(pasta: string): Promise<string[]> {
  await garantirBucket();
  
  return new Promise((resolve, reject) => {
    const arquivos: string[] = [];
    const stream = getMinioClient().listObjects(getBucketName(), pasta, true);
    
    stream.on('data', (obj) => {
      if (obj.name) {
        arquivos.push(obj.name);
      }
    });
    
    stream.on('error', reject);
    stream.on('end', () => resolve(arquivos));
  });
}

/**
 * Deleta um arquivo
 */
export async function deletarArquivo(caminho: string): Promise<void> {
  try {
    await getMinioClient().removeObject(getBucketName(), caminho);
    console.log(`Arquivo deletado: ${caminho}`);
  } catch (error) {
    console.error(`Erro ao deletar arquivo ${caminho}:`, error);
    // Não lança erro se arquivo não existe
  }
}

/**
 * Deleta todos os arquivos de uma pasta
 */
export async function deletarPasta(pasta: string): Promise<void> {
  const arquivos = await listarArquivos(pasta);
  
  for (const arquivo of arquivos) {
    await deletarArquivo(arquivo);
  }
}

/**
 * Upload de arquivo
 */
export async function uploadArquivo(
  caminho: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  await garantirBucket();
  
  await getMinioClient().putObject(getBucketName(), caminho, buffer, buffer.length, {
    'Content-Type': contentType,
  });
  
  return gerarUrlPublica(caminho);
}

// =====================================================
// OPERAÇÕES DE FOTO DE COLABORADOR
// =====================================================

/**
 * Salva foto do colaborador
 * - Cria pasta com nome do colaborador se não existir
 * - Deleta foto anterior se existir
 * - Retorna URL da nova foto
 */
export async function salvarFotoColaborador(
  colaboradorId: number,
  _colaboradorNome: string, // mantido por compatibilidade, mas não usado
  fotoBuffer: Buffer,
  contentType: string,
  extensao: string
): Promise<{ url: string; caminho: string }> {
  await garantirBucket();
  
  // Usar apenas ID para evitar problemas ao trocar nome
  const pastaColaborador = `colaboradores/${colaboradorId}`;
  
  // Listar arquivos existentes na pasta do colaborador
  const arquivosExistentes = await listarArquivos(pastaColaborador);
  
  // Deletar fotos anteriores (qualquer arquivo que comece com "foto_")
  for (const arquivo of arquivosExistentes) {
    if (arquivo.includes('/foto_') || arquivo.includes('/foto.')) {
      await deletarArquivo(arquivo);
    }
  }
  
  // Nome do arquivo: foto.{extensao} (sempre o mesmo nome para facilitar)
  const nomeArquivo = `foto.${extensao}`;
  const caminhoCompleto = `${pastaColaborador}/${nomeArquivo}`;
  
  // Upload
  const url = await uploadArquivo(caminhoCompleto, fotoBuffer, contentType);
  
  return { url, caminho: caminhoCompleto };
}

/**
 * Deleta foto do colaborador
 */
export async function deletarFotoColaborador(
  colaboradorId: number,
  _colaboradorNome?: string // mantido por compatibilidade, mas não usado
): Promise<void> {
  // Usar apenas ID para evitar problemas ao trocar nome
  const pastaColaborador = `colaboradores/${colaboradorId}`;
  
  // Deletar todos os arquivos da pasta
  await deletarPasta(pastaColaborador);
}

/**
 * Obtém URL da foto do colaborador (se existir)
 */
export async function obterFotoColaborador(
  colaboradorId: number,
  _colaboradorNome?: string // mantido por compatibilidade, mas não usado
): Promise<string | null> {
  // Usar apenas ID para evitar problemas ao trocar nome
  const pastaColaborador = `colaboradores/${colaboradorId}`;
  
  const arquivos = await listarArquivos(pastaColaborador);
  const foto = arquivos.find(a => a.includes('/foto.') || a.includes('/foto_'));
  
  if (foto) {
    return gerarUrlPublica(foto);
  }
  
  return null;
}

// =====================================================
// OPERAÇÕES DE APK
// =====================================================

/**
 * Salva APK no storage (substitui se já existir)
 * - Estrutura: apps/{nomeApp}/{nomeApp}.apk
 * - Sempre sobrescreve o anterior
 */
/**
 * Interface do meta.json de cada app
 */
interface AppMeta {
  nome: string;
  versao: string;
  arquivo: string;
  tamanho: number;
  atualizadoEm: string;
}

/**
 * Obtém meta.json de um app (se existir)
 */
async function obterAppMeta(nomePasta: string): Promise<AppMeta | null> {
  try {
    const caminhoMeta = `apps/${nomePasta}/meta.json`;
    const bucketName = getBucketName();
    const minioClient = getMinioClient();
    
    const stream = await minioClient.getObject(bucketName, caminhoMeta);
    const chunks: Buffer[] = [];
    
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    
    const data = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(data) as AppMeta;
  } catch {
    return null;
  }
}

/**
 * Salva meta.json de um app
 */
async function salvarAppMeta(nomePasta: string, meta: AppMeta): Promise<void> {
  const caminhoMeta = `apps/${nomePasta}/meta.json`;
  const buffer = Buffer.from(JSON.stringify(meta, null, 2), 'utf-8');
  await uploadArquivo(caminhoMeta, buffer, 'application/json');
}

export async function salvarApk(
  nomeApp: string,
  versao: string | null,
  apkBuffer: Buffer,
  nomeArquivo?: string
): Promise<{ url: string; caminho: string; tamanho: number; versao: string }> {
  await garantirBucket();
  
  // Normalizar nome do app para pasta
  const nomePasta = normalizarNomePasta(nomeApp);
  const nomeArquivoFinal = nomeArquivo || `${nomePasta}.apk`;
  const caminhoCompleto = `apps/${nomePasta}/${nomeArquivoFinal}`;
  
  // Obter meta atual (se existir)
  const metaAtual = await obterAppMeta(nomePasta);
  
  // Determinar versão: usa a enviada, ou mantém a atual, ou default
  const versaoFinal = versao || metaAtual?.versao || '1.0.0';
  
  // Deletar APK anterior se existir
  const arquivosAnteriores = await listarArquivos(`apps/${nomePasta}/`);
  for (const arquivo of arquivosAnteriores) {
    if (arquivo.endsWith('.apk')) {
      await deletarArquivo(arquivo);
    }
  }
  
  // Upload do APK
  const url = await uploadArquivo(caminhoCompleto, apkBuffer, 'application/vnd.android.package-archive');
  
  // Salvar meta.json
  const meta: AppMeta = {
    nome: nomeApp,
    versao: versaoFinal,
    arquivo: nomeArquivoFinal,
    tamanho: apkBuffer.length,
    atualizadoEm: new Date().toISOString(),
  };
  await salvarAppMeta(nomePasta, meta);
  
  return { 
    url, 
    caminho: caminhoCompleto, 
    tamanho: apkBuffer.length,
    versao: versaoFinal,
  };
}

/**
 * Obtém URL e informações do APK
 */
export async function obterApk(nomeApp: string): Promise<{ url: string; caminho: string; versao: string; tamanho: number; atualizadoEm: string } | null> {
  const nomePasta = normalizarNomePasta(nomeApp);
  const arquivos = await listarArquivos(`apps/${nomePasta}/`);
  
  const apk = arquivos.find(a => a.endsWith('.apk'));
  if (apk) {
    // Buscar meta.json para informações adicionais
    const meta = await obterAppMeta(nomePasta);
    
    return {
      url: gerarUrlPublica(apk),
      caminho: apk,
      versao: meta?.versao || '1.0.0',
      tamanho: meta?.tamanho || 0,
      atualizadoEm: meta?.atualizadoEm || '',
    };
  }
  
  return null;
}

/**
 * Deleta APK do app
 */
export async function deletarApk(nomeApp: string): Promise<void> {
  const nomePasta = normalizarNomePasta(nomeApp);
  await deletarPasta(`apps/${nomePasta}/`);
}

// =====================================================
// EXPORTAR CLIENTE (para uso avançado)
// =====================================================

export { getMinioClient, getBucketName };
