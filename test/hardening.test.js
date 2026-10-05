// Correções vindas da revisão: banco resistente, configuração validada, estornos, fila de e-mails etc.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { config, loadConfig, paths } from '../src/config.js';
import { clientIp } from '../src/http.js';
import { produceStory } from '../src/pipeline.js';
import * as services from '../src/services.js';
import { Store, db } from '../src/store.js';
import { setup } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = {
  name: 'Lia', age: 4, gender: 'menina', appearance: {}, interests: [], interestsExtra: '', themes: [], petType: '', petName: '',
};
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function paidSubscription() {
  setup();
  const { subscription } = services.createSignup('pai@example.com', 'Carlos', CHILD);
  const { order } = await services.createOrder(subscription.id, 'mensal');
  await services.applyPayment(order.token, '111', 'approved', 2490);
  return { order: db().get('orders', order.id), subId: subscription.id };
}

test('banco corrompido abre pela cópia .bak; sem cópia, erro claro', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'store.json');
  const store = new Store(file);
  store.insert('customers', { email: 'a@b.com' });
  store.insert('customers', { email: 'c@d.com' });
  fs.writeFileSync(file, ''); // queda de energia deixou o arquivo vazio
  const recovered = new Store(file);
  assert.equal(recovered.all('customers').length, 1); // estado anterior à última gravação
  fs.writeFileSync(file, '{quebrado');
  fs.writeFileSync(`${file}.bak`, 'também quebrado');
  assert.throws(() => new Store(file), /Restaure um backup/);
});

test('configuração: vazio usa o padrão e número inválido não trava o processo', () => {
  loadConfig({ EMAIL_FROM: '', SUPPORT_EMAIL: 'oi@site.com', PAYMENT_PROVIDER: '', STORY_INTERVAL_DAYS: '0', WORKER_INTERVAL_SECONDS: 'abc', PRICE_MENSAL_CENTS: '-5', LLM_MODEL: '' });
  assert.equal(config.emailFrom, 'oi@site.com');
  assert.equal(config.paymentProvider, 'fake');
  assert.equal(config.storyIntervalDays, 7);
  assert.equal(config.workerIntervalMs, 20000);
  assert.equal(config.prices.mensal, 2490);
  assert.ok(config.llmModels.length >= 1);
});

test('estorno de um pagamento duplicado não tira os dias do pagamento válido', async () => {
  const { order, subId } = await paidSubscription();
  const paidUntil = db().get('subscriptions', subId).paidUntil;
  assert.equal(await services.applyPayment(order.token, '222', 'approved', 2490), 'duplicate');
  assert.equal(await services.applyPayment(order.token, '222', 'refunded', 2490), 'ignored');
  assert.equal(db().get('subscriptions', subId).paidUntil, paidUntil);
  assert.equal(db().get('subscriptions', subId).status, 'active');
  assert.equal(await services.applyPayment(order.token, '111', 'refunded', 2490), 'refunded');
});

test('agendamento depois de muito tempo parado cria uma só história e marca a próxima no futuro', async () => {
  const { subId } = await paidSubscription();
  db().update('subscriptions', subId, { nextStoryAt: new Date(Date.now() - 45 * 86400000).toISOString() });
  assert.equal(services.scheduleDueStories(), 1);
  const next = new Date(db().get('subscriptions', subId).nextStoryAt);
  assert.ok(next > new Date() && next - Date.now() <= 7 * 86400000);
});

test('dados apagados durante a geração: nada é gravado no disco', async () => {
  const { subId } = await paidSubscription();
  services.scheduleDueStories();
  const storyId = services.nextQueuedStory();
  loadConfig({ ...process.env, DATA_DIR: config.dataDir, BASE_URL: config.baseUrl, LLM_PROVIDER: 'groq', LLM_API_KEY: 'k', LLM_MODEL: 'a', LLM_REVIEW: 'false', EMAIL_PROVIDER: 'outbox', PAYMENT_PROVIDER: 'fake' });
  globalThis.fetch = async () => {
    // Enquanto a IA "escreve", o responsável apaga os dados
    services.deleteCustomerData(db().get('subscriptions', subId).customerId);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  };
  assert.equal(await produceStory(storyId), false);
  assert.equal(fs.existsSync(paths.storyDir(storyId)), false);
  assert.equal(db().get('stories', storyId), null);
});

