import jwt, { SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from './db';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_change_me';
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || '24h') as SignOptions['expiresIn'];
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

export interface JWTPayload {
  userId: number;
  email: string;
  tipo: string;
  nome: string;
}

export interface TokenPair {
  token: string;
  refreshToken: string;
}

// Gerar hash de senha
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

// Verificar senha
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Gerar token JWT
export function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// Gerar refresh token
export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

// Verificar e decodificar token
export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch {
    return null;
  }
}

// Gerar par de tokens (access + refresh)
export async function generateTokenPair(user: {
  id: number;
  email: string;
  tipo: string;
  nome: string;
}): Promise<TokenPair> {
  const payload: JWTPayload = {
    userId: user.id,
    email: user.email,
    tipo: user.tipo,
    nome: user.nome,
  };

  const token = generateToken(payload);
  const refreshToken = generateRefreshToken();

  // Calcular data de expiração do refresh token
  const expiresIn = JWT_REFRESH_EXPIRES_IN;
  const days = parseInt(expiresIn.replace('d', '')) || 7;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);

  // Salvar refresh token no banco
  await query(
    `INSERT INTO refresh_tokens (usuario_id, token, data_expiracao) 
     VALUES ($1, $2, $3)`,
    [user.id, refreshToken, expiresAt]
  );

  return { token, refreshToken };
}

// Validar refresh token
export async function validateRefreshToken(refreshToken: string) {
  const result = await query(
    `SELECT rt.*, c.id, c.email, c.nome, c.tipo, c.status
     FROM refresh_tokens rt
     JOIN colaboradores c ON rt.usuario_id = c.id
     WHERE rt.token = $1 
       AND rt.revogado = false 
       AND rt.data_expiracao > NOW()
       AND c.status = 'ativo'`,
    [refreshToken]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

// Revogar refresh token
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens 
     SET revogado = true, revogado_em = NOW() 
     WHERE token = $1`,
    [refreshToken]
  );
}

// Revogar todos os tokens de um usuário
export async function revokeAllUserTokens(userId: number): Promise<void> {
  await query(
    `UPDATE refresh_tokens 
     SET revogado = true, revogado_em = NOW() 
     WHERE usuario_id = $1 AND revogado = false`,
    [userId]
  );
}

// Gerar token de recuperação de senha
export async function generatePasswordResetToken(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 1); // Expira em 1 hora

  await query(
    `INSERT INTO tokens_recuperacao (usuario_id, token, data_expiracao) 
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  return token;
}

// Validar token de recuperação de senha
export async function validatePasswordResetToken(token: string) {
  const result = await query(
    `SELECT tr.*, c.id as usuario_id, c.email, c.nome
     FROM tokens_recuperacao tr
     JOIN colaboradores c ON tr.usuario_id = c.id
     WHERE tr.token = $1 
       AND tr.usado = false 
       AND tr.data_expiracao > NOW()`,
    [token]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
}

// Marcar token de recuperação como usado
export async function markPasswordResetTokenAsUsed(token: string): Promise<void> {
  await query(
    `UPDATE tokens_recuperacao 
     SET usado = true, usado_em = NOW() 
     WHERE token = $1`,
    [token]
  );
}

// Extrair token do header Authorization
export function extractTokenFromHeader(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}
