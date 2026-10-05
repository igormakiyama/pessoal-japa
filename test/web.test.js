// Fluxo completo pelo HTTP: cadastro -> pagamento (admin) -> worker -> história -> área do cliente.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';

import { paths } from '../src/config.js';
import { readStory, storyPdfPath } from '../src/pipeline.js';
import { db } from '../src/store.js';
import { HOME_HEADLINE } from '../src/views/pages.js';
import { tick } from '../src/worker.js';
import { ADMIN, CHILD_FORM, adminCookie, csrfFrom, outbox, postForm, setup, simulatePayment, startServer } from './helpers.js';

let srv;
let base;

before(async () => {
  setup();
  srv = await startServer();
  base = srv.base;
});

after(() => srv.close());

async function signup(email = 'mae@example.com', plan = 'mensal') {
  const res = await postForm(base, '/assinar', { ...CHILD_FORM, email, parent_name: 'Ana Souza', plan, consent: '1' });
  assert.equal(res.status, 303);
  const location = res.headers.get('location');
  assert.match(location, /\/checkout-teste\/[\w-]+$/);
  return location.split('/').pop();
}

test('páginas públicas respondem e a manchete vem no HTML', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  const text = await home.text();
  assert.ok(text.includes(HOME_HEADLINE));
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  for (const url of ['/exemplo', '/assinar', '/assinar?plano=anual', '/termos', '/privacidade', '/entrar', '/saude', '/robots.txt', '/static/style.css', '/static/form.js', '/static/story.js', '/admin/login']) {
    assert.equal((await fetch(base + url)).status, 200, url);
  }
  const avatar = await fetch(base + '/avatar.svg?skin=escura&hair_style=crespo&pet_type=coelho');
  assert.match(avatar.headers.get('content-type'), /image\/svg\+xml/);
  const head = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
});

test('validação do cadastro', async () => {
  const res = await postForm(base, '/assinar', { child_name: '1', email: 'x' });
  assert.equal(res.status, 422);
  const text = await res.text();
  assert.ok(text.includes('e-mail válido'));
  assert.ok(text.includes('aceitar os termos'));
});