test('fila de e-mails: falha do Brevo tenta de novo com espera e aparece em /saude depois de 3 erros', async () => {
  setup({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'x' });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{"message":"erro"}', { status: 500 });
  };
  const email = services.queueEmail('link_acesso', 'a@b.com', 'Assunto', { accountUrl: 'http://x/conta/t' });
  await services.deliverPendingEmails();
  let row = db().get('emails', email.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(new Date(row.nextAttemptAt) > new Date());
  await services.deliverPendingEmails(); // ainda esperando: não tenta de novo
  assert.equal(calls, 1);
  db().update('emails', email.id, { attempts: 3, nextAttemptAt: new Date(0).toISOString() });
  assert.equal(services.emailProblems().length, 1);
  globalThis.fetch = async () => new Response('{}', { status: 201 });
  await services.deliverPendingEmails();
  row = db().get('emails', email.id);
  assert.equal(row.status, 'sent');
  assert.equal(services.emailProblems().length, 0);
});

test('faxina remove e-mails antigos e pastas de histórias órfãs', async () => {
  setup();
  const old = db().insert('emails', { status: 'sent', createdAt: new Date(Date.now() - 40 * 86400000).toISOString() });
  const recent = db().insert('emails', { status: 'sent', createdAt: new Date().toISOString() });
  fs.mkdirSync(paths.storyDir(999), { recursive: true });
  services.housekeeping();
  assert.equal(db().get('emails', old.id), null);
  assert.ok(db().get('emails', recent.id));
  assert.equal(fs.existsSync(paths.storyDir(999)), false);
});

test('IP do visitante vem do fim do X-Forwarded-For (o começo é falsificável)', () => {
  const req = (xff) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(clientIp(req('1.1.1.1, 9.9.9.9')), '9.9.9.9');
  assert.equal(clientIp(req('9.9.9.9')), '9.9.9.9');
  assert.equal(clientIp(req('')), '127.0.0.1');
});

test('setup-env: cria segredos sem mostrar e, ao rodar de novo, preserva o que já existia', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  const run = (...args) => execFileSync(process.execPath, ['scripts/setup-env.js', ...args], { cwd: dir, encoding: 'utf8' });
  const out = run('--admin-email=Dono@Exemplo.com', '--base-url=https://teste.metodoim.com.br/');
  const env = fs.readFileSync(path.join(dir, '.env.site'), 'utf8');
  const password = /^ADMIN_PASSWORD=(.+)$/m.exec(env)[1];
  assert.ok(password.length >= 20);
  assert.ok(!out.includes(password));
  assert.match(env, /^ADMIN_EMAIL=dono@exemplo\.com$/m);
  assert.match(env, /^BASE_URL=https:\/\/teste\.metodoim\.com\.br$/m);
  fs.writeFileSync(path.join(dir, '.env.site'), env.replace('SITE_NAME=Era Uma Vez Eu', 'SITE_NAME=Outro Nome') + 'LLM_REVIEW=false\n');
  run('--admin-email=novo@exemplo.com');
  const again = fs.readFileSync(path.join(dir, '.env.site'), 'utf8');
  assert.match(again, new RegExp(`^ADMIN_PASSWORD=${password.replace(/[-]/g, '\\-')}$`, 'm'));
  assert.match(again, /^SITE_NAME=Outro Nome$/m);
  assert.match(again, /^LLM_REVIEW=false$/m);
  assert.match(again, /^ADMIN_EMAIL=novo@exemplo\.com$/m);
});

test('pagamento ou estorno depois de apagar os dados não reativa nada e avisa o admin', async () => {
  setup();
  const { subscription, customer } = services.createSignup('pai@example.com', 'Carlos', CHILD);
  const { order } = await services.createOrder(subscription.id, 'mensal');
  services.deleteCustomerData(customer.id);
  assert.equal(db().get('orders', order.id).status, 'canceled');
  assert.equal(await services.applyPayment(order.token, '9', 'approved', 2490), 'paid_after_delete');
  assert.equal(db().get('subscriptions', subscription.id).status, 'canceled');
  assert.equal(services.scheduleDueStories(), 0);
  await services.deliverPendingEmails();
  assert.ok(db().all('emails').some((e) => e.template === 'alerta_admin' && e.to === 'admin@example.com'));
  assert.equal(await services.applyPayment(order.token, '9', 'refunded', 2490), 'ignored');
  assert.equal(db().get('subscriptions', subscription.id).status, 'canceled');
});

test('renovar depois de vencer não manda o e-mail de primeira compra', async () => {
  const { subId } = await paidSubscription();
  db().update('subscriptions', subId, { paidUntil: new Date(Date.now() - 60000).toISOString() });
  services.expireAndRemind();
  const { order } = await services.createOrder(subId, 'mensal');
  await services.applyPayment(order.token, '333', 'approved', 2490);
  await services.deliverPendingEmails();
  const confirmations = db().all('emails').filter((e) => e.template === 'pagamento_confirmado');
  assert.equal(confirmations.length, 2);
  assert.equal(confirmations[1].ctx.first, false);
});

