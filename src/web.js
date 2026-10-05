// Rotas do site: vendas, cadastro, checkout, área do cliente, histórias, webhook e painel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, plans } from './config.js';
import {
  DEFAULT_APPEARANCE, EYE_COLORS, FAVORITE_COLORS, GENDERS, HAIR_COLORS, HAIR_STYLES, INTERESTS, PETS,
  SAMPLE_CHILD, SAMPLE_STORY, SKIN_TONES, THEMES,
} from './content.js';
import {
  Router, adminEnabled, cookieHeader, createAdminSession, isAdmin, isHttps, rateLimited, readForm, readJson,
  redirect, safeEqual, sameOrigin, send, sendHtml, sendJson, serveFile,
} from './http.js';
import { avatarSVG, sceneSVG } from './illustrate.js';
import { sendTemplate } from './mailer.js';
import { PaymentError, fetchPayment, normalize } from './payments.js';
import { readScene, readStory, storyPdfPath } from './pipeline.js';
import * as services from './services.js';
import { db } from './store.js';
import { collapseSpaces, nowIso, parseIso } from './util.js';
import * as views from './views/pages.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/;
const NAME_RE = /^[\p{L}' -]{2,40}$/u;

// ---------------------------------------------------------------- formulário da criança

export function parseChildForm(form) {
  const errors = [];
  const name = collapseSpaces(form.get('child_name'), 60);
  if (!NAME_RE.test(name)) errors.push('Digite o nome (ou apelido) da criança, só com letras.');
  const age = parseInt(form.get('age'), 10) || 0;
  if (age < 1 || age > 12) errors.push('A idade deve ser entre 1 e 12 anos.');
  const pick = (field, options, fallback) => {
    const value = String(form.get(field) ?? fallback);
    return Object.prototype.hasOwnProperty.call(options, value) ? value : fallback;
  };
  const appearance = {
    skin: pick('skin', SKIN_TONES, DEFAULT_APPEARANCE.skin),
    hair_color: pick('hair_color', HAIR_COLORS, DEFAULT_APPEARANCE.hair_color),
    hair_style: pick('hair_style', HAIR_STYLES, DEFAULT_APPEARANCE.hair_style),
    eyes: pick('eyes', EYE_COLORS, DEFAULT_APPEARANCE.eyes),
    glasses: ['1', 'on', 'true'].includes(form.get('glasses')),
    fav_color: pick('fav_color', FAVORITE_COLORS, DEFAULT_APPEARANCE.fav_color),
  };
  const petType = pick('pet_type', PETS, '');
  const petName = collapseSpaces(form.get('pet_name'), 30);
  if (petType && !petName) errors.push('Qual o nome do bichinho de estimação?');
  const child = {
    name,
    age,
    gender: pick('gender', GENDERS, 'neutro'),
    appearance,
    interests: form.getAll('interests').filter((i) => INTERESTS.includes(i)).slice(0, 5),
    interestsExtra: collapseSpaces(form.get('interests_extra'), 200),
    themes: form.getAll('themes').filter((t) => Object.prototype.hasOwnProperty.call(THEMES, t)).slice(0, 4),
    petType,
    petName: petType ? petName : '',
  };
  return { child, errors };
}

// Valores para reexibir o formulário (nomes de campo do HTML)
const formValues = (child, extra = {}) => ({
  child_name: child.name,
  age: child.age,
  gender: child.gender,
  appearance: child.appearance,
  interests: child.interests,
  interests_extra: child.interestsExtra,
  themes: child.themes,
  pet_type: child.petType,
  pet_name: child.petName,
  ...extra,
});

let sampleCache = null;
function sampleScenes() {
  if (!sampleCache) {
    sampleCache = SAMPLE_STORY.cenas.map((s, i) =>
      sceneSVG(s.cenario, s.noite, SAMPLE_CHILD.appearance, SAMPLE_CHILD.pet_type, `exemplo-${i}`));
  }
  return sampleCache;
}

const notFound = (res) => sendHtml(res, 404, views.message({
  title: 'Página não encontrada', text: 'O endereço que você abriu não existe ou o link expirou.',
}));

const tooMany = (res) => sendHtml(res, 429, views.message({
  title: 'Calma aí!', text: 'Muitas tentativas seguidas. Tente de novo daqui a pouco.',
}));

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  const next = encodeURIComponent(new URL(req.url, 'http://x').pathname);
  redirect(res, `/admin/login?next=${next}`);
  return false;
}

