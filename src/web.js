// Rotas do site: vendas, cadastro, checkout, área do cliente, histórias, webhook e painel.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, paths, plans } from './config.js';
import {
  DEFAULT_APPEARANCE, EYE_COLORS, FAVORITE_COLORS, GENDERS, HAIR_COLORS, HAIR_STYLES, INTERESTS, PETS,
  SAMPLE_CHILD, SAMPLE_STORY, SKIN_TONES, THEMES,
} from './content.js';
import {
  Router, adminEnabled, clientIp, cookieHeader, createAdminSession, csrfToken, isAdmin, isBlocked, isHttps, rateLimited,
  rateLimitedKey, recordHit,
  readForm, readJson, redirect, revokeAdminSessions, safeEqual, sameOrigin, send, sendHtml, sendJson, serveFile, validCsrf,
} from './http.js';
import { avatarSVG, sceneSVG } from './illustrate.js';
import { PaymentError, fetchPayment, normalize } from './payments.js';
import { readScene, readStory, storyPdfPath } from './pipeline.js';
import * as services from './services.js';
import { db } from './store.js';
import { collapseSpaces, nowIso, parseIso } from './util.js';
import * as views from './views/pages.js';
import { workerHeartbeat } from './worker.js';

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

const forbidden = (res) => sendHtml(res, 403, views.message({
  title: 'Ação recusada', text: 'O formulário expirou ou veio de outro site. Volte ao painel e tente de novo.',
  link: ['/admin', 'Voltar ao painel'],
}));