test('história adiada muitas vezes pelo limite da IA gera alerta para o admin', async () => {
  setup();
  const story = db().insert('stories', { token: 't', subscriptionId: 1, childId: 1, status: 'queued', attempts: 0, deferrals: 8, error: 'HTTP 429', adminAlerted: false });
  services.alertAdminFailures();
  assert.equal(db().get('stories', story.id).deferralAlerted, true);
  // Se depois falhar de vez, o admin recebe um segundo aviso (falha definitiva)
  db().update('stories', story.id, { status: 'failed', attempts: 3 });
  services.alertAdminFailures();
  assert.equal(db().get('stories', story.id).adminAlerted, true);
  await services.deliverPendingEmails();
  assert.ok(db().all('emails').some((e) => e.template === 'alerta_admin'));
});

test('banco: queda entre os dois renames abre pelo temporário; restos e arquivo corrompido não ficam no caminho', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'store.json');
  const store = new Store(file);
  store.insert('customers', { email: 'a@b.com' });
  // Simula a queda: principal já virou .bak e o temporário completo ainda não foi renomeado
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...store.data, customers: [...store.data.customers, { id: 2, email: 'c@d.com' }] }));
  fs.renameSync(file, `${file}.bak`);
  fs.writeFileSync(`${file}.12345.tmp`, 'resto de versão antiga');
  const reopened = new Store(file);
  assert.equal(reopened.all('customers').length, 2);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  reopened.insert('customers', { email: 'e@f.com' }); // agora o .bak guarda a versão com 2 clientes
  fs.writeFileSync(file, '{quebrado');
  const again = new Store(file);
  assert.equal(again.all('customers').length, 2);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('store.json.corrompido-')));
  assert.ok(Store.read(`${file}.bak`), 'a cópia boa não pode ser sobrescrita pelo arquivo corrompido');
});

test('PORT fora da faixa usa o padrão em vez de derrubar o processo', () => {
  loadConfig({ PORT: '70000' });
  assert.equal(config.port, 3000);
});

test('pagamento duplicado fica registrado no pedido e avisa o admin', async () => {
  const { order } = await paidSubscription();
  await services.applyPayment(order.token, '222', 'approved', 2490);
  await services.applyPayment(order.token, '222', 'approved', 2490);
  assert.deepEqual(db().get('orders', order.id).duplicatePayments, ['222']);
  await services.deliverPendingEmails();
  assert.equal(db().all('emails').filter((e) => e.template === 'alerta_admin').length, 1);
});

test('e-mails: quando o Brevo volta, os que desistiram e os que esperavam saem logo', async () => {
  setup({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'x' });
  const failedOld = db().insert('emails', { template: 'link_acesso', to: 'a@b.com', subject: 'A', ctx: { accountUrl: 'u' }, status: 'failed', attempts: 8, nextAttemptAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  const waiting = db().insert('emails', { template: 'link_acesso', to: 'c@d.com', subject: 'B', ctx: { accountUrl: 'u' }, status: 'pending', attempts: 5, nextAttemptAt: new Date(Date.now() + 6 * 3600000).toISOString(), createdAt: new Date().toISOString() });
  assert.equal(services.emailProblems().length, 2);
  const sentTo = [];
  globalThis.fetch = async (url, init) => {
    sentTo.push(JSON.parse(init.body).to[0].email);
    return new Response('{}', { status: 201 });
  };
  services.queueEmail('link_acesso', 'e@f.com', 'C', { accountUrl: 'u' });
  await services.deliverPendingEmails();
  assert.deepEqual(sentTo.sort(), ['a@b.com', 'c@d.com', 'e@f.com']);
  assert.equal(db().get('emails', failedOld.id).status, 'sent');
  assert.equal(db().get('emails', waiting.id).status, 'sent');
  assert.equal(services.emailProblems().length, 0);
});

test('LGPD: apagar os dados no meio de um lote de e-mails impede os envios que faltavam', async () => {
  setup({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'x' });
  const { customer } = services.createSignup('mae@example.com', 'Ana', CHILD);
  db().insert('emails', { template: 'link_acesso', to: 'outro@example.com', subject: 'A', ctx: { accountUrl: 'u' }, status: 'pending', attempts: 0, nextAttemptAt: new Date(0).toISOString(), createdAt: new Date().toISOString() });
  db().insert('emails', { template: 'link_acesso', to: 'mae@example.com', subject: 'B', ctx: { accountUrl: 'u' }, status: 'pending', attempts: 0, nextAttemptAt: new Date(0).toISOString(), createdAt: new Date().toISOString() });
  const sentTo = [];
  globalThis.fetch = async (url, init) => {
    sentTo.push(JSON.parse(init.body).to[0].email);
    services.deleteCustomerData(customer.id); // o responsável apaga tudo enquanto o primeiro e-mail sai
    return new Response('{}', { status: 201 });
  };
  await services.deliverPendingEmails();
  assert.deepEqual(sentTo, ['outro@example.com']);
});
