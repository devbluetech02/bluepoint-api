/**
 * Tokens assinados pra autorizar o candidato a preencher referências
 * profissionais via form público (sem login). Validade longa porque
 * candidato pode demorar pra responder; expira em 30 dias.
 *
 * Backend embute o token na URL enviada por WhatsApp logo após o gestor
 * aprovar+encerrar. Quando o candidato submete o form, o endpoint
 * público valida o token e grava as referências exatamente como o
 * fluxo manual do RH faria.
 */
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_change_me';
const EXPIRA_EM = '30d';

interface Payload {
  tipo: 'referencias_dia_teste';
  agendamentoId: string;
  candidatoCpf: string;
  candidatoRecrutamentoId: number;
}

export function criarTokenReferencias(args: {
  agendamentoId: string;
  candidatoCpf: string;
  candidatoRecrutamentoId: number;
}): string {
  const payload: Payload = {
    tipo: 'referencias_dia_teste',
    agendamentoId: args.agendamentoId,
    candidatoCpf: args.candidatoCpf,
    candidatoRecrutamentoId: args.candidatoRecrutamentoId,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: EXPIRA_EM });
}

export function validarTokenReferencias(token: string): {
  agendamentoId: string;
  candidatoCpf: string;
  candidatoRecrutamentoId: number;
} | null {
  try {
    const p = jwt.verify(token, JWT_SECRET) as Partial<Payload>;
    if (p?.tipo !== 'referencias_dia_teste') return null;
    if (!p.agendamentoId || !p.candidatoCpf || typeof p.candidatoRecrutamentoId !== 'number') {
      return null;
    }
    return {
      agendamentoId: String(p.agendamentoId),
      candidatoCpf: String(p.candidatoCpf),
      candidatoRecrutamentoId: Number(p.candidatoRecrutamentoId),
    };
  } catch {
    return null;
  }
}
