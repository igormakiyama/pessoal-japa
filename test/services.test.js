// Regras de pagamento, renovação, reembolso, lembretes e agendamento.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { config } from '../src/config.js';
import * as services from '../src/services.js';
import { db } from '../src/store.js';
import { outbox, postForm, setup, startServer } from './helpers.js';

const CHILD = {
  name: 'Lia', age: 4, gender: 'menina', appearance: {}, interests: [], interestsExtra: '', themes: [], petType: '', petName: '',
};

const realFetch = globalThis.fetch;

beforeEach(() => setup());
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function makeOrder(plan = 'mensal') {
  const { subscription } = services.createSignup('pai@example.com', 'Carlos', CHILD);
  const { order } = await services.createOrder(subscription.id, plan);
  return { order, subId: subscription.id };
}

test('aplicar pagamento é idempotente e manda boas-vindas uma vez', async () => {
  const { order, subId } = await makeOrder();
  assert.equal(await services.applyPayment(order.token, '1', 'approved', 2490), 'activated');
  const first = db().get('subscriptions', subId).paidUntil;
  assert.equal(await services.applyPayment(order.token, '1', 'approved', 2490), 'ignored');
  assert.equal(db().get('subscriptions', subId).paidUntil, first);
  await services.deliverPendingEmails();
  assert.equal(outbox().filter((m) => m.includes('Bem-vindo')).length, 1);
});

test('valor menor que o pedido é recusado', async () => {
  const { order, subId } = await makeOrder();
  assert.equal(await services.applyPayment(order.token, '1', 'approved', 100), 'amount_mismatch');
  assert.equal(db().get('subscriptions', subId).status, 'pending');
});

test('reembolso tira os dias pagos', async () => {
  const { order, subId } = await makeOrder();
  await services.applyPayment(order.token, '1', 'approved', 2490);
  assert.equal(await services.applyPayment(order.token, '1', 'refunded', 2490), 'refunded');
  assert.equal(db().get('subscriptions', subId).status, 'expired');
});

test('renovação soma a partir do fim do período atual', async () => {
  const { order, subId } = await makeOrder();
  await services.applyPayment(order.token, '1', 'approved', 2490);
  const end1 = new Date(db().get('subscriptions', subId).paidUntil);
  const { order: order2 } = await services.createOrder(subId, 'trimestral');
  await services.applyPayment(order2.token, '2', 'approved', 5990);
  const end2 = new Date(db().get('subscriptions', subId).paidUntil);
  assert.equal(Math.round((end2 - end1) / 86400000), 90);
  await services.deliverPendingEmails();
  assert.ok(outbox().some((m) => m.includes('Assinatura renovada')));
});

test('lembrete uma vez, depois expira e para de agendar', async () => {
  const { order, subId } = await makeOrder();
  await services.applyPayment(order.token, '1', 'approved', 2490);
  db().update('subscriptions', subId, { paidUntil: new Date(Date.now() + 2 * 86400000).toISOString() });
  await services.expireAndRemind();
  await services.expireAndRemind();
  await services.deliverPendingEmails();
  assert.equal(outbox().filter((m) => m.includes('acabam em breve')).length, 1);
  db().update('subscriptions', subId, { paidUntil: new Date(Date.now() - 60000).toISOString() });
  await services.expireAndRemind();
  await services.deliverPendingEmails();
  assert.equal(db().get('subscriptions', subId).status, 'expired');
  assert.ok(outbox().some((m) => m.includes('Sentimos sua falta')));
  assert.equal(services.scheduleDueStories(), 0);
});

test('agendamento cria uma história por vez e empurra a próxima data', async () => {
  const { order, subId } = await makeOrder();
  await services.applyPayment(order.token, '1', 'approved', 2490);
  assert.equal(services.scheduleDueStories(), 1);
  assert.equal(services.scheduleDueStories(), 0);
  const next = new Date(db().get('subscriptions', subId).nextStoryAt);
  assert.ok(next - Date.now() > 6 * 86400000);
});

test('história presa em "gerando" volta para a fila; falha tenta de novo até 3 vezes', () => {
  const store = db();
  const old = new Date(Date.now() - 2 * 3600000).toISOString();
  const a = store.insert('stories', { token: 'a', subscriptionId: 1, childId: 1, status: 'generating', attempts: 1, startedAt: old });
  const b = store.insert('stories', { token: 'b', subscriptionId: 1, childId: 1, status: 'failed', attempts: 2, startedAt: old });
  const c = store.insert('stories', { token: 'c', subscriptionId: 1, childId: 1, status: 'failed', attempts: 3, startedAt: old });
  services.recoverAndRetry();
  assert.equal(store.get('stories', a.id).status, 'queued');
  assert.equal(store.get('stories', b.id).status, 'queued');
  assert.equal(store.get('stories', c.id).status, 'failed');
});

