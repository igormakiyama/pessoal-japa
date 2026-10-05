// Checkout do Mercado Pago, consultas de pagamento e normalização do status.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  PaymentError, createCheckout, fetchPayment, normalize, searchPayments,
} from '../src/payments.js';

const realFetch = globalThis.fetch;
const dirs = [];

const ORDER = { token: 'tok-abc', plan: 'mensal', amountCents: 2490, days: 30 };
const CUSTOMER = { email: 'pai@example.com', parentName: 'Carlos Souza' };
const PLAN = { name: 'Mensal', days: 30, priceCents: 2490 };

function configure(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-'));
  dirs.push(dir);
  loadConfig({
    ...process.env,
    DATA_DIR: dir,
    BASE_URL: 'https://historias.example/',
    SITE_NAME: 'Era Uma Vez Eu',
    PAYMENT_PROVIDER: 'mercadopago',
    MP_ACCESS_TOKEN: 'TEST-token-falso',
    MP_STATEMENT_DESCRIPTOR: 'HISTORINHAS-PERSONALIZADAS',
    ...overrides,
  });
}

// Troca o fetch global por um falso que registra as chamadas.
function mockFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  return calls;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
});

afterEach(() => {
  globalThis.fetch = realFetch;
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

test('modo fake devolve a página de teste e não chama a API', async () => {
  configure({ PAYMENT_PROVIDER: 'fake', MP_ACCESS_TOKEN: '' });
  const calls = mockFetch(() => json({}));
  const result = await createCheckout(ORDER, CUSTOMER, PLAN);
  assert.deepEqual(result, { url: 'https://historias.example/checkout-teste/tok-abc', ref: null });
  assert.equal(calls.length, 0);
});

test('Mercado Pago: monta a preferência igual à versão Python', async () => {
  configure();
  const calls = mockFetch(() => json({ id: 'pref-123', init_point: 'https://mp.example/checkout/pref-123' }, 201));
  const result = await createCheckout(ORDER, CUSTOMER, PLAN);
  assert.deepEqual(result, { url: 'https://mp.example/checkout/pref-123', ref: 'pref-123' });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.mercadopago.com/checkout/preferences');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer TEST-token-falso');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.ok(init.signal instanceof AbortSignal);

  const back = 'https://historias.example/obrigado/tok-abc';
  assert.deepEqual(JSON.parse(init.body), {
    items: [{
      id: 'mensal',
      title: 'Era Uma Vez Eu - Plano Mensal (30 dias)',
      quantity: 1,
      currency_id: 'BRL',
      unit_price: 24.9,
    }],
    payer: { email: 'pai@example.com', name: 'Carlos Souza' },
    external_reference: 'tok-abc',
    notification_url: 'https://historias.example/webhooks/mercadopago',
    back_urls: { success: back, pending: back, failure: back },
    auto_return: 'approved',
    statement_descriptor: 'HISTORINHAS-P',
  });
});

test('unit_price em reais com 2 casas e descritor curto fica inteiro', async () => {
  configure({ MP_STATEMENT_DESCRIPTOR: 'CURTO' });
  const calls = mockFetch(() => json({ id: 'p', init_point: 'https://mp.example/c' }));
  for (const [cents, price] of [[1999, 19.99], [5990, 59.9], [19990, 199.9], [100, 1]]) {
    await createCheckout({ ...ORDER, amountCents: cents }, CUSTOMER, PLAN);
    const body = JSON.parse(calls.at(-1).init.body);
    assert.equal(body.items[0].unit_price, price);
    assert.equal(body.statement_descriptor, 'CURTO');
  }
});

test('sem token do Mercado Pago dá PaymentError antes de chamar a API', async () => {
  configure({ MP_ACCESS_TOKEN: '' });
  const calls = mockFetch(() => json({}));
  await assert.rejects(createCheckout(ORDER, CUSTOMER, PLAN), (err) => {
    assert.ok(err instanceof PaymentError);
    assert.match(err.message, /MP_ACCESS_TOKEN/);
    return true;
  });
  await assert.rejects(fetchPayment('1'), PaymentError);
  await assert.rejects(searchPayments('tok'), PaymentError);
  assert.equal(calls.length, 0);
});

test('resposta de erro do Mercado Pago vira PaymentError com trecho do corpo', async () => {
  configure();
  mockFetch(() => new Response(`{"message":"invalid token"}${'x'.repeat(1000)}`, { status: 401 }));
  await assert.rejects(createCheckout(ORDER, CUSTOMER, PLAN), (err) => {
    assert.ok(err instanceof PaymentError);
    assert.equal(err.name, 'PaymentError');
    assert.match(err.message, /401/);
    assert.match(err.message, /invalid token/);
    assert.ok(err.message.length < 450, 'o trecho do corpo deve ser curto');
    return true;
  });
});

test('checkout sem init_point, falha de rede e provedor desconhecido dão PaymentError', async () => {
  configure();
  mockFetch(() => json({ id: 'pref-sem-link' }));
  await assert.rejects(createCheckout(ORDER, CUSTOMER, PLAN), PaymentError);

  mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(createCheckout(ORDER, CUSTOMER, PLAN), (err) => err instanceof PaymentError && /fetch failed/.test(err.message));

  configure({ PAYMENT_PROVIDER: 'pagseguro' });
  await assert.rejects(createCheckout(ORDER, CUSTOMER, PLAN), (err) => err instanceof PaymentError && /pagseguro/.test(err.message));
});

test('fetchPayment consulta o pagamento pelo ID com o token', async () => {
  configure();
  const calls = mockFetch(() => json({ id: 123, status: 'approved' }));
  assert.deepEqual(await fetchPayment('123'), { id: 123, status: 'approved' });
  assert.equal(calls[0].url, 'https://api.mercadopago.com/v1/payments/123');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer TEST-token-falso');
  assert.equal(calls[0].init.body, undefined);
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  mockFetch(() => new Response('not found', { status: 404 }));
  await assert.rejects(fetchPayment('999'), (err) => err instanceof PaymentError && /404/.test(err.message));
});

test('searchPayments busca pela referência do pedido, mais recentes primeiro', async () => {
  configure();
  const calls = mockFetch(() => json({ results: [{ id: 2 }, { id: 1 }], paging: { total: 2 } }));
  assert.deepEqual(await searchPayments('tok abc&x'), [{ id: 2 }, { id: 1 }]);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.mercadopago.com/v1/payments/search');
  assert.equal(url.searchParams.get('external_reference'), 'tok abc&x');
  assert.equal(url.searchParams.get('sort'), 'date_created');
  assert.equal(url.searchParams.get('criteria'), 'desc');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer TEST-token-falso');

  mockFetch(() => json({}));
  assert.deepEqual(await searchPayments('tok'), []);

  mockFetch(() => new Response('erro', { status: 500 }));
  await assert.rejects(searchPayments('tok'), PaymentError);
});

test('normalize traduz o status e converte o valor para centavos', () => {
  const cases = {
    approved: 'approved',
    refunded: 'refunded',
    charged_back: 'refunded',
    rejected: 'rejected',
    cancelled: 'rejected',
    pending: 'pending',
    in_process: 'pending',
    authorized: 'pending',
    constructor: 'pending',
    '': 'pending',
  };
  for (const [status, expected] of Object.entries(cases)) {
    assert.equal(normalize({ id: 1, status }).status, expected, status);
  }
  assert.deepEqual(normalize({ id: 123, status: 'approved', external_reference: 'tok', transaction_amount: 24.9 }), {
    paymentId: '123', orderToken: 'tok', status: 'approved', amountCents: 2490,
  });
  assert.equal(normalize({ id: 1, transaction_amount: 59.9 }).amountCents, 5990);
  assert.equal(normalize({ id: 1, transaction_amount: '199.90' }).amountCents, 19990);
  assert.deepEqual(normalize({ id: 7, external_reference: null }), {
    paymentId: '7', orderToken: '', status: 'pending', amountCents: 0,
  });
});
