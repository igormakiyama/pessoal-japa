// Envio de e-mails pela API HTTP do Brevo (grátis até 300 e-mails/dia).
// Sem Brevo configurado ("outbox"), os e-mails são gravados em DATA_DIR/outbox para conferência.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config, paths } from './config.js';
import { TEMPLATES } from './views/emails.js';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 30000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Desfaz as entidades HTML numa passada só (assim "&amp;lt;" vira "&lt;", não "<").
function unescapeHtml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    const key = code.toLowerCase();
    return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : match;
  });
}

// Versão em texto puro do e-mail (para clientes que não mostram HTML).
export function htmlToText(html) {
  let text = String(html ?? '').replace(/<(br|\/p|\/h\d|\/li|\/div)\s*\/?>/gi, '\n');
  text = text.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)');
  text = text.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, '');
  text = unescapeHtml(text);
  return text.replace(/\n\s*\n+/g, '\n\n').trim();
}

// Valor seguro para ir dentro do comentário HTML do arquivo de teste.
const commentSafe = (value) => String(value ?? '').replace(/\s+/g, ' ').replace(/[<>]/g, '_').trim();

function writeOutbox(to, subject, html) {
  const dir = paths.outbox();
  fs.mkdirSync(dir, { recursive: true });
  const iso = new Date().toISOString();
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
  const safeTo = String(to).replace(/[^a-zA-Z0-9@._-]/g, '_').slice(0, 100);
  const file = path.join(dir, `${stamp}-${safeTo}-${crypto.randomBytes(3).toString('hex')}.html`);
  const header = `<!--\nTo: ${commentSafe(to)}\nSubject: ${commentSafe(subject)}\n-->\n`;
  fs.writeFileSync(file, header + html);
  console.log(`[e-mail de teste] para ${to}: ${subject} -> ${file}`);
  return file;
}

async function sendBrevo(to, subject, html) {
  if (!config.brevoApiKey) throw new Error('BREVO_API_KEY não configurada.');
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': config.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: config.siteName, email: config.emailFrom },
      to: [{ email: to }],
      replyTo: { email: config.supportEmail },
      subject,
      htmlContent: html,
      textContent: htmlToText(html),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Brevo recusou o e-mail (HTTP ${res.status}): ${detail.slice(0, 300)}`);
  }
  console.log(`E-mail enviado para ${to}: ${subject}`);
}

export async function sendEmail({ to, subject, html }) {
  const body = String(html ?? '');
  if (config.emailProvider === 'brevo') return sendBrevo(to, subject, body);
  if (config.emailProvider === 'outbox') {
    writeOutbox(to, subject, body);
    return undefined;
  }
  throw new Error(`EMAIL_PROVIDER desconhecido: ${config.emailProvider}`);
}

// Monta o e-mail a partir do template (views/emails.js) e envia.
export async function sendTemplate(name, to, subject, ctx = {}) {
  if (!Object.hasOwn(TEMPLATES, name)) throw new Error(`Template de e-mail desconhecido: ${name}`);
  const html = TEMPLATES[name]({ ...ctx, subject });
  await sendEmail({ to, subject, html });
}
