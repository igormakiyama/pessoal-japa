// Regras do negócio, usadas pelo site e pelo worker.
import fs from 'node:fs';

import { config, paths, plans } from './config.js';
import { sendTemplate } from './mailer.js';
import { PaymentError, createCheckout, normalize, searchPayments } from './payments.js';
import { removeStoryFiles } from './pipeline.js';
import { db } from './store.js';
import { newToken, nowIso, parseIso, plusDays } from './util.js';

const DAY = 86400000;
const MINUTE = 60000;

// ---------------------------------------------------------------- fila de e-mails
// Todo e-mail entra numa fila no banco e é enviado em seguida; se o envio falhar
// (Brevo fora do ar, chave errada...), tenta de novo com espera crescente.

const EMAIL_BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720];
const EMAIL_MAX_ATTEMPTS = EMAIL_BACKOFF_MINUTES.length + 1;
let deliveryRun = null;
let rerun = false;

export function queueEmail(template, to, subject, ctx) {
  const email = db().insert('emails', {
    template, to, subject, ctx, status: 'pending', attempts: 0, nextAttemptAt: nowIso(),
    lastError: null, createdAt: nowIso(), sentAt: null,
  });
  deliverPendingEmails().catch((err) => console.error('Falha na fila de e-mails:', err.message));
  return email;
}

async function deliverDue(limit) {
  const store = db();
  const now = nowIso();
  const due = store.filter('emails', (e) => e.status === 'pending' && e.nextAttemptAt <= now)
    .sort((a, b) => a.id - b.id).slice(0, limit);
  let sent = 0;
  for (const email of due) {
    try {
      await sendTemplate(email.template, email.to, email.subject, email.ctx);
      store.update('emails', email.id, { status: 'sent', sentAt: nowIso(), lastError: null });
      sent += 1;
    } catch (err) {
      const attempts = email.attempts + 1;
      const giveUp = attempts >= EMAIL_MAX_ATTEMPTS;
      console.error(`E-mail ${email.id} (${email.template}) falhou na tentativa ${attempts}: ${err.message}`);
      store.update('emails', email.id, {
        attempts,
        status: giveUp ? 'failed' : 'pending',
        lastError: String(err.message || err).slice(0, 500),
        nextAttemptAt: new Date(Date.now() + (EMAIL_BACKOFF_MINUTES[attempts - 1] || 720) * MINUTE).toISOString(),
      });
    }
  }
  return sent;
}

// Envia os e-mails da fila. Uma entrega por vez; o que entrar no meio sai na mesma rodada.
export function deliverPendingEmails(limit = 20) {
  if (deliveryRun) {
    rerun = true;
    return deliveryRun;
  }
  deliveryRun = (async () => {
    let sent = 0;
    do {
      rerun = false;
      sent += await deliverDue(limit);
    } while (rerun);
    return sent;
  })().finally(() => {
    deliveryRun = null;
  });
  return deliveryRun;
}

// E-mails com problema: falharam de vez ou já erraram 3 vezes seguidas.
export function emailProblems() {
  return db().filter('emails', (e) => e.status === 'failed' || (e.status === 'pending' && e.attempts >= 3));
}

// ---------------------------------------------------------------- cadastro e pedidos

export function findCustomerByEmail(email) {
  return db().find('customers', (c) => c.email === email && !c.deletedAt);
}

export function findCustomerByToken(token) {
  return db().find('customers', (c) => c.token === token && !c.deletedAt);
}

export function createSignup(email, parentName, child) {
  const store = db();
  return store.transaction(() => {
    let customer = findCustomerByEmail(email);
    if (!customer) {
      customer = store.insert('customers', {
        email, parentName, token: newToken(), consentAt: nowIso(), createdAt: nowIso(), deletedAt: null,
      });
    }
    const childRow = store.insert('children', {
      customerId: customer.id, ...child, createdAt: nowIso(), updatedAt: nowIso(),
    });
    const subscription = store.insert('subscriptions', {
      customerId: customer.id, childId: childRow.id, status: 'pending', paidUntil: null, nextStoryAt: null,
      remindersEnabled: true, reminderSentFor: null, createdAt: nowIso(),
    });
    return { customer, child: childRow, subscription };
  });
}

