import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { config, loadConfig, paths } from '../src/config.js';
import { openStore } from '../src/store.js';

export const ADMIN = { email: 'admin@example.com', password: 'senha-de-teste-123' };

export function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'euve-'));
  loadConfig({
    ...process.env,
    DATA_DIR: dir,
    BASE_URL: 'http://127.0.0.1:9',
    LLM_PROVIDER: 'demo',
    LLM_API_KEY: '',
    PAYMENT_PROVIDER: 'fake',
    EMAIL_PROVIDER: 'outbox',
    BREVO_API_KEY: '',
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    SESSION_SECRET: 'segredo-de-sessao-de-teste-com-tamanho-bom',
    ...overrides,
  });
  openStore(paths.store());
  return dir;
}

export async function startServer() {
  const { createHandler } = await import('../src/web.js');
  const server = http.createServer(createHandler());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.baseUrl = base;
  return { server, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

export function outbox() {
  const dir = paths.outbox();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
}

// Envia um formulário como o navegador faria (mesma origem).
export function postForm(base, url, data, headers = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    for (const v of [].concat(value)) body.append(key, v);
  }
  return fetch(base + url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...headers },
    body,
  });
}

export const CHILD_FORM = {
  child_name: 'Theo',
  age: '5',
  gender: 'menino',
  skin: 'media',
  hair_style: 'cacheado',
  hair_color: 'castanho',
  eyes: 'verdes',
  glasses: '1',
  fav_color: 'verde',
  pet_type: 'gato',
  pet_name: 'Bolinha',
  interests: ['dinossauros', 'espaço e foguetes'],
  interests_extra: 'adora panqueca',
  themes: ['coragem', 'amizade'],
};

export async function adminCookie(base) {
  const res = await postForm(base, '/admin/login', { email: ADMIN.email, password: ADMIN.password, next: '/admin' });
  return res.headers.get('set-cookie').split(';')[0];
}