// Destino após o login: só caminhos internos simples (sem //, barra invertida ou caracteres de controle).
export function safeNextPath(value) {
  const next = String(value || '');
  return /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(next) ? next : '/admin';
}

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
    const heartbeat = parseIso(workerHeartbeat());
    const workerOk = Boolean(heartbeat && Date.now() - heartbeat.getTime() < 30 * 60000);
    sendJson(res, 200, {
      web: 'ok',
      worker: workerOk ? 'ok' : 'sem sinal',
      email: services.emailProblems().length ? 'falhando' : 'ok',
    });
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
    const admin = isAdmin(req);
    sendHtml(res, 200, views.fakeCheckout({ order, plan: plans()[order.plan], admin, csrf: admin ? csrfToken(req) : '' }));
  });

  r.post('/checkout-teste/:token', async ({ req, res, params }) => {
    if (config.paymentProvider !== 'fake') return notFound(res);
    if (!requireAdmin(req, res)) return undefined;
    if (!validCsrf(req, await readForm(req))) return forbidden(res);
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
    // Sem o link da conta: ele vai só para o e-mail cadastrado (quem pagou pode não ser o dono do e-mail).
    return { ...order, childName: store.get('children', sub.childId).name };
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
      ...sub, avatar: avatarSVG(sub.child.appearance, sub.child.petType, 160, `Personagem de ${sub.child.name}`),
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
    if (EMAIL_RE.test(email) && !rateLimited(req, 'login-link', 5, 3600000)
      && !rateLimitedKey(`login-link-email:${email}`, 3, 3600000)) {
      const customer = services.findCustomerByEmail(email);
      // Vai para a fila (envio em segundo plano): o tempo de resposta não revela quem é cliente.
      if (customer) {
        services.queueEmail('link_acesso', email, `Seu link de acesso - ${config.siteName}`, {
          accountUrl: `${config.baseUrl}/conta/${customer.token}`,
        });
      }
    }
    // Mesma resposta sempre, para não revelar quem é cliente.
    return sendHtml(res, 200, views.login({ sent: true }));
  });

  // ------------------------------------------------ histórias

  const readyStory = (token) => {
    // Já entregue alguma vez (readyAt): continua acessível mesmo enquanto o admin manda refazer.
    const story = db().find('stories', (s) => s.token === token && s.readyAt);
    if (!story || !fs.existsSync(path.join(paths.storyDir(story.id), 'story.json'))) return null;
    return { ...story, childName: db().get('children', story.childId).name };
  };

  r.get('/h/:token', ({ res, params }) => {
    const row = readyStory(params.token);
    if (!row) return notFound(res);
    const story = readStory(row.id);
    sendHtml(res, 200, views.storyPage({
      // Ilustrações decorativas (o texto ao lado conta a cena); arquivos antigos tinham role="img" sem nome
      story, scenes: story.cenas.map((_, i) => readScene(row.id, i).replace(' role="img">', ' aria-hidden="true">')),
      childName: row.childName,
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
    return sendHtml(res, 200, views.adminLogin({ next: safeNextPath(query.get('next')), enabled: adminEnabled() }));
  });

  r.post('/admin/login', async ({ req, res }) => {
    const form = await readForm(req);
    const safeNext = safeNextPath(form.get('next'));
    // Só as tentativas erradas contam: 5 erros em 15 minutos bloqueiam aquele IP por um tempo.
    const failKey = `admin-login-fail:${clientIp(req)}`;
    if (isBlocked(failKey, 5, 15 * 60000)) {
      return sendHtml(res, 429, views.adminLogin({ next: safeNext, enabled: adminEnabled(), error: 'Muitas tentativas. Aguarde 15 minutos.' }));
    }
    const ok = adminEnabled()
      && safeEqual(String(form.get('email') || '').trim().toLowerCase(), config.adminEmail)
      && safeEqual(String(form.get('password') || ''), config.adminPassword);
    if (!ok) {
      recordHit(failKey, 15 * 60000);
      return sendHtml(res, 401, views.adminLogin({ next: safeNext, enabled: adminEnabled(), error: 'E-mail ou senha incorretos.' }));
    }
    return redirect(res, safeNext, 303, {
      'Set-Cookie': cookieHeader('adm', createAdminSession(), { maxAge: 7 * 86400, secure: isHttps(req) }),
    });
  });

  r.post('/admin/logout', async ({ req, res }) => {
    if (validCsrf(req, await readForm(req))) revokeAdminSessions();
    return redirect(res, '/', 303, { 'Set-Cookie': cookieHeader('adm', '', { maxAge: 0, secure: isHttps(req) }) });
  });

  r.get('/admin', ({ req, res }) => {
    if (!requireAdmin(req, res)) return;
    const store = db();
    const customerOf = (sub) => store.get('customers', sub.customerId);
    const childOf = (id) => store.get('children', id);
    const subs = store.filter('subscriptions', (s) => s.status !== 'pending').sort((a, b) => b.id - a.id).slice(0, 100)
      .map((s) => ({
        ...s, email: customerOf(s).email, customerToken: customerOf(s).token,
        childName: childOf(s.childId).name, age: childOf(s.childId).age,
      }));
    const stories = [...store.all('stories')].sort((a, b) => b.id - a.id).slice(0, 50)
      .map((st) => ({ ...st, childName: childOf(st.childId).name }));
    const orders = [...store.all('orders')].sort((a, b) => b.id - a.id).slice(0, 50)
      .map((o) => ({ ...o, email: customerOf(store.get('subscriptions', o.subscriptionId)).email }));
    const warnings = [];
    if (config.paymentProvider === 'fake') warnings.push('Pagamentos em modo de teste: só você (logado) consegue simular uma compra. Configure o Mercado Pago no .env.site para vender.');
    if (config.paymentProvider === 'mercadopago' && !config.baseUrl.startsWith('https://')) warnings.push('BASE_URL não usa https: o Mercado Pago não consegue enviar os avisos de pagamento.');
    if (config.llmProvider === 'demo') warnings.push('IA em modo demonstração (histórias de modelo fixo). Coloque LLM_API_KEY (Groq) no .env.site.');
    if (config.emailProvider === 'outbox') warnings.push('E-mails não estão sendo enviados (ficam em DATA_DIR/outbox). Coloque BREVO_API_KEY no .env.site.');
    const problems = services.emailProblems();
    if (problems.length) {
      warnings.push(`${problems.length} e-mail(s) com falha no envio. Último erro: ${problems[problems.length - 1].lastError || '—'}`);
    }
    const stats = { ...services.dashboardStats(), workerHeartbeat: workerHeartbeat() };
    sendHtml(res, 200, views.admin({ stats, subs, stories, orders, warnings, csrf: csrfToken(req) }));
  });

  r.post('/admin/historia/:storyId/refazer', async ({ req, res, params }) => {
    if (!requireAdmin(req, res)) return undefined;
    if (!validCsrf(req, await readForm(req))) return forbidden(res);
    db().update('stories', params.storyId, {
      status: 'queued', attempts: 0, adminAlerted: false, emailedAt: null, error: null, retryAt: null,
    });
    return redirect(res, '/admin');
  });

  r.post('/admin/assinatura/:subscriptionId/gerar', async ({ req, res, params }) => {
    if (!requireAdmin(req, res)) return undefined;
    if (!validCsrf(req, await readForm(req))) return forbidden(res);
    const sub = db().get('subscriptions', params.subscriptionId);
    if (sub && sub.status === 'active') db().update('subscriptions', sub.id, { nextStoryAt: nowIso() });
    return redirect(res, '/admin');
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