export function updateChild(childId, child) {
  db().update('children', childId, { ...child, updatedAt: nowIso() });
}

// Cria o pedido e o checkout. Devolve { order, url }.
export async function createOrder(subscriptionId, planKey) {
  const store = db();
  const plan = plans()[planKey];
  if (config.paymentProvider === 'mercadopago' && config.llmProvider === 'demo') {
    throw new PaymentError('Vendas bloqueadas: a IA está em modo demonstração (falta LLM_API_KEY no .env.site).');
  }
  const subscription = store.get('subscriptions', subscriptionId);
  const customer = store.get('customers', subscription.customerId);
  const order = store.insert('orders', {
    token: newToken(), subscriptionId, plan: planKey, days: plan.days, amountCents: plan.priceCents,
    status: 'pending', provider: config.paymentProvider, providerRef: null, paymentId: null,
    createdAt: nowIso(), paidAt: null,
  });
  const { url, ref } = await createCheckout(order, customer, plan);
  if (ref) store.update('orders', order.id, { providerRef: ref });
  return { order, url };
}

// Aplica o status de um pagamento ao pedido. Idempotente: o mesmo aviso pode chegar várias vezes.
// Roda de forma síncrona (sem await no meio), então não há corrida entre webhook e conciliação.
export function applyPaymentSync(orderToken, paymentId, status, amountCents) {
  const store = db();
  const order = store.find('orders', (o) => o.token === orderToken);
  if (!order) {
    console.warn(`Pagamento ${paymentId} com referência desconhecida: ${orderToken}`);
    return { outcome: 'unknown_order' };
  }
  const sub = store.get('subscriptions', order.subscriptionId);
  const customer = store.get('customers', sub.customerId);

  // Dados apagados (LGPD): o pagamento fica registrado, mas nada é reativado. O admin é avisado para estornar.
  if (sub.status === 'canceled' || customer.deletedAt) {
    if (status === 'approved' && order.status !== 'approved') {
      store.update('orders', order.id, { status: 'approved', paymentId, paidAt: nowIso(), note: 'pago depois de apagar os dados: estornar' });
      if (config.adminEmail) {
        queueEmail('alerta_admin', config.adminEmail, `[${config.siteName}] Pagamento recebido de conta apagada`, {
          rows: [{ id: order.id, error: `Pedido ${order.id} (pagamento ${paymentId}) foi pago depois que o cliente apagou os dados. Faça o estorno no Mercado Pago.` }],
          adminUrl: `${config.baseUrl}/admin`,
        });
      }
      return { outcome: 'paid_after_delete' };
    }
    if (status === 'refunded' && order.status === 'approved') store.update('orders', order.id, { status: 'refunded' });
    return { outcome: 'ignored' };
  }

  if (status === 'approved' && (order.status === 'pending' || order.status === 'rejected')) {
    if (amountCents + 1 < order.amountCents) {
      console.error(`Pagamento ${paymentId} com valor menor que o pedido ${orderToken}`);
      return { outcome: 'amount_mismatch' };
    }
    const now = new Date();
    const current = parseIso(sub.paidUntil);
    const base = current && current > now ? current : now;
    const wasActive = sub.status === 'active';
    const paidBefore = store.find('orders', (o) => o.subscriptionId === sub.id && o.id !== order.id
      && (o.status === 'approved' || o.status === 'refunded'));
    store.transaction(() => {
      store.update('orders', order.id, { status: 'approved', paymentId, paidAt: nowIso() });
      store.update('subscriptions', sub.id, {
        status: 'active',
        paidUntil: plusDays(order.days, base),
        nextStoryAt: wasActive && sub.nextStoryAt ? sub.nextStoryAt : now.toISOString(),
        remindersEnabled: true,
      });
    });
    return { outcome: 'activated', orderId: order.id, first: !paidBefore };
  }

  if (status === 'refunded' && order.status === 'approved' && paymentId !== order.paymentId) {
    // Ex.: o cliente pagou duas vezes o mesmo checkout e o segundo pagamento foi estornado.
    console.warn(`Estorno do pagamento ${paymentId} ignorado: o pedido ${orderToken} foi pago pelo ${order.paymentId}.`);
    return { outcome: 'ignored' };
  }

  if (status === 'refunded' && order.status === 'approved') {
    const paidUntil = new Date(parseIso(sub.paidUntil).getTime() - order.days * DAY);
    const newStatus = paidUntil > new Date() ? 'active' : 'expired';
    store.transaction(() => {
      store.update('orders', order.id, { status: 'refunded' });
      store.update('subscriptions', sub.id, { paidUntil: paidUntil.toISOString(), status: newStatus });
    });
    console.log(`Pedido ${orderToken} reembolsado; assinatura ${sub.id} agora ${newStatus}`);
    return { outcome: 'refunded' };
  }

  if (status === 'approved' && order.status === 'approved' && paymentId !== order.paymentId) {
    console.warn(`Pagamento duplicado ${paymentId} para o pedido ${orderToken} (já pago por ${order.paymentId}). Considere estornar.`);
    return { outcome: 'duplicate' };
  }

  if (status === 'rejected' && order.status === 'pending') {
    store.update('orders', order.id, { status: 'rejected' });
    return { outcome: 'rejected' };
  }
  return { outcome: 'ignored' };
}

