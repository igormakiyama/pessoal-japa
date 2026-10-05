// Cria (ou completa) o arquivo .env.site com as variáveis de produção.
// Gera senha do admin e segredo de sessão aleatórios e NUNCA os mostra na tela.
//
// Uso: node scripts/setup-env.js --admin-email=voce@exemplo.com --base-url=https://nome.metodoim.com.br
//      [--support-email=contato@exemplo.com]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnv } from '../src/env.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.env.site');

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => {
    const [key, ...rest] = a.slice(2).split('=');
    return [key, rest.join('=')];
  }));

const existing = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
const adminEmail = (args['admin-email'] || existing.ADMIN_EMAIL || '').trim().toLowerCase();
const baseUrl = (args['base-url'] || existing.BASE_URL || '').trim().replace(/\/+$/, '');
if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(adminEmail) || !/^https?:\/\/[^/]+$/.test(baseUrl)) {
  console.error('Informe --admin-email=<e-mail> e --base-url=https://<nome>.metodoim.com.br');
  process.exit(1);
}

const password = () => crypto.randomBytes(18).toString('base64url');
const values = {
  NODE_ENV: existing.NODE_ENV || 'production',
  SITE_NAME: existing.SITE_NAME || 'Era Uma Vez Eu',
  BASE_URL: baseUrl,
  SUPPORT_EMAIL: args['support-email'] || existing.SUPPORT_EMAIL || adminEmail,
  ADMIN_EMAIL: adminEmail,
  ADMIN_PASSWORD: existing.ADMIN_PASSWORD || password(),
  SESSION_SECRET: existing.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  LLM_PROVIDER: existing.LLM_PROVIDER || 'auto',
  LLM_API_KEY: existing.LLM_API_KEY || '',
  LLM_MODEL: existing.LLM_MODEL || 'llama-3.3-70b-versatile,openai/gpt-oss-120b',
  PAYMENT_PROVIDER: existing.PAYMENT_PROVIDER || 'fake',
  MP_ACCESS_TOKEN: existing.MP_ACCESS_TOKEN || '',
  MP_STATEMENT_DESCRIPTOR: existing.MP_STATEMENT_DESCRIPTOR || 'HISTORINHAS',
  EMAIL_PROVIDER: existing.EMAIL_PROVIDER || 'auto',
  BREVO_API_KEY: existing.BREVO_API_KEY || '',
  EMAIL_FROM: existing.EMAIL_FROM || args['support-email'] || adminEmail,
  STORY_INTERVAL_DAYS: existing.STORY_INTERVAL_DAYS || '7',
  RENEWAL_REMINDER_DAYS: existing.RENEWAL_REMINDER_DAYS || '3',
  PRICE_MENSAL_CENTS: existing.PRICE_MENSAL_CENTS || '2490',
  PRICE_TRIMESTRAL_CENTS: existing.PRICE_TRIMESTRAL_CENTS || '5990',
  PRICE_ANUAL_CENTS: existing.PRICE_ANUAL_CENTS || '19990',
};

const content = `# Variáveis de produção do Era Uma Vez Eu. NÃO versionar (está no .gitignore).
# PORT, HOSTNAME e DATA_DIR são definidos pelo servidor; não coloque aqui.

NODE_ENV=${values.NODE_ENV}
SITE_NAME=${values.SITE_NAME}
BASE_URL=${values.BASE_URL}
# Aparece no rodapé e nos e-mails como contato
SUPPORT_EMAIL=${values.SUPPORT_EMAIL}

# Painel: ${values.BASE_URL}/admin
ADMIN_EMAIL=${values.ADMIN_EMAIL}
ADMIN_PASSWORD=${values.ADMIN_PASSWORD}
SESSION_SECRET=${values.SESSION_SECRET}

# IA (Groq, plano gratuito): crie a chave em https://console.groq.com/keys
# Sem chave, o site usa histórias de demonstração.
LLM_PROVIDER=${values.LLM_PROVIDER}
LLM_API_KEY=${values.LLM_API_KEY}
LLM_MODEL=${values.LLM_MODEL}

# Pagamento: fake = teste (só o admin logado simula); mercadopago = vendas reais
PAYMENT_PROVIDER=${values.PAYMENT_PROVIDER}
MP_ACCESS_TOKEN=${values.MP_ACCESS_TOKEN}
MP_STATEMENT_DESCRIPTOR=${values.MP_STATEMENT_DESCRIPTOR}

# E-mail (Brevo, grátis até 300/dia). Sem chave, os e-mails ficam em DATA_DIR/outbox.
EMAIL_PROVIDER=${values.EMAIL_PROVIDER}
BREVO_API_KEY=${values.BREVO_API_KEY}
EMAIL_FROM=${values.EMAIL_FROM}

# Produto
STORY_INTERVAL_DAYS=${values.STORY_INTERVAL_DAYS}
RENEWAL_REMINDER_DAYS=${values.RENEWAL_REMINDER_DAYS}
PRICE_MENSAL_CENTS=${values.PRICE_MENSAL_CENTS}
PRICE_TRIMESTRAL_CENTS=${values.PRICE_TRIMESTRAL_CENTS}
PRICE_ANUAL_CENTS=${values.PRICE_ANUAL_CENTS}
`;

// Variáveis extras que já estavam no arquivo (ex.: LLM_BASE_URL, LLM_REVIEW) são mantidas.
const extras = Object.entries(existing).filter(([key]) => !Object.hasOwn(values, key));
const extraBlock = extras.length ? `\n# Outras variáveis\n${extras.map(([k, v]) => `${k}=${v}`).join('\n')}\n` : '';

fs.writeFileSync(file, content + extraBlock, { mode: 0o600 });
console.log(`.env.site ${Object.keys(existing).length ? 'atualizado' : 'criado'}.`);
console.log(`Usuário do painel: ${adminEmail} (senha gerada e gravada em .env.site; não exibida).`);