test('com Mercado Pago ligado e IA em demonstração, as vendas ficam bloqueadas', async () => {
  setup({ PAYMENT_PROVIDER: 'mercadopago', MP_ACCESS_TOKEN: 'TEST-123' });
  const { subscription } = services.createSignup('mp@example.com', 'Maria', CHILD);
  await assert.rejects(services.createOrder(subscription.id, 'mensal'), /modo demonstração/);
});

test('webhook do Mercado Pago reconsulta o pagamento na API (corpo forjado não vale)', async () => {
  setup({ PAYMENT_PROVIDER: 'mercadopago', MP_ACCESS_TOKEN: 'TEST-123', LLM_PROVIDER: 'groq', LLM_API_KEY: 'k' });
  const srv = await startServer();
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.mercadopago.com/checkout/preferences')) {
      requests.push({ url: u, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'pref-1', init_point: 'https://mp.example/checkout' }), { status: 201 });
    }
    if (u.startsWith('https://api.mercadopago.com/v1/payments/')) {
      requests.push({ url: u });
      const order = db().all('orders')[0];
      return new Response(JSON.stringify({ id: 123, status: 'approved', external_reference: order.token, transaction_amount: 24.9 }));
    }
    return realFetch(url, init);
  };
  try {
    const { subscription } = services.createSignup('mp@example.com', 'Maria', CHILD);
    const { url } = await services.createOrder(subscription.id, 'mensal');
    assert.equal(url, 'https://mp.example/checkout');
    assert.equal(requests[0].body.external_reference, db().all('orders')[0].token);
    assert.equal(requests[0].body.notification_url, `${config.baseUrl}/webhooks/mercadopago`);

    const res = await realFetch(`${srv.base}/webhooks/mercadopago?data.id=123&type=payment`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'payment', data: { id: '123' }, status: 'approved' }),
    });
    assert.equal(res.status, 200);
    assert.ok(requests.some((r) => r.url.endsWith('/v1/payments/123')));
    assert.equal(db().get('subscriptions', subscription.id).status, 'active');

    const ignored = await realFetch(`${srv.base}/webhooks/mercadopago`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'merchant_order', data: { id: '9' } }),
    });
    assert.equal((await ignored.json()).ignored, true);
  } finally {
    await srv.close();
  }
});

test('modo fake: rota de teste some quando o Mercado Pago está ligado', async () => {
  setup({ PAYMENT_PROVIDER: 'mercadopago', MP_ACCESS_TOKEN: 'TEST-123' });
  const srv = await startServer();
  try {
    assert.equal((await realFetch(`${srv.base}/checkout-teste/qualquer`)).status, 404);
    assert.equal((await postForm(srv.base, '/checkout-teste/qualquer', {})).status, 404);
  } finally {
    await srv.close();
  }
});

test('limite da IA adia a história sem gastar tentativa', async () => {
  const { produceStory, RETRY_DELAY_MINUTES } = await import('../src/pipeline.js');
  const { loadConfig } = await import('../src/config.js');
  const { order, subId } = await makeOrder();
  await services.applyPayment(order.token, '1', 'approved', 2490);
  services.scheduleDueStories();
  loadConfig({ ...process.env, DATA_DIR: config.dataDir, BASE_URL: config.baseUrl, LLM_PROVIDER: 'groq', LLM_API_KEY: 'k', LLM_MODEL: 'a,b', LLM_REVIEW: 'false', EMAIL_PROVIDER: 'outbox', PAYMENT_PROVIDER: 'fake' });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 });
  };
  const storyId = services.nextQueuedStory();
  assert.equal(await produceStory(storyId), false);
  const story = db().get('stories', storyId);
  assert.equal(story.status, 'queued');
  assert.equal(story.attempts, 0);
  assert.ok(new Date(story.retryAt) - Date.now() > (RETRY_DELAY_MINUTES - 1) * 60000);
  assert.equal(services.nextQueuedStory(), null);
  assert.ok(calls >= 2);
  assert.equal(db().get('subscriptions', subId).status, 'active');
});