// ---------------------------------------------------------------- rotas

export function buildRouter() {
  const r = new Router();

  r.get('/', ({ res }) => sendHtml(res, 200, views.home({ sample: SAMPLE_STORY, sampleScenes: sampleScenes() })));

  r.get('/exemplo', ({ res }) => sendHtml(res, 200, views.storyPage({
    story: SAMPLE_STORY, scenes: sampleScenes(), childName: SAMPLE_CHILD.name, pdfUrl: null, isSample: true,
  })));

  r.get('/avatar.svg', ({ res, query }) => {
    const { child } = parseChildForm(query);
    send(res, 200, avatarSVG(child.appearance, child.petType), {
      'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400',
    });
  });

  r.get('/privacidade', ({ res }) => sendHtml(res, 200, views.privacy()));
  r.get('/termos', ({ res }) => sendHtml(res, 200, views.terms()));

  r.get('/robots.txt', ({ res }) => send(res, 200,
    'User-agent: *\nDisallow: /conta/\nDisallow: /h/\nDisallow: /admin\nDisallow: /obrigado/\nDisallow: /checkout-teste/\n',
    { 'Content-Type': 'text/plain; charset=utf-8' }));

  r.get('/saude', ({ res }) => {
    const heartbeat = parseIso(db().kvGet('worker_heartbeat'));
    const workerOk = Boolean(heartbeat && Date.now() - heartbeat.getTime() < 30 * 60000);
    sendJson(res, 200, { web: 'ok', worker: workerOk ? 'ok' : 'sem sinal' });
  });

  // ------------------------------------------------ assinatura e checkout

  r.get('/assinar', ({ res, query }) => {
    const plan = Object.prototype.hasOwnProperty.call(plans(), query.get('plano')) ? query.get('plano') : 'mensal';
    sendHtml(res, 200, views.signup({ values: { plan, appearance: DEFAULT_APPEARANCE } }));
  });

  r.post('/assinar', async ({ req, res }) => {
    const form = await readForm(req);
    const { child, errors } = parseChildForm(form);
    const email = String(form.get('email') || '').trim().toLowerCase().slice(0, 120);
    const parentName = collapseSpaces(form.get('parent_name'), 80);
    const plan = String(form.get('plan') || 'mensal');
    if (!EMAIL_RE.test(email)) errors.push('Digite um e-mail válido. É por ele que as histórias chegam.');
    if (parentName.length < 2) errors.push('Digite seu nome.');
    if (!Object.prototype.hasOwnProperty.call(plans(), plan)) errors.push('Escolha um plano.');
    if (!form.get('consent')) errors.push('É preciso aceitar os termos e autorizar o uso dos dados da criança para criar as histórias.');
    if (errors.length) {
      return sendHtml(res, 422, views.signup({ values: formValues(child, { email, parent_name: parentName, plan }), errors }));
    }
    if (rateLimited(req, 'signup', 10, 3600000)) return tooMany(res);
    const { subscription } = services.createSignup(email, parentName, child);
    try {
      const { url } = await services.createOrder(subscription.id, plan);
      return redirect(res, url);
    } catch (err) {
      if (!(err instanceof PaymentError)) throw err;
      console.error('Falha ao criar checkout:', err.message);
      return sendHtml(res, 502, views.message({
        title: 'Ops!', text: 'Não conseguimos abrir o pagamento agora. Tente de novo em alguns minutos.',
      }));
    }
  });

  r.get('/checkout-teste/:token', ({ req, res, params }) => {
    if (config.paymentProvider !== 'fake') return notFound(res);
    const order = db().find('orders', (o) => o.token === params.token);
    if (!order) return notFound(res);
    sendHtml(res, 200, views.fakeCheckout({ order, plan: plans()[order.plan], admin: isAdmin(req) }));
  });

  r.post('/checkout-teste/:token', async ({ req, res, params }) => {
    if (config.paymentProvider !== 'fake') return notFound(res);
    if (!requireAdmin(req, res)) return undefined;
    const order = db().find('orders', (o) => o.token === params.token);
    if (!order) return notFound(res);
    await services.applyPayment(order.token, `teste-${order.id}`, 'approved', order.amountCents);
    return redirect(res, `/obrigado/${order.token}`);
  });

  const orderView = (token) => {
    const store = db();
    const order = store.find('orders', (o) => o.token === token);
    if (!order) return null;
    const sub = store.get('subscriptions', order.subscriptionId);
    return {
      ...order,
      customerToken: store.get('customers', sub.customerId).token,
      childName: store.get('children', sub.childId).name,
    };
  };

  r.get('/obrigado/:token', async ({ res, params, query }) => {
    let order = orderView(params.token);
    if (!order) return notFound(res);
    const paymentId = query.get('payment_id') || '';
    if (order.status === 'pending' && config.paymentProvider === 'mercadopago' && /^\d+$/.test(paymentId)) {
      // O cliente voltou do checkout antes do aviso chegar: consulta o pagamento direto na API.
      try {
        const info = normalize(await fetchPayment(paymentId));
        if (info.orderToken === params.token) {
          await services.applyPayment(params.token, info.paymentId, info.status, info.amountCents);
          order = orderView(params.token);
        }
      } catch (err) {
        console.error(`Falha ao consultar pagamento ${paymentId}:`, err.message);
      }
    }
    return sendHtml(res, 200, views.thanks({ order }));
  });

  // Aviso do Mercado Pago. Só o ID é usado: o pagamento é sempre reconsultado na API com o seu token.
  r.post('/webhooks/mercadopago', async ({ req, res, query }) => {
    const body = await readJson(req);
    const topic = body.type || query.get('type') || query.get('topic');
    const paymentId = String(body?.data?.id || query.get('data.id') || query.get('id') || '');
    if (topic !== 'payment' || !/^\d+$/.test(paymentId) || config.paymentProvider !== 'mercadopago') {
      return sendJson(res, 200, { ok: true, ignored: true });
    }
    try {
      const info = normalize(await fetchPayment(paymentId));
      const outcome = await services.applyPayment(info.orderToken, info.paymentId, info.status, info.amountCents);
      console.log(`Webhook pagamento ${paymentId} (${info.status}): ${outcome}`);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error(`Falha ao consultar pagamento ${paymentId}:`, err.message);
      return sendJson(res, 500, { ok: false }); // o Mercado Pago tenta de novo
    }
  });

  // ------------------------------------------------ área do cliente

  const customerOr404 = (res, token) => {
    const customer = services.findCustomerByToken(token);
    if (!customer) notFound(res);
    return customer;
  };

  r.get('/conta/:token', ({ res, params, query }) => {
    const customer = customerOr404(res, params.token);
    if (!customer) return;
    const subs = services.customerSubscriptions(customer.id).map((sub) => ({
      ...sub, avatar: avatarSVG(sub.child.appearance, sub.child.petType, 160),
    }));
    sendHtml(res, 200, views.account({ customer, subs, saved: query.get('salvo') === '1' }));
  });

  r.post('/conta/:token/renovar/:subscriptionId', async ({ req, res, params }) => {
    const customer = customerOr404(res, params.token);
    if (!customer) return undefined;
    const form = await readForm(req);
    const plan = String(form.get('plan') || 'mensal');
    const sub = db().get('subscriptions', params.subscriptionId);
    if (!sub || sub.customerId !== customer.id || sub.status === 'canceled'
      || !Object.prototype.hasOwnProperty.call(plans(), plan)) return notFound(res);
    try {
      const { url } = await services.createOrder(sub.id, plan);
      return redirect(res, url);
    } catch (err) {
      if (!(err instanceof PaymentError)) throw err;
      console.error('Falha ao criar checkout de renovação:', err.message);
      return sendHtml(res, 502, views.message({
        title: 'Ops!', text: 'Não conseguimos abrir o pagamento agora. Tente de novo em alguns minutos.',
      }));
    }
  });

  r.post('/conta/:token/lembretes/:subscriptionId', async ({ req, res, params }) => {
    const customer = customerOr404(res, params.token);
    if (!customer) return undefined;
    const form = await readForm(req);
    const sub = db().get('subscriptions', params.subscriptionId);
    if (sub && sub.customerId === customer.id) {
      db().update('subscriptions', sub.id, { remindersEnabled: form.get('enabled') === '1' });
    }
    return redirect(res, `/conta/${params.token}`);
  });

  const ownChild = (customer, childId) => {
    const child = db().get('children', childId);
    return child && child.customerId === customer.id ? child : null;
  };

  r.get('/conta/:token/editar/:childId', ({ res, params }) => {
    const customer = customerOr404(res, params.token);
    if (!customer) return;
    const child = ownChild(customer, params.childId);
    if (!child) return notFound(res);
    sendHtml(res, 200, views.editChild({ customer, child, values: formValues(child) }));
  });

  r.post('/conta/:token/editar/:childId', async ({ req, res, params }) => {
    const customer = customerOr404(res, params.token);
    if (!customer) return undefined;
    const current = ownChild(customer, params.childId);
    if (!current) return notFound(res);
    const { child, errors } = parseChildForm(await readForm(req));
    if (errors.length) {
      return sendHtml(res, 422, views.editChild({ customer, child: current, values: formValues(child), errors }));
    }
    services.updateChild(current.id, child);
    return redirect(res, `/conta/${params.token}?salvo=1`);
  });

  r.post('/conta/:token/apagar', async ({ req, res, params }) => {
    const customer = customerOr404(res, params.token);
    if (!customer) return undefined;
    const form = await readForm(req);
    if (form.get('confirm') !== 'APAGAR') {
      return sendHtml(res, 400, views.message({
        title: 'Nada foi apagado', text: 'Para apagar, digite APAGAR no campo de confirmação.',
        link: [`/conta/${params.token}`, 'Voltar para minha conta'],
      }));
    }
    services.deleteCustomerData(customer.id);
    return sendHtml(res, 200, views.message({ title: 'Dados apagados', text: 'Todos os dados pessoais e histórias foram apagados. Até logo!' }));
  });

  r.get('/entrar', ({ res }) => sendHtml(res, 200, views.login({ sent: false })));

  r.post('/entrar', async ({ req, res }) => {
    const form = await readForm(req);
    const email = String(form.get('email') || '').trim().toLowerCase();
    if (EMAIL_RE.test(email) && !rateLimited(req, 'login-link', 5, 3600000)) {
      const customer = services.findCustomerByEmail(email);
      if (customer) {
        try {
          await sendTemplate('link_acesso', email, `Seu link de acesso - ${config.siteName}`, {
            accountUrl: `${config.baseUrl}/conta/${customer.token}`,
          });
        } catch (err) {
          console.error('Falha ao enviar link de acesso:', err.message);
        }
      }
    }
    // Mesma resposta sempre, para não revelar quem é cliente.
    return sendHtml(res, 200, views.login({ sent: true }));
  });

  // ------------------------------------------------ histórias

  const readyStory = (token) => {
    const story = db().find('stories', (s) => s.token === token && s.status === 'ready');
    if (!story) return null;
    return { ...story, childName: db().get('children', story.childId).name };
  };

  r.get('/h/:token', ({ res, params }) => {
    const row = readyStory(params.token);
    if (!row) return notFound(res);
    const story = readStory(row.id);
    sendHtml(res, 200, views.storyPage({
      story, scenes: story.cenas.map((_, i) => readScene(row.id, i)), childName: row.childName,
      pdfUrl: row.hasPdf ? `/h/${params.token}/pdf` : null, isSample: false,
    }));
  });

  r.get('/h/:token/pdf', ({ res, params }) => {
    const row = readyStory(params.token);
    if (!row || !fs.existsSync(storyPdfPath(row.id))) return notFound(res);
    send(res, 200, fs.readFileSync(storyPdfPath(row.id)), {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${row.title}.pdf`)}`,
    });
  });

  // ------------------------------------------------ administração

  r.get('/admin/login', ({ req, res, query }) => {
    if (isAdmin(req)) return redirect(res, '/admin');
    return sendHtml(res, 200, views.adminLogin({ next: query.get('next'), enabled: adminEnabled() }));
  });

  r.post('/admin/login', async ({ req, res }) => {
    const form = await readForm(req);
    const nextUrl = String(form.get('next') || '/admin');
    const safeNext = nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/admin';
    if (rateLimited(req, 'admin-login', 5, 15 * 60000)) {
      return sendHtml(res, 429, views.adminLogin({ next: safeNext, enabled: adminEnabled(), error: 'Muitas tentativas. Aguarde 15 minutos.' }));
    }
    const ok = adminEnabled()
      && safeEqual(String(form.get('email') || '').trim().toLowerCase(), config.adminEmail)
      && safeEqual(String(form.get('password') || ''), config.adminPassword);
    if (!ok) {
      return sendHtml(res, 401, views.adminLogin({ next: safeNext, enabled: adminEnabled(), error: 'E-mail ou senha incorretos.' }));
    }
    return redirect(res, safeNext, 303, {
      'Set-Cookie': cookieHeader('adm', createAdminSession(), { maxAge: 7 * 86400, secure: isHttps(req) }),
    });
  });

  r.post('/admin/logout', ({ req, res }) => redirect(res, '/', 303, {
    'Set-Cookie': cookieHeader('adm', '', { maxAge: 0, secure: isHttps(req) }),
  }));

  r.get('/admin', ({ req, res }) => {
    if (!requireAdmin(req, res)) return;
    const store = db();
    const customerOf = (sub) => store.get('customers', sub.customerId);
    const childOf = (id) => store.get('children', id);
    const subs = store.filter('subscriptions', (s) => s.status !== 'pending').sort((a, b) => b.id - a.id).slice(0, 100)
      .map((s) => ({ ...s, email: customerOf(s).email, childName: childOf(s.childId).name, age: childOf(s.childId).age }));
    const stories = [...store.all('stories')].sort((a, b) => b.id - a.id).slice(0, 50)
      .map((st) => ({ ...st, childName: childOf(st.childId).name }));
    const orders = [...store.all('orders')].sort((a, b) => b.id - a.id).slice(0, 50)
      .map((o) => ({ ...o, email: customerOf(store.get('subscriptions', o.subscriptionId)).email }));
    const warnings = [];
    if (config.paymentProvider === 'fake') warnings.push('Pagamentos em modo de teste: só você (logado) consegue simular uma compra. Configure o Mercado Pago no .env.site para vender.');
    if (config.paymentProvider === 'mercadopago' && !config.baseUrl.startsWith('https://')) warnings.push('BASE_URL não usa https: o Mercado Pago não consegue enviar os avisos de pagamento.');
    if (config.llmProvider === 'demo') warnings.push('IA em modo demonstração (histórias de modelo fixo). Coloque LLM_API_KEY (Groq) no .env.site.');
    if (config.emailProvider === 'outbox') warnings.push('E-mails não estão sendo enviados (ficam em DATA_DIR/outbox). Coloque BREVO_API_KEY no .env.site.');
    sendHtml(res, 200, views.admin({ stats: services.dashboardStats(), subs, stories, orders, warnings }));
  });

  r.post('/admin/historia/:storyId/refazer', ({ req, res, params }) => {
    if (!requireAdmin(req, res)) return;
    db().update('stories', params.storyId, {
      status: 'queued', attempts: 0, adminAlerted: false, emailedAt: null, error: null, retryAt: null,
    });
    redirect(res, '/admin');
  });

  r.post('/admin/assinatura/:subscriptionId/gerar', ({ req, res, params }) => {
    if (!requireAdmin(req, res)) return;
    const sub = db().get('subscriptions', params.subscriptionId);
    if (sub && sub.status === 'active') db().update('subscriptions', sub.id, { nextStoryAt: nowIso() });
    redirect(res, '/admin');
  });

  return r;
}

