import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export const parseIso = (value) => (value ? new Date(value) : null);

export function plusDays(days, base = new Date()) {
  return new Date(new Date(base).getTime() + days * 86400000).toISOString();
}

export const newToken = () => crypto.randomBytes(18).toString('base64url');

export function brl(cents) {
  return 'R$ ' + (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Data no fuso de Brasília (dd/mm/aaaa)
export function dateBr(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function collapseSpaces(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
