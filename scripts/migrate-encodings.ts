/**
 * Script de Migração de Encodings: face-api.js (128-dim) → InsightFace/ArcFace (512-dim)
 * 
 * Este script:
 * 1. Busca todos os registros de biometria facial que têm foto_referencia_url
 * 2. Baixa cada foto do MinIO
 * 3. Re-extrai o encoding usando o novo motor InsightFace via face-service
 * 4. Atualiza o banco com o novo encoding de 512 dimensões
 * 5. Limpa encodings_extras (incompatíveis) e reseta total_encodings
 * 
 * Uso: npx tsx scripts/migrate-encodings.ts
 * 
 * IMPORTANTE: O face-service Python deve estar rodando antes de executar este script.
 */

import { Pool } from 'pg';

// ==========================================
// Configuração
// ==========================================

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || 'http://localhost:5000';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || '10.1.3.216';
const MINIO_PORT = process.env.MINIO_PORT || '9100';
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'bluepoint';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '6432'),
  user: process.env.DB_USERNAME || 'doadmin',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'defaultdb',
  ssl: process.env.DB_SSLMODE === 'require' ? { rejectUnauthorized: false } : false,
};

// ==========================================
// Helpers
// ==========================================

async function checkFaceService(): Promise<boolean> {
  try {
    const res = await fetch(`${FACE_SERVICE_URL}/health`);
    const data = await res.json();
    return data.ready === true;
  } catch {
    return false;
  }
}

async function downloadImage(url: string): Promise<string | null> {
  try {
    // Construir URL completa do MinIO se necessário
    let fullUrl = url;
    if (!url.startsWith('http')) {
      const protocol = MINIO_USE_SSL ? 'https' : 'http';
      fullUrl = `${protocol}://${MINIO_ENDPOINT}:${MINIO_PORT}/${MINIO_BUCKET}/${url}`;
    }

    const res = await fetch(fullUrl);
    if (!res.ok) {
      console.warn(`  [WARN] Erro ao baixar imagem: ${res.status} ${res.statusText}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch (error) {
    console.warn(`  [WARN] Erro ao baixar imagem:`, error);
    return null;
  }
}

async function extractEncoding(imageBase64: string): Promise<{ embedding: number[]; quality: number } | null> {
  try {
    const res = await fetch(`${FACE_SERVICE_URL}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagem: imageBase64 }),
    });

    const data = await res.json();
    if (!data.success || !data.embedding) {
      console.warn(`  [WARN] Face não detectada: ${data.error || 'sem detalhes'}`);
      return null;
    }

    return { embedding: data.embedding, quality: data.quality };
  } catch (error) {
    console.warn(`  [WARN] Erro ao extrair encoding:`, error);
    return null;
  }
}

function encodingToBuffer(embedding: number[]): Buffer {
  const float32 = new Float32Array(embedding);
  return Buffer.from(float32.buffer);
}

// ==========================================
// Main
// ==========================================

