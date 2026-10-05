// Peças de base: .env, banco em arquivo, templates com escape, rotas.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadEnvFile, parseEnv } from '../src/env.js';
import { html, raw } from '../src/html.js';
import { Router } from '../src/http.js';
import { Store } from '../src/store.js';

test('parseEnv entende comentários, aspas e valores com espaço e "="', () => {
  const vars = parseEnv('# comentário\nA=1\nB="dois três"\nC=x=y\n\nexport D=4\nE=Era Uma Vez Eu\n');
  assert.deepEqual(vars, { A: '1', B: 'dois três', C: 'x=y', D: '4', E: 'Era Uma Vez Eu' });
});

test('loadEnvFile não sobrescreve variáveis já definidas', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env.site');
  fs.writeFileSync(file, 'PORT=1\nNOVA=sim\n');
  const env = { PORT: '3000' };
  assert.equal(loadEnvFile(file, env), true);
  assert.deepEqual(env, { PORT: '3000', NOVA: 'sim' });
  assert.equal(loadEnvFile(file + '.naoexiste', env), false);
});

test('Store grava na hora, sobrevive a reabrir e agrupa transações', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-')), 'store.json');
  const store = new Store(file);
  const a = store.insert('customers', { email: 'a@b.com' });
  store.transaction(() => {
    store.update('customers', a.id, { parentName: 'Ana' });
    store.insert('customers', { email: 'c@d.com' });
  });
  store.kvSet('x', '1');
  const again = new Store(file);
  assert.equal(again.get('customers', a.id).parentName, 'Ana');
  assert.equal(again.all('customers').length, 2);
  assert.equal(again.kvGet('x'), '1');
  assert.equal(again.insert('customers', { email: 'e@f.com' }).id, 3);
  assert.equal(again.remove('customers', (c) => c.email === 'e@f.com'), 1);
  assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith('.tmp')));
});

test('html`` escapa valores e aceita raw/aninhados', () => {
  const name = '<script>alert("x")</script>';
  const out = String(html`<p title="${name}">${name}${raw('<b>ok</b>')}${[html`<i>${'a&b'}</i>`]}</p>`);
  assert.equal(out, '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<b>ok</b><i>a&amp;b</i></p>');
  assert.equal(String(html`${null}${undefined}${false}${0}`), '0');
});

test('Router casa parâmetros, HEAD vira GET e distingue 405', () => {
  const r = new Router();
  const h = () => {};
  r.get('/conta/:token/editar/:childId', h).post('/x', h);
  assert.deepEqual(r.match('GET', '/conta/abc/editar/7').params, { token: 'abc', childId: '7' });
  assert.ok(r.match('HEAD', '/conta/abc/editar/7').handler);
  assert.equal(r.match('GET', '/x').methodNotAllowed, true);
  assert.equal(r.match('GET', '/nada'), null);
});