export async function applyPayment(orderToken, paymentId, status, amountCents) {
  const result = applyPaymentSync(orderToken, paymentId, status, amountCents);
  if (result.outcome === 'activated') sendPaymentConfirmation(result.orderId, result.first);
  return result.outcome;
}

function orderContext(orderId) {
  const store = db();
  const order = store.get('orders', orderId);
  const sub = store.get('subscriptions', order.subscriptionId);
  return { order, sub, customer: store.get('customers', sub.customerId), child: store.get('children', sub.childId) };
}

function sendPaymentConfirmation(orderId, first) {
  const { sub, customer, child } = orderContext(orderId);
  const subject = first
    ? `Bem-vindo(a)! A primeira história de ${child.name} já está sendo escrita`
    : `Assinatura renovada: mais histórias para ${child.name}`;
  queueEmail('pagamento_confirmado', customer.email, subject, {
    parentName: customer.parentName, childName: child.name, paidUntil: sub.paidUntil, first,
    accountUrl: `${config.baseUrl}/conta/${customer.token}`,
  });
}

// Rede de segurança caso algum aviso (webhook) do Mercado Pago se perca.
export async function reconcilePendingOrders() {
  if (config.paymentProvider !== 'mercadopago') return;
  const since = plusDays(-3);
  const pending = db().filter('orders', (o) => o.status === 'pending' && o.createdAt > since);
  for (const order of pending) {
    try {
      for (const payment of await searchPayments(order.token)) {
        const info = normalize(payment);
        await applyPayment(order.token, info.paymentId, info.status, info.amountCents);
      }
    } catch (err) {
      console.error(`Falha ao conciliar pedido ${order.token}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------- rotina do worker

export function scheduleDueStories() {
  const store = db();
  const now = new Date();
  const nowStr = now.toISOString();
  let created = 0;
  const due = store.filter('subscriptions', (s) =>
    s.status === 'active' && s.nextStoryAt && s.nextStoryAt <= nowStr && s.paidUntil > nowStr);
  for (const sub of due) {
    const busy = store.find('stories', (st) =>
      st.subscriptionId === sub.id && (st.status === 'queued' || st.status === 'generating'));
    if (busy) continue;
    // Próxima data: pula os intervalos que já passaram (sem rajada depois de um tempo parado).
    const interval = config.storyIntervalDays * DAY;
    const due = parseIso(sub.nextStoryAt).getTime();
    const next = due + (Math.floor((now.getTime() - due) / interval) + 1) * interval;
    store.transaction(() => {
      store.insert('stories', {
        token: newToken(), subscriptionId: sub.id, childId: sub.childId, status: 'queued', theme: '', title: '',
        summary: '', hasPdf: false, attempts: 0, error: null, adminAlerted: false, createdAt: nowIso(),
        startedAt: null, readyAt: null, emailedAt: null,
      });
      store.update('subscriptions', sub.id, { nextStoryAt: new Date(next).toISOString() });
    });
    created += 1;
  }
  return created;
}

// Destrava histórias presas (servidor reiniciado no meio) e tenta de novo as que falharam.
export function recoverAndRetry() {
  const store = db();
  const hourAgo = plusDays(-1 / 24);
  const twentyMinAgo = plusDays(-20 / 1440);
  let changed = false;
  for (const st of store.all('stories')) {
    if ((st.status === 'generating' && st.startedAt < hourAgo)
      || (st.status === 'failed' && st.attempts < 3 && st.startedAt < twentyMinAgo)) {
      st.status = 'queued';
      changed = true;
    }
  }
  if (changed) store.save();
}

export function nextQueuedStory() {
  const now = nowIso();
  const queued = db()
    .filter('stories', (s) => s.status === 'queued' && (!s.retryAt || s.retryAt <= now))
    .sort((a, b) => a.id - b.id);
  return queued.length ? queued[0].id : null;
}

export function notifyReadyStories() {
  const store = db();
  for (const story of store.filter('stories', (s) => s.status === 'ready' && !s.emailedAt)) {
    const sub = store.get('subscriptions', story.subscriptionId);
    const customer = store.get('customers', sub.customerId);
    const child = store.get('children', story.childId);
    queueEmail('historia_pronta', customer.email, `Nova história para ${child.name}: ${story.title}`, {
      childName: child.name, title: story.title, summary: story.summary,
      storyUrl: `${config.baseUrl}/h/${story.token}`, accountUrl: `${config.baseUrl}/conta/${customer.token}`,
    });
    store.update('stories', story.id, { emailedAt: nowIso() });
  }
}

// História adiada (limite da IA, rede fora) mais do que isso: avisa o admin (~2 horas com 15 min de espera).
export const MAX_DEFERRALS = 8;

export function alertAdminFailures() {
  const store = db();
  const rows = store.filter('stories', (s) => !s.adminAlerted
    && ((s.status === 'failed' && s.attempts >= 3) || (s.status === 'queued' && (s.deferrals || 0) >= MAX_DEFERRALS)));
  if (!rows.length) return;
  if (config.adminEmail) {
    queueEmail('alerta_admin', config.adminEmail, `[${config.siteName}] ${rows.length} história(s) falharam`, {
      rows: rows.map((r) => ({ id: r.id, error: r.error })), adminUrl: `${config.baseUrl}/admin`,
    });
  }
  store.transaction(() => rows.forEach((r) => { r.adminAlerted = true; }));
}

export function expireAndRemind() {
  const store = db();
  const now = new Date();
  const nowStr = now.toISOString();
  const limit = new Date(now.getTime() + config.renewalReminderDays * DAY).toISOString();

  // Lembrete de renovação alguns dias antes de vencer (uma vez por vencimento)
  const toRemind = store.filter('subscriptions', (s) => s.status === 'active' && s.remindersEnabled
    && s.paidUntil <= limit && s.paidUntil > nowStr && s.reminderSentFor !== s.paidUntil);
  for (const sub of toRemind) {
    const customer = store.get('customers', sub.customerId);
    const child = store.get('children', sub.childId);
    queueEmail('lembrete_renovacao', customer.email, `As histórias de ${child.name} acabam em breve`, {
      childName: child.name, paidUntil: sub.paidUntil, accountUrl: `${config.baseUrl}/conta/${customer.token}#renovar-${sub.id}`,
    });
    store.update('subscriptions', sub.id, { reminderSentFor: sub.paidUntil });
  }

  // Expira o que venceu
  for (const sub of store.filter('subscriptions', (s) => s.status === 'active' && s.paidUntil <= nowStr)) {
    store.update('subscriptions', sub.id, { status: 'expired' });
    if (!sub.remindersEnabled) continue;
    const customer = store.get('customers', sub.customerId);
    const child = store.get('children', sub.childId);
    queueEmail('plano_expirou', customer.email, `Sentimos sua falta! Renove as histórias de ${child.name}`, {
      childName: child.name, accountUrl: `${config.baseUrl}/conta/${customer.token}#renovar-${sub.id}`,
    });
  }
}

