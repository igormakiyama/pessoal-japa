// Envio de e-mails (Brevo e outbox) e templates dos e-mails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { loadConfig, paths } from '../src/config.js';
import { htmlToText, sendEmail, sendTemplate } from '../src/mailer.js';
import {
  TEMPLATES, alertaAdmin, historiaPronta, lembreteRenovacao, linkAcesso, pagamentoConfirmado, planoExpirou,
} from '../src/views/emails.js';

const realFetch = globalThis.fetch;
const dirs = [];
const EVIL = '<script>x</script>';
const EVIL_URL = 'https://historias.example/conta/a"><img src=x onerror=alert(1)>';

function configure(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-'));
  dirs.push(dir);
  loadConfig({
    ...process.env,
    DATA_DIR: dir,
    BASE_URL: 'https://historias.example',
    SITE_NAME: 'Era Uma Vez Eu',
    SUPPORT_EMAIL: 'ajuda@example.com',
    EMAIL_FROM: 'envio@example.com',
    EMAIL_PROVIDER: 'outbox',
    BREVO_API_KEY: '',
    STORY_INTERVAL_DAYS: '7',
    ...overrides,
  });
  return dir;
}

function mockFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  return calls;
}

const outboxFiles = () => (fs.existsSync(paths.outbox()) ? fs.readdirSync(paths.outbox()).sort() : []);

beforeEach(() => {
  mock.method(console, 'log', () => {});
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = realFetch;
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

// Contexto de cada template com todos os campos de usuário "maliciosos".
const EVIL_CONTEXTS = {
  pagamento_confirmado: {
    parentName: EVIL, childName: EVIL, paidUntil: '2026-11-05T15:00:00.000Z', first: true, accountUrl: EVIL_URL,
  },
  historia_pronta: { childName: EVIL, title: EVIL, summary: EVIL, storyUrl: EVIL_URL, accountUrl: EVIL_URL },
  lembrete_renovacao: { childName: EVIL, paidUntil: '2026-11-05T15:00:00.000Z', accountUrl: EVIL_URL },
  plano_expirou: { childName: EVIL, accountUrl: EVIL_URL },
  link_acesso: { accountUrl: EVIL_URL },
  alerta_admin: { rows: [{ id: 1, error: EVIL }, { id: 2, error: null }], adminUrl: EVIL_URL },
};

test('htmlToText converte quebras, links e entidades', () => {
  const htmlIn = '<head><style>p{color:red}</style></head><p>Olá, Ana &amp; Bia!</p>'
    + '<p>Linha<br>quebrada<br/>de novo</p>\n\n\n<ul><li>um</li><li>dois</li></ul>'
    + '<a href="https://x.example/conta?a=1&amp;b=2" style="c">Abrir\nconta</a>'
    + '<div>&lt;b&gt; &quot;aspas&quot; &#39;simples&#39; &#x2B50; &amp;lt;</div>';
  const text = htmlToText(htmlIn);
  assert.ok(!text.includes('color:red'));
  assert.ok(!/<[a-z/]/i.test(text.replace('<b>', '')), text);
  assert.match(text, /^Olá, Ana & Bia!\nLinha\nquebrada\nde novo/);
  assert.ok(text.includes('um\ndois'));
  assert.ok(text.includes('Abrir\nconta (https://x.example/conta?a=1&b=2)'));
  assert.ok(text.includes('<b> "aspas" \'simples\' ⭐ &lt;'));
  assert.ok(!/\n\s*\n\s*\n/.test(text), 'linhas em branco repetidas viram uma só');
  assert.equal(htmlToText('  <p>  oi </p>  '), 'oi');
});

test('Brevo: envia pela API HTTP com remetente, resposta e texto puro', async () => {
  configure({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'chave-falsa-de-teste' });
  const calls = mockFetch(() => new Response(JSON.stringify({ messageId: '<1@brevo>' }), { status: 201 }));
  const htmlIn = '<p>Olá!</p><a href="https://historias.example/conta/t">Abrir</a>';
  await sendEmail({ to: 'pai@example.com', subject: 'Assunto de teste', html: htmlIn });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, {
    'api-key': 'chave-falsa-de-teste', 'content-type': 'application/json', accept: 'application/json',
  });
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(init.body), {
    sender: { name: 'Era Uma Vez Eu', email: 'envio@example.com' },
    to: [{ email: 'pai@example.com' }],
    replyTo: { email: 'ajuda@example.com' },
    subject: 'Assunto de teste',
    htmlContent: htmlIn,
    textContent: 'Olá!\nAbrir (https://historias.example/conta/t)',
  });
  assert.deepEqual(outboxFiles(), [], 'com Brevo nada vai para o outbox');
});

