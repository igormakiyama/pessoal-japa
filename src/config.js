// Configuração lida das variáveis de ambiente (em produção, do arquivo .env.site).
import path from 'node:path';

export const config = {};

// Valor vazio ("CHAVE=") conta como não definido e usa o padrão.
const str = (env, name, fallback = '') => (env[name] ?? '').toString().trim() || fallback;

// Número inteiro com mínimo; valor inválido usa o padrão (e avisa no log).
const int = (env, name, fallback, min = 0) => {
  const value = str(env, name);
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    console.warn(`Valor inválido em ${name}=${value}; usando ${fallback}.`);
    return fallback;
  }
  return number;
};
const bool = (env, name, fallback) => {
  const value = str(env, name).toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(value);
};

export function loadConfig(env = process.env) {
  const port = int(env, 'PORT', 3000, 1);
  const llmApiKey = str(env, 'LLM_API_KEY');
  const brevoApiKey = str(env, 'BREVO_API_KEY');
  let llmProvider = str(env, 'LLM_PROVIDER', 'auto').toLowerCase();
  if (llmProvider === 'auto') llmProvider = llmApiKey ? 'openai' : 'demo';
  if (llmProvider === 'groq') llmProvider = 'openai';
  let emailProvider = str(env, 'EMAIL_PROVIDER', 'auto').toLowerCase();
  if (emailProvider === 'auto') emailProvider = brevoApiKey ? 'brevo' : 'outbox';

  Object.assign(config, {
    // Servidor (o painel define PORT, HOSTNAME e DATA_DIR)
    port,
    hostname: str(env, 'HOSTNAME', '0.0.0.0'),
    dataDir: path.resolve(str(env, 'DATA_DIR', 'data')),
    production: str(env, 'NODE_ENV') === 'production',

    // Site
    siteName: str(env, 'SITE_NAME', 'Era Uma Vez Eu'),
    baseUrl: str(env, 'BASE_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
    supportEmail: str(env, 'SUPPORT_EMAIL', 'contato@example.com'),

    // Administração
    adminEmail: str(env, 'ADMIN_EMAIL').toLowerCase(),
    adminPassword: str(env, 'ADMIN_PASSWORD'),
    sessionSecret: str(env, 'SESSION_SECRET'),

    // IA de texto: "openai" = qualquer API compatível (padrão: Groq); "demo" = histórias de modelo fixo
    llmProvider,
    llmBaseUrl: str(env, 'LLM_BASE_URL', 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    llmApiKey,
    llmModels: str(env, 'LLM_MODEL', 'llama-3.3-70b-versatile,openai/gpt-oss-120b')
      .split(',').map((m) => m.trim()).filter(Boolean),
    llmReview: bool(env, 'LLM_REVIEW', true),
    llmTimeoutMs: int(env, 'LLM_TIMEOUT_SECONDS', 120, 5) * 1000,

    // Pagamento: "fake" (teste: só o admin consegue simular) ou "mercadopago"
    paymentProvider: str(env, 'PAYMENT_PROVIDER', 'fake').toLowerCase(),
    mpAccessToken: str(env, 'MP_ACCESS_TOKEN'),
    mpStatementDescriptor: str(env, 'MP_STATEMENT_DESCRIPTOR', 'HISTORINHAS'),

    // E-mail: "brevo" (API HTTP, grátis até 300/dia) ou "outbox" (grava em DATA_DIR/outbox)
    emailProvider,
    brevoApiKey,
    emailFrom: str(env, 'EMAIL_FROM', str(env, 'SUPPORT_EMAIL', 'contato@example.com')),

    // Produto
    storyIntervalDays: int(env, 'STORY_INTERVAL_DAYS', 7, 1),
    renewalReminderDays: int(env, 'RENEWAL_REMINDER_DAYS', 3, 0),
    workerIntervalMs: int(env, 'WORKER_INTERVAL_SECONDS', 20, 1) * 1000,
    prices: {
      mensal: int(env, 'PRICE_MENSAL_CENTS', 2490, 100),
      trimestral: int(env, 'PRICE_TRIMESTRAL_CENTS', 5990, 100),
      anual: int(env, 'PRICE_ANUAL_CENTS', 19990, 100),
    },
  });
  return config;
}

export function plans() {
  return {
    mensal: { name: 'Mensal', days: 30, priceCents: config.prices.mensal },
    trimestral: { name: 'Trimestral', days: 90, priceCents: config.prices.trimestral },
    anual: { name: 'Anual', days: 365, priceCents: config.prices.anual },
  };
}

export const paths = {
  store: () => path.join(config.dataDir, 'store.json'),
  stories: () => path.join(config.dataDir, 'stories'),
  storyDir: (id) => path.join(config.dataDir, 'stories', String(id)),
  outbox: () => path.join(config.dataDir, 'outbox'),
};

loadConfig();