// Faxina diária: e-mails antigos (têm dados pessoais) e pastas de histórias sem registro.
export function housekeeping(maxAgeDays = 30) {
  const store = db();
  const limit = plusDays(-maxAgeDays);
  store.remove('emails', (e) => e.status !== 'pending' && e.createdAt < limit);
  const dir = paths.stories();
  if (!fs.existsSync(dir)) return;
  const known = new Set(store.all('stories').map((s) => String(s.id)));
  for (const name of fs.readdirSync(dir)) {
    if (!known.has(name)) removeStoryFiles(name);
  }
}

// Executa fn no máximo uma vez a cada everySeconds (controle salvo no banco).
export async function runPeriodic(key, everySeconds, fn) {
  const last = parseIso(db().kvGet(key));
  if (last && Date.now() - last.getTime() < everySeconds * 1000) return;
  db().kvSet(key, nowIso());
  await fn();
}

// ---------------------------------------------------------------- área do cliente e LGPD

export function customerSubscriptions(customerId) {
  const store = db();
  return store
    .filter('subscriptions', (s) => s.customerId === customerId && s.status !== 'pending')
    .sort((a, b) => a.id - b.id)
    .map((sub) => ({
      ...sub,
      child: store.get('children', sub.childId),
      stories: store
        .filter('stories', (st) => st.subscriptionId === sub.id)
        .sort((a, b) => b.id - a.id),
    }));
}