test('Brevo: erro da API vira exceção com status e trecho do corpo', async () => {
  configure({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'chave-falsa-de-teste' });
  mockFetch(() => new Response(`{"code":"unauthorized","message":"Key not found"}${'x'.repeat(1000)}`, { status: 401 }));
  await assert.rejects(sendEmail({ to: 'a@example.com', subject: 's', html: '<p>x</p>' }), (err) => {
    assert.match(err.message, /401/);
    assert.match(err.message, /Key not found/);
    assert.ok(err.message.length < 450);
    return true;
  });

  configure({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: '' });
  const calls = mockFetch(() => new Response('{}'));
  await assert.rejects(sendEmail({ to: 'a@example.com', subject: 's', html: '' }), /BREVO_API_KEY/);
  assert.equal(calls.length, 0);
});

test('outbox: grava o e-mail em DATA_DIR/outbox com To/Subject no início', async () => {
  const dir = configure();
  const calls = mockFetch(() => new Response('{}'));
  await sendEmail({ to: 'pai+teste@example.com', subject: 'Bem-vindo(a)! Sua história', html: '<!doctype html><p>corpo</p>' });
  await sendEmail({ to: 'pai+teste@example.com', subject: 'Outro', html: '<p>2</p>' });

  assert.equal(calls.length, 0);
  assert.equal(paths.outbox(), path.join(dir, 'outbox'));
  const files = outboxFiles();
  assert.equal(files.length, 2);
  for (const name of files) assert.match(name, /^\d{8}-\d{6}-pai_teste@example\.com-[0-9a-f]{6}\.html$/);
  const contents = files.map((f) => fs.readFileSync(path.join(paths.outbox(), f), 'utf8'));
  const first = contents.find((c) => c.includes('corpo'));
  assert.ok(first.startsWith('<!--\nTo: pai+teste@example.com\nSubject: Bem-vindo(a)! Sua história\n-->\n'));
  assert.ok(first.endsWith('<!doctype html><p>corpo</p>'));
  assert.equal(console.log.mock.callCount(), 2);
});

test('outbox: assunto com "-->" não fecha o comentário antes da hora', async () => {
  configure();
  await sendEmail({ to: 'a@example.com', subject: 'x --> <b>oi</b>\nBcc: b@example.com', html: '<p>ok</p>' });
  const [name] = outboxFiles();
  const content = fs.readFileSync(path.join(paths.outbox(), name), 'utf8');
  assert.equal(content.indexOf('-->'), content.indexOf('\n-->\n') + 1);
  assert.ok(content.includes('Subject: x --_ _b_oi_/b_ Bcc: b@example.com\n'));
});

test('provedor de e-mail desconhecido dá erro', async () => {
  configure({ EMAIL_PROVIDER: 'smtp' });
  await assert.rejects(sendEmail({ to: 'a@example.com', subject: 's', html: '' }), /EMAIL_PROVIDER desconhecido: smtp/);
});

test('sendTemplate monta o template e envia com o assunto no <title>', async () => {
  configure();
  await sendTemplate('link_acesso', 'pai@example.com', 'Seu link de acesso - Era Uma Vez Eu', {
    accountUrl: 'https://historias.example/conta/tok123',
  });
  const [name] = outboxFiles();
  const content = fs.readFileSync(path.join(paths.outbox(), name), 'utf8');
  assert.ok(content.includes('Subject: Seu link de acesso - Era Uma Vez Eu'));
  assert.ok(content.includes('<title>Seu link de acesso - Era Uma Vez Eu</title>'));
  assert.ok(content.includes('href="https://historias.example/conta/tok123"'));
  assert.ok(content.includes('Entrar na minha conta'));

  await assert.rejects(sendTemplate('nao_existe', 'a@example.com', 's', {}), /Template de e-mail desconhecido/);
  await assert.rejects(sendTemplate('__proto__', 'a@example.com', 's', {}), /Template de e-mail desconhecido/);
});

test('TEMPLATES expõe os 6 e-mails pelo nome usado no código', () => {
  assert.deepEqual(TEMPLATES, {
    pagamento_confirmado: pagamentoConfirmado,
    historia_pronta: historiaPronta,
    lembrete_renovacao: lembreteRenovacao,
    plano_expirou: planoExpirou,
    link_acesso: linkAcesso,
    alerta_admin: alertaAdmin,
  });
});