// ---------------------------------------------------------------- servidor

export function createHandler() {
  const router = buildRouter();
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/static/') && (req.method === 'GET' || req.method === 'HEAD')) {
        let relative = '';
        try {
          relative = decodeURIComponent(url.pathname.slice('/static/'.length));
        } catch {
          return notFound(res);
        }
        if (serveFile(req, res, PUBLIC_DIR, relative, { maxAge: 86400 })) return;
        return notFound(res);
      }
      if (req.method === 'POST' && !url.pathname.startsWith('/webhooks/') && !sameOrigin(req)) {
        return send(res, 403, 'Origem não permitida', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      const match = router.match(req.method, url.pathname);
      if (!match) return notFound(res);
      if (match.methodNotAllowed) return send(res, 405, 'Método não permitido', { 'Content-Type': 'text/plain; charset=utf-8' });
      await match.handler({ req, res, params: match.params, query: url.searchParams, url });
    } catch (err) {
      if (err.status === 413) return send(res, 413, 'Requisição grande demais');
      console.error(`Erro em ${req.method} ${req.url}:`, err);
      if (!res.headersSent) {
        sendHtml(res, 500, views.message({ title: 'Ops!', text: 'Algo deu errado do nosso lado. Tente de novo em instantes.' }));
      }
    }
  };
}