// Apaga os dados pessoais (LGPD). Pedidos ficam anonimizados, como pede a lei fiscal.
export function deleteCustomerData(customerId) {
  const store = db();
  const subIds = new Set(store.filter('subscriptions', (s) => s.customerId === customerId).map((s) => s.id));
  const stories = store.filter('stories', (st) => subIds.has(st.subscriptionId));
  stories.forEach((st) => removeStoryFiles(st.id));
  const email = store.get('customers', customerId).email;
  store.transaction(() => {
    store.remove('emails', (e) => e.to === email);
    for (const order of store.filter('orders', (o) => subIds.has(o.subscriptionId) && o.status === 'pending')) {
      order.status = 'canceled';
    }
    store.remove('stories', (st) => subIds.has(st.subscriptionId));
    for (const sub of store.filter('subscriptions', (s) => subIds.has(s.id))) {
      Object.assign(sub, { status: 'canceled', remindersEnabled: false });
    }
    for (const child of store.filter('children', (c) => c.customerId === customerId)) {
      Object.assign(child, { name: 'apagado', appearance: {}, interests: [], interestsExtra: '', themes: [], petName: '' });
    }
    const customer = store.get('customers', customerId);
    Object.assign(customer, {
      email: `apagado-${customer.id}@invalid`, parentName: 'apagado', token: newToken(), deletedAt: nowIso(),
    });
  });
}

export function dashboardStats() {
  const store = db();
  const nowStr = nowIso();
  const monthAgo = plusDays(-30);
  const paid = store.filter('orders', (o) => o.status === 'approved' && o.paidAt > monthAgo);
  return {
    active: store.filter('subscriptions', (s) => s.status === 'active' && s.paidUntil > nowStr).length,
    expired: store.filter('subscriptions', (s) => s.status === 'expired').length,
    revenue30d: paid.reduce((sum, o) => sum + o.amountCents, 0),
    orders30d: paid.length,
    storiesReady: store.filter('stories', (s) => s.status === 'ready').length,
    storiesQueued: store.filter('stories', (s) => s.status === 'queued' || s.status === 'generating').length,
    storiesFailed: store.filter('stories', (s) => s.status === 'failed').length,
    emailProblems: emailProblems().length,
  };
}