test('todo template escapa os campos vindos do usuário e usa o layout do site', () => {
  configure({ SITE_NAME: 'Era <Uma> Vez', SUPPORT_EMAIL: 'ajuda@example.com' });
  for (const [name, ctx] of Object.entries(EVIL_CONTEXTS)) {
    const out = TEMPLATES[name](ctx);
    assert.equal(typeof out, 'string', name);
    assert.ok(out.startsWith('<!doctype html>'), name);
    assert.ok(!out.includes('<script>'), `${name} deixou <script> sem escape`);
    assert.ok(!out.includes('<img'), `${name} deixou a URL quebrar o atributo`);
    assert.ok(!out.includes('<Uma>'), `${name} não escapou o nome do site`);
    assert.ok(out.includes('Era &lt;Uma&gt; Vez ⭐'), name);
    assert.ok(out.includes('ajuda@example.com'), name);
    assert.ok(out.includes('href="https://historias.example/conta/a&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'), name);
    if (name !== 'link_acesso') assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'), name);
    assert.ok(out.includes('style="background:#F2785C;'), `${name} sem botão`);
    assert.ok(out.includes('role="presentation"'), `${name} sem layout em tabela`);
  }
});

test('pagamentoConfirmado: primeiro nome, intervalo e data dd/mm/aaaa', () => {
  configure({ STORY_INTERVAL_DAYS: '10' });
  const base = {
    parentName: '  Maria   Clara Souza ', childName: 'Lia', paidUntil: '2026-11-05T15:00:00.000Z',
    accountUrl: 'https://historias.example/conta/t', subject: 'Bem-vindo(a)!',
  };
  const first = pagamentoConfirmado({ ...base, first: true });
  assert.ok(first.includes('<title>Bem-vindo(a)!</title>'));
  assert.ok(first.includes('Olá, Maria!'));
  assert.ok(first.includes('Pagamento confirmado. A primeira história de <b>Lia</b>'));
  assert.ok(first.includes('a cada 10 dias, até 05/11/2026.'));
  assert.ok(!first.includes('Renovação confirmada'));
  assert.ok(first.includes('Abrir minha conta'));

  const renewal = pagamentoConfirmado({ ...base, first: false });
  assert.ok(renewal.includes('Renovação confirmada! As histórias de <b>Lia</b> continuam chegando até 05/11/2026.'));
  assert.ok(!renewal.includes('Pagamento confirmado'));

  assert.ok(pagamentoConfirmado({ ...base, parentName: '', first: true }).includes('<p>Olá!</p>'));
  // Sem assunto, o título é o nome do site
  assert.ok(planoExpirou({ childName: 'Lia', accountUrl: 'u' }).includes('<title>Era Uma Vez Eu</title>'));
});

test('datas saem em dd/mm/aaaa no fuso de Brasília', () => {
  configure();
  const reminder = lembreteRenovacao({ childName: 'Theo', paidUntil: '2026-03-07T12:00:00.000Z', accountUrl: 'u' });
  assert.ok(reminder.includes('vai até <b>07/03/2026</b>'));
  // 01:00 UTC ainda é o dia anterior em Brasília
  const late = lembreteRenovacao({ childName: 'Theo', paidUntil: '2026-11-05T01:00:00.000Z', accountUrl: 'u' });
  assert.ok(late.includes('vai até <b>04/11/2026</b>'));
  const paid = pagamentoConfirmado({
    parentName: 'Ana', childName: 'Theo', paidUntil: '2027-01-02T10:00:00Z', first: false, accountUrl: 'u',
  });
  assert.match(paid, /até 02\/01\/2027\./);
});

test('historiaPronta e alertaAdmin trazem os dados certos', () => {
  configure();
  const story = historiaPronta({
    childName: 'Theo', title: 'O dragão & a lua', summary: 'Uma aventura.',
    storyUrl: 'https://historias.example/h/abc', accountUrl: 'https://historias.example/conta/t',
  });
  assert.ok(story.includes('<h2 style="color:#5B3E96;margin:8px 0;">O dragão &amp; a lua</h2>'));
  assert.ok(story.includes('href="https://historias.example/h/abc"'));
  assert.ok(story.includes('<a href="https://historias.example/conta/t" style="color:#5B3E96;">sua conta</a>'));

  const alert = alertaAdmin({
    rows: [{ id: 3, error: 'e'.repeat(500) }, { id: 4, error: null }], adminUrl: 'https://historias.example/admin',
  });
  assert.ok(alert.includes(`<li>História #3: ${'e'.repeat(300)}</li>`));
  assert.ok(!alert.includes('e'.repeat(301)));
  assert.ok(alert.includes('<li>História #4: </li>'));
  assert.ok(alert.includes('Abrir o painel'));
  assert.ok(alertaAdmin({ rows: [], adminUrl: 'u' }).includes('<ul></ul>'));
});
