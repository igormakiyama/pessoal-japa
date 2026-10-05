// Regras do negócio, usadas pelo site e pelo worker.
import { config, plans } from './config.js';
import { sendTemplate } from './mailer.js';
import { createCheckout, normalize, searchPayments } from './payments.js';
import { removeStoryFiles } from './pipeline.js';
import { db } from './store.js';
import { newToken, nowIso, parseIso, plusDays } from './util.js';

const DAY = 86400000;

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

  if (status === 'approved' && (order.status === 'pending' || order.status === 'rejected')) {
    if (amountCents + 1 < order.amountCents) {
      console.error(`Pagamento ${paymentId} com valor menor que o pedido ${orderToken}`);
      return { outcome: 'amount_mismatch' };
    }
    const now = new Date();
    const current = parseIso(sub.paidUntil);
    const base = current && current > now ? current : now;
    const wasActive = sub.status === 'active';
    store.transaction(() => {
      store.update('orders', order.id, { status: 'approved', paymentId, paidAt: nowIso() });
      store.update('subscriptions', sub.id, {
        status: 'active',
        paidUntil: plusDays(order.days, base),
        nextStoryAt: wasActive && sub.nextStoryAt ? sub.nextStoryAt : now.toISOString(),
        remindersEnabled: true,
      });
    });
    return { outcome: 'activated', orderId: order.id, first: !wasActive };
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

  if (status === 'rejected' && order.status === 'pending') {
    store.update('orders', order.id, { status: 'rejected' });
    return { outcome: 'rejected' };
  }
  return { outcome: 'ignored' };
}

export async function applyPayment(orderToken, paymentId, status, amountCents) {
  const result = applyPaymentSync(orderToken, paymentId, status, amountCents);
  if (result.outcome === 'activated') await sendPaymentConfirmation(result.orderId, result.first);
  return result.outcome;
}

function orderContext(orderId) {
  const store = db();
  const order = store.get('orders', orderId);
  const sub = store.get('subscriptions', order.subscriptionId);
  return { order, sub, customer: store.get('customers', sub.customerId), child: store.get('children', sub.childId) };
}

async function sendPaymentConfirmation(orderId, first) {
  const { sub, customer, child } = orderContext(orderId);
  const subject = first
    ? `Bem-vindo(a)! A primeira história de ${child.name} já está sendo escrita`
    : `Assinatura renovada: mais histórias para ${child.name}`;
  try {
    await sendTemplate('pagamento_confirmado', customer.email, subject, {
      parentName: customer.parentName, childName: child.name, paidUntil: sub.paidUntil, first,
      accountUrl: `${config.baseUrl}/conta/${customer.token}`,
    });
  } catch (err) {
    console.error('Falha ao enviar confirmação de pagamento:', err.message);
  }
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
    let next = parseIso(sub.nextStoryAt).getTime();
    while (next <= now.getTime()) next += config.storyIntervalDays * DAY;
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
  store.transaction(() => {
    for (const st of store.all('stories')) {
      if (st.status === 'generating' && st.startedAt < hourAgo) st.status = 'queued';
      else if (st.status === 'failed' && st.attempts < 3 && st.startedAt < twentyMinAgo) st.status = 'queued';
    }
  });
}

export function nextQueuedStory() {
  const now = nowIso();
  const queued = db()
    .filter('stories', (s) => s.status === 'queued' && (!s.retryAt || s.retryAt <= now))
    .sort((a, b) => a.id - b.id);
  return queued.length ? queued[0].id : null;
}

export async function notifyReadyStories() {
  const store = db();
  for (const story of store.filter('stories', (s) => s.status === 'ready' && !s.emailedAt)) {
    const sub = store.get('subscriptions', story.subscriptionId);
    const customer = store.get('customers', sub.customerId);
    const child = store.get('children', story.childId);
    try {
      await sendTemplate('historia_pronta', customer.email, `Nova história para ${child.name}: ${story.title}`, {
        childName: child.name, title: story.title, summary: story.summary,
        storyUrl: `${config.baseUrl}/h/${story.token}`, accountUrl: `${config.baseUrl}/conta/${customer.token}`,
      });
    } catch (err) {
      console.error(`Falha ao enviar e-mail da história ${story.id}:`, err.message);
      continue;
    }
    store.update('stories', story.id, { emailedAt: nowIso() });
  }
}

export async function alertAdminFailures() {
  const store = db();
  const rows = store.filter('stories', (s) => s.status === 'failed' && s.attempts >= 3 && !s.adminAlerted);
  if (!rows.length) return;
  if (config.adminEmail) {
    try {
      await sendTemplate('alerta_admin', config.adminEmail, `[${config.siteName}] ${rows.length} história(s) falharam`, {
        rows: rows.map((r) => ({ id: r.id, error: r.error })), adminUrl: `${config.baseUrl}/admin`,
      });
    } catch (err) {
      console.error('Falha ao enviar alerta ao admin:', err.message);
      return;
    }
  }
  store.transaction(() => rows.forEach((r) => { r.adminAlerted = true; }));
}

export async function expireAndRemind() {
  const store = db();
  const now = new Date();
  const nowStr = now.toISOString();
  const limit = new Date(now.getTime() + config.renewalReminderDays * DAY).toISOString();

  // Lembrete de renovação alguns dias antes de vencer (uma vez por vencimento)
  const toRemind = store.filter('subscriptions', (s) => s.status === 'active' && s.remindersEnabled
    && s.paidUntil <= limit && s.reminderSentFor !== s.paidUntil);
  for (const sub of toRemind) {
    const customer = store.get('customers', sub.customerId);
    const child = store.get('children', sub.childId);
    try {
      await sendTemplate('lembrete_renovacao', customer.email, `As histórias de ${child.name} acabam em breve`, {
        childName: child.name, paidUntil: sub.paidUntil, accountUrl: `${config.baseUrl}/conta/${customer.token}#renovar`,
      });
    } catch (err) {
      console.error('Falha ao enviar lembrete de renovação:', err.message);
      continue;
    }
    store.update('subscriptions', sub.id, { reminderSentFor: sub.paidUntil });
  }

  // Expira o que venceu
  for (const sub of store.filter('subscriptions', (s) => s.status === 'active' && s.paidUntil <= nowStr)) {
    store.update('subscriptions', sub.id, { status: 'expired' });
    if (!sub.remindersEnabled) continue;
    const customer = store.get('customers', sub.customerId);
    const child = store.get('children', sub.childId);
    try {
      await sendTemplate('plano_expirou', customer.email, `Sentimos sua falta! Renove as histórias de ${child.name}`, {
        childName: child.name, accountUrl: `${config.baseUrl}/conta/${customer.token}#renovar`,
      });
    } catch (err) {
      console.error('Falha ao enviar aviso de expiração:', err.message);
    }
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
  store.transaction(() => {
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
    workerHeartbeat: store.kvGet('worker_heartbeat'),
  };
}