test('fluxo completo com pagamento de teste liberado só para o admin', async () => {
  const orderToken = await signup();

  const checkout = await (await fetch(`${base}/checkout-teste/${orderToken}`)).text();
  assert.ok(checkout.includes('ainda não foram liberados'));
  const anon = await postForm(base, `/checkout-teste/${orderToken}`, {});
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get('location'), /^\/admin\/login/);
  assert.equal(db().all('subscriptions')[0].status, 'pending');

  const cookie = await adminCookie(base);
  // Sem o token anti-CSRF do formulário, nem o admin consegue
  assert.equal((await postForm(base, `/checkout-teste/${orderToken}`, {}, { cookie })).status, 403);
  const paid = await simulatePayment(base, orderToken, cookie);
  assert.equal(paid.headers.get('location'), `/obrigado/${orderToken}`);
  const thanks = await (await fetch(`${base}/obrigado/${orderToken}`)).text();
  assert.ok(thanks.includes('Pagamento confirmado'));
  // A página de obrigado nunca mostra o link da conta (ele vai só para o e-mail cadastrado)
  assert.ok(!thanks.includes(db().all('customers')[0].token));
  assert.ok(!thanks.includes('/conta/'));
  assert.equal(db().all('subscriptions')[0].status, 'active');

  assert.equal(await tick(), true);
  const story = db().all('stories')[0];
  assert.equal(story.status, 'ready', story.error);
  assert.equal(story.theme, 'coragem');
  assert.ok(story.hasPdf);
  assert.ok(fs.readFileSync(storyPdfPath(story.id)).subarray(0, 5).toString() === '%PDF-');
  assert.ok(readStory(story.id).cenas.length >= 3);
  assert.ok(story.emailedAt);
  const mails = outbox();
  assert.ok(mails.some((m) => m.includes('Bem-vindo')));
  assert.ok(mails.some((m) => m.includes('Nova história')));

  // Não gera outra antes da próxima semana
  assert.equal(await tick(), false);
  assert.equal(db().all('stories').length, 1);

  const page = await fetch(`${base}/h/${story.token}`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Theo'));
  const pdf = await fetch(`${base}/h/${story.token}/pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal((await fetch(`${base}/h/token-invalido`)).status, 404);

  const customer = db().all('customers')[0];
  const account = await (await fetch(`${base}/conta/${customer.token}`)).text();
  assert.ok(account.includes(story.title.replace(/&/g, '&amp;')));
  assert.equal((await fetch(`${base}/conta/token-errado`)).status, 404);

  // Segunda história usa o próximo tema
  db().update('subscriptions', db().all('subscriptions')[0].id, { nextStoryAt: new Date(Date.now() - 60000).toISOString() });
  await tick();
  const second = db().all('stories')[1];
  assert.equal(second.status, 'ready');
  assert.equal(second.theme, 'amizade');
});

test('editar criança, renovar e apagar dados', async () => {
  const orderToken = await signup('pai@example.com');
  const cookie = await adminCookie(base);
  await simulatePayment(base, orderToken, cookie);
  const customer = db().find('customers', (c) => c.email === 'pai@example.com');
  const sub = db().find('subscriptions', (s) => s.customerId === customer.id);

  const editUrl = `/conta/${customer.token}/editar/${sub.childId}`;
  assert.equal((await fetch(base + editUrl)).status, 200);
  const saved = await postForm(base, editUrl, { ...CHILD_FORM, child_name: 'Theozinho', age: '6' });
  assert.equal(saved.status, 303);
  assert.equal(db().get('children', sub.childId).name, 'Theozinho');

  const renew = await postForm(base, `/conta/${customer.token}/renovar/${sub.id}`, { plan: 'trimestral' });
  const renewalToken = renew.headers.get('location').split('/').pop();
  const before = db().get('subscriptions', sub.id).paidUntil;
  await simulatePayment(base, renewalToken, cookie);
  assert.ok(db().get('subscriptions', sub.id).paidUntil > before);

  // Outro cliente não consegue mexer nesta assinatura
  const other = db().find('customers', (c) => c.email === 'mae@example.com');
  assert.equal((await postForm(base, `/conta/${other.token}/renovar/${sub.id}`, { plan: 'mensal' })).status, 404);
  assert.equal((await fetch(`${base}/conta/${other.token}/editar/${sub.childId}`)).status, 404);

  await tick();
  const stories = db().filter('stories', (s) => s.subscriptionId === sub.id);
  const del = await postForm(base, `/conta/${customer.token}/apagar`, { confirm: 'APAGAR' });
  assert.equal(del.status, 200);
  assert.equal(db().filter('stories', (s) => s.subscriptionId === sub.id).length, 0);
  stories.forEach((s) => assert.equal(fs.existsSync(paths.storyDir(s.id)), false));
  assert.equal((await fetch(`${base}/conta/${customer.token}`)).status, 404);
  assert.match(db().get('customers', customer.id).email, /^apagado-/);
});

test('link de acesso por e-mail não revela quem é cliente', async () => {
  const customer = db().find('customers', (c) => c.email === 'mae@example.com');
  const res = await postForm(base, '/entrar', { email: 'mae@example.com' });
  assert.ok((await res.text()).includes('Se este e-mail tiver uma assinatura'));
  assert.ok(outbox().some((m) => m.includes(customer.token)));
  const res2 = await postForm(base, '/entrar', { email: 'naoexiste@example.com' });
  assert.ok((await res2.text()).includes('Se este e-mail tiver uma assinatura'));
});

test('painel exige login e recusa senha errada', async () => {
  const anon = await fetch(base + '/admin', { redirect: 'manual' });
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get('location'), /^\/admin\/login/);
  const wrong = await postForm(base, '/admin/login', { email: ADMIN.email, password: 'errada' });
  assert.equal(wrong.status, 401);
  const forged = await fetch(base + '/admin', { redirect: 'manual', headers: { cookie: `adm=${Date.now() + 999999}.assinatura-falsa` } });
  assert.equal(forged.status, 303);
  const cookie = await adminCookie(base);
  const ok = await fetch(base + '/admin', { headers: { cookie } });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.ok(html.includes('Painel'));
  for (const url of ['/admin/historia/1/refazer', '/admin/assinatura/1/gerar']) {
    const res = await postForm(base, url, {});
    assert.match(res.headers.get('location'), /^\/admin\/login/, url);
  }
  // Ações do painel exigem o token do formulário
  assert.equal((await postForm(base, '/admin/assinatura/1/gerar', {}, { cookie })).status, 403);
  const csrf = csrfFrom(html);
  assert.equal((await postForm(base, '/admin/assinatura/1/gerar', { csrf }, { cookie })).headers.get('location'), '/admin');
  // Redirecionamento após login nunca sai do site
  for (const next of ['//evil.com', '/\\evil.com', '/\tevil.com', 'https://evil.com', '/admin/../x']) {
    const evil = await postForm(base, '/admin/login', { email: ADMIN.email, password: ADMIN.password, next });
    assert.equal(evil.headers.get('location'), '/admin', next);
  }
  // Sair invalida a sessão mesmo que alguém tenha copiado o cookie
  const copied = await adminCookie(base);
  const page = await (await fetch(base + '/admin', { headers: { cookie: copied } })).text();
  await postForm(base, '/admin/logout', { csrf: csrfFrom(page) }, { cookie: copied });
  assert.equal((await fetch(base + '/admin', { redirect: 'manual', headers: { cookie: copied } })).status, 303);
});

test('proteções: CSRF, arquivos fora de public/ e rotas públicas sem dados de clientes', async () => {
  for (const origin of ['https://site-malicioso.com', 'https://outro.metodoim.com.br', 'null']) {
    const csrf = await fetch(base + '/entrar', {
      method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.com',
    });
    assert.equal(csrf.status, 403, origin);
  }
  // Cookie malformado de outro site do mesmo domínio não derruba o painel
  assert.equal((await fetch(base + '/admin/login', { headers: { cookie: 'desconto=50%; nome=Jos%E9' } })).status, 200);
  for (const url of ['/static/..%2fsrc%2fconfig.js', '/static/..%2f..%2fetc%2fpasswd', '/static/%2e%2e/package.json', '/.env.site', '/store.json']) {
    assert.equal((await fetch(base + url)).status, 404, url);
  }
  const emails = db().all('customers').map((c) => c.email);
  for (const url of ['/', '/exemplo', '/saude', '/robots.txt', '/assinar', '/entrar', '/termos', '/privacidade', '/admin/login']) {
    const text = await (await fetch(base + url)).text();
    for (const email of emails) assert.ok(!text.includes(email), `${url} vazou ${email}`);
    assert.ok(!text.includes(ADMIN.password), `${url} vazou a senha`);
  }
});