async function main() {
  console.log('==============================================');
  console.log('Migração de Encodings: face-api.js → ArcFace');
  console.log('==============================================\n');

  // 1. Verificar face-service
  console.log('[1/4] Verificando face-service...');
  const serviceOk = await checkFaceService();
  if (!serviceOk) {
    console.error('❌ Face service não está disponível em:', FACE_SERVICE_URL);
    console.error('   Inicie o face-service antes de executar a migração.');
    process.exit(1);
  }
  console.log('✅ Face service online\n');

  // 2. Conectar ao banco
  console.log('[2/4] Conectando ao banco de dados...');
  const pool = new Pool(DB_CONFIG as any);
  
  try {
    await pool.query('SELECT 1');
    console.log('✅ Conectado ao banco\n');
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco:', error);
    process.exit(1);
  }

  // 3. Buscar registros para migrar
  console.log('[3/4] Buscando registros de biometria...');
  const result = await pool.query(`
    SELECT id, colaborador_id, external_id, foto_referencia_url, 
           octet_length(encoding) as encoding_size
    FROM bluepoint.bt_biometria_facial
    WHERE encoding IS NOT NULL
    ORDER BY id
  `);

  const total = result.rows.length;
  console.log(`   Total de registros: ${total}\n`);

  if (total === 0) {
    console.log('Nenhum registro para migrar.');
    await pool.end();
    return;
  }

  // 4. Migrar cada registro
  console.log('[4/4] Iniciando migração...\n');
  
  let migrados = 0;
  let semFoto = 0;
  let erros = 0;
  let jaArcFace = 0;

  for (let i = 0; i < total; i++) {
    const row = result.rows[i];
    const identificador = row.colaborador_id 
      ? `Colaborador #${row.colaborador_id}` 
      : `Externo: ${JSON.stringify(row.external_id)}`;

    process.stdout.write(`  [${i + 1}/${total}] ${identificador}... `);

    // Verificar se já é ArcFace (512-dim = 2048 bytes)
    if (row.encoding_size === 2048) {
      console.log('já migrado (512-dim) ✅');
      jaArcFace++;
      continue;
    }

    // Verificar se tem foto de referência
    if (!row.foto_referencia_url) {
      console.log('sem foto de referência ⚠️ (necessário recadastrar)');
      semFoto++;
      continue;
    }

    // Baixar imagem do MinIO
    const imageBase64 = await downloadImage(row.foto_referencia_url);
    if (!imageBase64) {
      console.log('erro ao baixar foto ⚠️');
      erros++;
      continue;
    }

    // Extrair novo encoding via ArcFace
    const result2 = await extractEncoding(imageBase64);
    if (!result2) {
      console.log('face não detectada na foto ⚠️');
      erros++;
      continue;
    }

    // Atualizar banco
    const newEncodingBuffer = encodingToBuffer(result2.embedding);
    
    try {
      await pool.query(`
        UPDATE bluepoint.bt_biometria_facial 
        SET encoding = $1, 
            qualidade = $2, 
            encodings_extras = '{}',
            qualidades_extras = '{}',
            total_encodings = 1,
            atualizado_em = NOW()
        WHERE id = $3
      `, [newEncodingBuffer, result2.quality, row.id]);

      migrados++;
      console.log(`migrado (qual: ${result2.quality.toFixed(2)}) ✅`);
    } catch (error) {
      console.log(`erro ao salvar ❌`);
      console.error(`    Detalhe:`, error);
      erros++;
    }

    // Pequena pausa para não sobrecarregar
    if (i % 10 === 9) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Resumo
  console.log('\n==============================================');
  console.log('RESUMO DA MIGRAÇÃO');
  console.log('==============================================');
  console.log(`  Total de registros: ${total}`);
  console.log(`  Migrados com sucesso: ${migrados}`);
  console.log(`  Já eram ArcFace: ${jaArcFace}`);
  console.log(`  Sem foto (recadastrar): ${semFoto}`);
  console.log(`  Erros: ${erros}`);
  console.log('==============================================\n');

  if (semFoto > 0) {
    console.log('⚠️  Registros sem foto de referência precisam ser recadastrados manualmente.');
    console.log('   Use o endpoint POST /api/v1/biometria/cadastrar-face para recadastrar.\n');
  }

  // Limpar cache Redis (via API se disponível)
  try {
    console.log('Limpando cache Redis...');
    // Tentar via endpoint interno da API
    const cacheRes = await fetch('http://localhost:3003/api/v1/limpar-cache', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.API_KEY || ''}` },
    });
    if (cacheRes.ok) {
      console.log('✅ Cache limpo\n');
    } else {
      console.log('⚠️  Não foi possível limpar cache automaticamente. Limpe manualmente.\n');
    }
  } catch {
    console.log('⚠️  Não foi possível limpar cache automaticamente. Limpe manualmente.\n');
  }

  await pool.end();
  console.log('Migração concluída!');
}

main().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
