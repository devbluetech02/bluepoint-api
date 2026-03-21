#!/usr/bin/env node
/**
 * Roda a migration 001_documentos_colaborador_tipos_validade.up.sql
 * Uso: node --env-file=.env scripts/run-migration-documentos.mjs
 * Ou: node scripts/run-migration-documentos.mjs (usa variáveis já definidas no ambiente)
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

async function main() {
  await loadEnv();

  const client = new pg.Client({
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_DATABASE,
    ssl: process.env.DB_SSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
    console.log('Conectado ao banco:', process.env.DB_DATABASE);

    const sqlPath = path.join(__dirname, '..', 'database', 'migrations', '001_documentos_colaborador_tipos_validade.up.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    await client.query(sql);
    console.log('Migration 001_documentos_colaborador_tipos_validade.up.sql executada com sucesso.');
  } catch (err) {
    console.error('Erro na migration:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
