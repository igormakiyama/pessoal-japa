// IA de texto: validação, prompt, chamada à API (fetch falso), apelidos e história de demonstração.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { config, loadConfig } from '../src/config.js';
import { THEMES, wordTarget } from '../src/content.js';
import {
  ALIASES, BANNED_PATTERNS, BRANDS, LLMError, MAX_ATTEMPTS, StoryGenerationError, buildStoryMessages, chatJSON,
  demoStory, extractJson, generateStory, hideNames, storyText, validateStory,
} from '../src/llm.js';

const CHILD = {
  id: 1, name: 'Theo', age: 5, gender: 'menino', appearance: {}, interests: ['dinossauros'],
  interests_extra: 'ama o Homem-Aranha', themes: [], pet_type: 'gato', pet_name: 'Bolinha',
};

const realFetch = globalThis.fetch;
let calls = [];

function configure(overrides = {}) {
  loadConfig({
    ...process.env,
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'llm-')),
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'chave-de-teste',
    LLM_BASE_URL: 'https://ia.example.test/v1',
    LLM_MODEL: 'modelo-a,modelo-b',
    LLM_REVIEW: 'true',
    LLM_TIMEOUT_SECONDS: '30',
    ...overrides,
  });
}

// Troca o fetch global por um falso. handler(body, call) devolve { status, json | text, headers } ou um Error.
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, raw: init.body, body: JSON.parse(init.body) };
    calls.push(call);
    const out = await handler(call.body, call);
    if (out instanceof Error) throw out;
    const { status = 200, json, text, headers = {} } = out;
    return new Response(text ?? JSON.stringify(json), { status, headers });
  };
}

// Parte da história que vai para o cliente (sem os campos internos com apelidos)
const shown = ({ promptTitle, promptSummary, ...story }) => story;

const completion = (data) => ({
  json: { choices: [{ message: { content: typeof data === 'string' ? data : JSON.stringify(data) } }] },
});
const isReview = (body) => body.messages[0].content.includes('revisor');
const userPrompt = (call) => call.body.messages[1].content;
const storyCalls = () => calls.filter((c) => !isReview(c.body));
const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = (text) => text.split(/\s+/).filter(Boolean).length;

function makeStory({ extra = '', name = 'Theo', scenes = 4, wordsPerScene = 110, title = 'Theo e o Foguete' } = {}) {
  const filler = Array(wordsPerScene).fill('palavra').join(' ');
  return {
    titulo: title,
    resumo: 'Resumo.',
    licao: 'Lição.',
    cenas: Array.from({ length: scenes }, () => ({ cenario: 'jardim', noite: false, texto: `${name} brincou. ${filler} ${extra}` })),
  };
}

// História que a IA (falsa) escreveria: ela só conhece os apelidos.
const aliasStory = (opts = {}) => makeStory({ name: ALIASES.menino, title: `${ALIASES.menino} e o Foguete`, ...opts });

beforeEach(() => {
  configure();
  mock.method(console, 'warn', () => {});
  mock.method(console, 'log', () => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
});

// ---------------------------------------------------------------- validação (port dos testes Python)

test('história válida passa', () => {
  const { story, problems } = validateStory(makeStory(), CHILD);
  assert.deepEqual(problems, []);
  assert.equal(story.cenas.length, 4);
});

test('conteúdo impróprio e marcas são recusados', () => {
  for (const [extra, expected] of [['e encontrou sangue no chão', 'imprópria'], ['com o Homem-Aranha', 'marcas']]) {
    const { problems } = validateStory(makeStory({ extra }), CHILD);
    assert.ok(problems.some((p) => p.includes(expected)), `${extra}: ${problems}`);
  }
});

test('palavras proibidas respeitam acentos nas fronteiras de palavra', () => {
  const flagged = (extra) => validateStory(makeStory({ extra }), CHILD).problems.some((p) => p.includes('imprópria'));
  assert.ok(flagged('foi estúpido'));
  assert.ok(flagged('cheiro de álcool'));
  assert.ok(flagged('Pokémon apareceu') === false);
  assert.ok(!flagged('morava no computador perto da mata'));
  assert.ok(!flagged('a disputa amigável'));
  assert.ok(validateStory(makeStory({ extra: 'brincou de Pokémon' }), CHILD).problems.some((p) => p.includes('marcas')));
  assert.equal(BANNED_PATTERNS.length, 25);
  assert.ok(BANNED_PATTERNS.every((re) => re instanceof RegExp));
  assert.ok(BRANDS.includes('homem-aranha'));
});

test('nome curto demais e sem o nome da criança são recusados', () => {
  const { problems } = validateStory(makeStory({ name: 'Joana', wordsPerScene: 10 }), CHILD);
  assert.ok(problems.some((p) => p.includes('curta')));
  assert.ok(problems.some((p) => p.includes('nome')));
});

test('quantidade de cenas fora de 3 a 7 é recusada', () => {
  assert.ok(validateStory(makeStory({ scenes: 2, wordsPerScene: 200 }), CHILD).problems.some((p) => p.includes('cenas')));
  assert.ok(validateStory(makeStory({ scenes: 8, wordsPerScene: 60 }), CHILD).problems.some((p) => p.includes('cenas')));
  assert.deepEqual(validateStory(makeStory({ scenes: 3, wordsPerScene: 140 }), CHILD).problems, []);
});

test('JSON vazado no título é cortado e cenários são normalizados', () => {
  const data = makeStory({ title: 'Theo e o Estranho”, “ cenário: quarto”' });
  data.cenas[0].cenario = 'Espaço sideral';
  data.cenas[1].cenario = 'lugar desconhecido';
  data.cenas[2].cenario = 'Fundo-do-Mar';
  const { story, problems } = validateStory(data, CHILD);
  assert.equal(story.titulo, 'Theo e o Estranho');
  assert.equal(story.cenas[0].cenario, 'espaco');
  assert.equal(story.cenas[1].cenario, 'jardim');
  assert.equal(story.cenas[2].cenario, 'fundo_do_mar');
  assert.deepEqual(problems, []);
});

test('restos de JSON no fim das cenas são removidos e pedaços no meio são acusados', () => {
  const data = makeStory();
  data.cenas[0].texto += ' brilhava de forma diferente.”} , 152, 0,';
  data.cenas[1].texto += ' o brilho da lanterna.” , 402, 0,';
  data.cenas[2].texto += ' — Boa noite, Theo! — disse a mãe: “durma bem.”';
  const { story, problems } = validateStory(data, CHILD);
  assert.ok(story.cenas[0].texto.endsWith('diferente.'));
  assert.ok(story.cenas[1].texto.endsWith('lanterna.'));
  assert.ok(story.cenas[2].texto.endsWith('“durma bem.”'));
  assert.deepEqual(problems, []);
  data.cenas[3].texto += ' {"cenario": "quarto"} e mais texto';
  assert.ok(validateStory(data, CHILD).problems.some((p) => p.includes('JSON')));
});

test('nome com acento conta só como palavra inteira; marca igual ao nome da criança não é acusada', () => {
  const joao = { ...CHILD, name: 'João', pet_name: '' };
  assert.deepEqual(validateStory(makeStory({ name: 'João' }), joao).problems, []);
  const glued = validateStory(makeStory({ name: 'Joãozinho' }), joao).problems;
  assert.ok(glued.some((p) => p.includes('nome')), glued.join('; '));
  const moana = { ...CHILD, name: 'Moana', gender: 'menina' };
  assert.deepEqual(validateStory(makeStory({ name: 'Moana', title: 'Moana e o Mar' }), moana).problems, []);
});

test('noite em texto "false" vira false e entrada estranha não quebra', () => {
  const data = makeStory();
  data.cenas[0].noite = 'false';
  data.cenas[1].noite = 'true';
  const { story } = validateStory(data, CHILD);
  assert.equal(story.cenas[0].noite, false);
  assert.equal(story.cenas[1].noite, true);
  assert.ok(validateStory(null, CHILD).problems.length > 0);
  assert.ok(validateStory({ cenas: 'x', titulo: 5 }, CHILD).problems.length > 0);
});

// ---------------------------------------------------------------- prompt e apelidos

test('prompt usa apelidos, mascara marcas e lista as histórias anteriores', () => {
  const messages = buildStoryMessages(CHILD, 'coragem', [{ title: 'Theo no Mar', summary: 'Mergulho com Bolinha.' }], []);
  assert.equal(messages[0].role, 'system');
  const prompt = messages[1].content;
  assert.ok(!prompt.includes('Homem-Aranha'));
  assert.ok(prompt.includes('um personagem de desenho'));
  assert.ok(prompt.includes('Zarik no Mar: Mergulho com Zuzo.'));
  assert.ok(!/theo|bolinha/i.test(prompt));
  assert.ok(prompt.includes('Protagonista: Zarik, 5 anos, um menino'));
  assert.ok(prompt.includes('Participa da história o gato de estimação, chamado Zuzo.'));
  assert.ok(prompt.includes('Varie os cenários: no máximo duas cenas no mesmo cenário.'));
  assert.ok(prompt.includes('entre 400 e 650 palavras'));
  const menina = buildStoryMessages({ ...CHILD, name: 'Lia', gender: 'menina', pet_name: '', pet_type: '' }, 'amizade', [], ['Falta Lia.']);
  assert.ok(menina[1].content.includes('Protagonista: Zarina'));
  assert.ok(menina[1].content.includes('- Falta Zarina.'));
  assert.ok(!menina[1].content.includes('estimação'));
  const neutro = buildStoryMessages({ ...CHILD, name: 'Alex', gender: 'neutro' }, 'amizade', [], []);
  assert.ok(neutro[1].content.includes('Protagonista: Zarel'));
});

test('hideNames troca nome real com ou sem acento, plural e diminutivo, sem pegar outras palavras', () => {
  const joao = { name: 'João', gender: 'menino', pet_name: 'Pipoca' };
  const out = hideNames('O JOAO, o joão, Joãozinho, Joaõ? pipocas, Pipoquinha, joaninha e banana.', joao);
  assert.equal(out, 'O Zarik, o Zarik, Zarik, Zarik? Zuzo, Zuzo, joaninha e banana.');
  const maria = { name: 'Maria Eduarda', gender: 'menina', pet_name: 'Sr. Bigodes' };
  assert.equal(hideNames('Maria Eduarda, a Maria, Eduardinha e o Bigodes', maria), 'Zarina, a Zarina, Zarina e o Zuzo');
  // Nome real igual ao apelido: usa o apelido reserva
  assert.equal(hideNames('Zarina adora', { name: 'Zarina', gender: 'menina' }), 'Tavina adora');
});

// ---------------------------------------------------------------- extractJson e chatJSON

test('extractJson aceita cercas de código e texto em volta', () => {
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Claro! {"a": 2} pronto'), { a: 2 });
  assert.throws(() => extractJson('sem json'), LLMError);
  assert.throws(() => extractJson('[1, 2]'), LLMError);
});

test('chatJSON manda o pedido no formato OpenAI para o primeiro modelo', async () => {
  mockFetch(() => completion('```json\n{"ok": true}\n```'));
  const messages = [{ role: 'user', content: 'responda em JSON' }];
  assert.deepEqual(await chatJSON(messages), { ok: true });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://ia.example.test/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer chave-de-teste');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(call.body, {
    model: 'modelo-a', messages, temperature: 0.8, response_format: { type: 'json_object' },
  });
  await chatJSON(messages, { temperature: 0.1 });
  assert.equal(calls.at(-1).body.temperature, 0.1);
});

test('chatJSON passa para o próximo modelo em 404 e em 400 de modelo aposentado', async () => {
  mockFetch((body) => (body.model === 'modelo-a'
    ? { status: 404, json: { error: { message: 'The model `modelo-a` does not exist', code: 'model_not_found' } } }
    : completion({ ok: 'b' })));
  assert.deepEqual(await chatJSON([{ role: 'user', content: 'json' }]), { ok: 'b' });
  assert.deepEqual(calls.map((c) => c.body.model), ['modelo-a', 'modelo-b']);

  mockFetch((body) => (body.model === 'modelo-a'
    ? { status: 400, json: { error: { message: 'The model `modelo-a` has been decommissioned', code: 'model_decommissioned' } } }
    : completion({ ok: 'b2' })));
  assert.deepEqual(await chatJSON([{ role: 'user', content: 'json' }]), { ok: 'b2' });
  assert.equal(calls.length, 2);

  mockFetch(() => ({ status: 404, text: 'not found' }));
  await assert.rejects(chatJSON([{ role: 'user', content: 'json' }]), (err) => {
    assert.ok(err instanceof LLMError);
    assert.match(err.message, /modelo-a.*modelo-b/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('chatJSON não troca de modelo em outro 400; 429 é retryable', async () => {
  mockFetch(() => ({ status: 400, json: { error: { message: "'messages' must contain the word 'json'" } } }));
  await assert.rejects(chatJSON([{ role: 'user', content: 'oi' }]), (err) => {
    assert.ok(err instanceof LLMError);
    assert.equal(err.status, 400);
    assert.equal(err.retryable, false);
    assert.match(err.message, /400.*must contain/);
    return true;
  });
  assert.equal(calls.length, 1);

  mockFetch(() => ({ status: 429, headers: { 'retry-after': '2' }, json: { error: { message: 'Rate limit reached' } } }));
  await assert.rejects(chatJSON([{ role: 'user', content: 'json' }]), (err) => {
    assert.ok(err instanceof LLMError);
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 2000);
    assert.match(err.message, /429.*Rate limit/);
    return true;
  });
  // Cada modelo tem a sua cota: com limite estourado, tenta todos antes de desistir
  assert.equal(calls.length, 2);

  mockFetch(() => ({ status: 401, json: { error: { message: 'Invalid API Key' } } }));
  await assert.rejects(chatJSON([{ role: 'user', content: 'json' }]), /401.*LLM_API_KEY/);
});

test('chatJSON sem chave avisa em português e não chama a rede', async () => {
  configure({ LLM_API_KEY: '' });
  mockFetch(() => completion({}));
  await assert.rejects(chatJSON([{ role: 'user', content: 'json' }]), (err) => {
    assert.ok(err instanceof LLMError);
    assert.match(err.message, /Falta a chave da IA.*LLM_API_KEY/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('chatJSON: tempo esgotado e resposta sem JSON viram LLMError', async () => {
  config.llmTimeoutMs = 30;
  // O timer do AbortSignal.timeout não segura o processo; no fetch de verdade, o socket segura.
  const keepAlive = setTimeout(() => {}, 5000);
  mockFetch((body, call) => new Promise((resolve, reject) => {
    call.init.signal.addEventListener('abort', () => reject(call.init.signal.reason));
  }));
  await assert.rejects(chatJSON([{ role: 'user', content: 'json' }]), (err) => {
    assert.ok(err instanceof LLMError);
    assert.equal(err.retryable, true);
    assert.match(err.message, /não respondeu/);
    return true;
  });
  clearTimeout(keepAlive);
  configure();
  mockFetch(() => completion('desculpe, não sei'));
  await assert.rejects(chatJSON([{ role: 'user', content: 'json' }]), /não é JSON válido/);
  mockFetch(() => ({ json: { nada: true } }));
  await assert.rejects(chatJSON([{ role: 'user', content: 'json' }]), /Resposta inesperada/);
});

// ---------------------------------------------------------------- generateStory

test('generateStory tenta de novo com o feedback e devolve os nomes reais', async () => {
  let storyCount = 0;
  mockFetch((body) => {
    if (isReview(body)) return completion({ aprovada: true, problemas: [] });
    storyCount += 1;
    return completion(storyCount === 1 ? aliasStory({ extra: 'muito sangue' }) : aliasStory());
  });
  const story = await generateStory(CHILD, 'coragem', []);
  assert.equal(story.titulo, 'Theo e o Foguete');
  assert.ok(story.cenas.every((s) => s.texto.startsWith('Theo brincou.')));
  const prompts = storyCalls().map(userPrompt);
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].includes('Corrija estes problemas'));
  assert.ok(prompts[1].includes('Corrija estes problemas'));
  assert.ok(prompts[1].includes('sangue'));
});

test('generateStory desiste depois de MAX_ATTEMPTS tentativas', async () => {
  mockFetch(() => completion(aliasStory({ extra: 'sangue' })));
  await assert.rejects(generateStory(CHILD, 'coragem', []), StoryGenerationError);
  assert.equal(calls.length, MAX_ATTEMPTS);
});

test('revisão reprovada gera nova tentativa com o feedback do revisor', async () => {
  let reviews = 0;
  mockFetch((body) => {
    if (!isReview(body)) return completion(aliasStory());
    reviews += 1;
    return completion(reviews === 1
      ? { aprovada: false, problemas: ['O final está confuso.'] }
      : { aprovada: true, problemas: [] });
  });
  const story = await generateStory(CHILD, 'amizade', []);
  assert.equal(story.titulo, 'Theo e o Foguete');
  const prompts = storyCalls().map(userPrompt);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes('- O final está confuso.'));
  assert.equal(reviews, 2);
});

test('erro da IA numa tentativa passa para a próxima; revisão com erro segue sem ela', async () => {
  let count = 0;
  mockFetch((body) => {
    count += 1;
    if (isReview(body)) return { status: 503, text: 'indisponível' };
    return count === 1 ? { status: 500, text: 'erro interno' } : completion(aliasStory());
  });
  const story = await generateStory(CHILD, 'coragem', []);
  assert.equal(story.titulo, 'Theo e o Foguete');
  assert.equal(storyCalls().length, 2);
  assert.equal(calls.filter((c) => isReview(c.body)).length, 1);
});

test('sem revisão configurada, uma chamada basta', async () => {
  configure({ LLM_REVIEW: 'false' });
  mockFetch(() => completion(aliasStory()));
  await generateStory(CHILD, 'coragem', []);
  assert.equal(calls.length, 1);
});

test('limite de uso em todas as tentativas vira StoryGenerationError retryable', async () => {
  mockFetch(() => ({ status: 429, json: { error: { message: 'Rate limit reached' } } }));
  await assert.rejects(generateStory(CHILD, 'coragem', []), (err) => {
    assert.ok(err instanceof StoryGenerationError);
    assert.equal(err.retryable, true);
    return true;
  });
  assert.equal(calls.length, MAX_ATTEMPTS * 2);
});

test('limite de uso no primeiro modelo passa para o segundo', async () => {
  configure({ LLM_REVIEW: 'false' });
  mockFetch((body) => (body.model === 'modelo-a'
    ? { status: 429, json: { error: { message: 'Rate limit reached on tokens per day' } } }
    : completion(aliasStory())));
  const story = await generateStory(CHILD, 'coragem', []);
  assert.ok(story.titulo);
  assert.deepEqual(calls.map((c) => c.body.model), ['modelo-a', 'modelo-b']);
});

test('apelido com diminutivo é recusado e pedido de novo', async () => {
  let storyCount = 0;
  mockFetch((body) => {
    if (isReview(body)) return completion({ aprovada: true, problemas: [] });
    storyCount += 1;
    return completion(aliasStory({ extra: storyCount === 1 ? 'e o Zarikzinho dormiu.' : 'e dormiu.' }));
  });
  const story = await generateStory(CHILD, 'coragem', []);
  assert.ok(!/zarik/i.test(JSON.stringify(shown(story))));
  const prompts = storyCalls().map(userPrompt);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes('sem apelidos ou diminutivos'));
});

test('PRIVACIDADE: nenhum pedido à IA leva o nome real da criança ou do bichinho', async () => {
  const joao = {
    id: 7, name: 'João', age: 6, gender: 'menino', appearance: {}, interests: ['dinossauros', 'animais'],
    interests_extra: 'O João adora a Pipoca; o Joãozinho e a PIPOCA dormem juntos. Joao ama o Homem-Aranha.',
    themes: ['coragem'], pet_type: 'cachorro', pet_name: 'Pipoca',
  };
  const previous = [{ title: 'João e a Pipoca no Espaço', summary: 'João e Pipoca voaram até a lua.' }];
  let reviews = 0;
  mockFetch((body) => {
    if (isReview(body)) {
      reviews += 1;
      return completion(reviews === 1
        ? { aprovada: false, problemas: ['O final está confuso.'] }
        : { aprovada: true, problemas: [] });
    }
    return completion(makeStory({ name: `${ALIASES.menino} e ${ALIASES.pet}`, title: `${ALIASES.menino} e ${ALIASES.pet} no Mar` }));
  });
  const story = await generateStory(joao, 'coragem', previous);

  assert.equal(calls.length, 4); // história, revisão (reprova), história, revisão (aprova)
  for (const call of calls) {
    const body = fold(call.raw);
    for (const real of ['joao', 'pipoca']) assert.ok(!body.includes(real), `pedido com "${real}": ${call.raw.slice(0, 300)}`);
  }
  const prompt = userPrompt(storyCalls()[0]);
  assert.ok(prompt.includes('Protagonista: Zarik'));
  assert.ok(prompt.includes('chamado Zuzo'));
  assert.ok(prompt.includes('Zarik e a Zuzo no Espaço'));
  assert.ok(prompt.includes('um personagem de desenho'));
  assert.ok(userPrompt(calls[1]).includes('escrita para Zarik'));

  const json = JSON.stringify(shown(story));
  assert.equal(story.titulo, 'João e Pipoca no Mar');
  // A versão com apelidos (para "histórias anteriores" nos próximos pedidos) não tem o nome real
  assert.equal(story.promptTitle, 'Zarik e Zuzo no Mar');
  assert.ok(!fold(story.promptSummary).includes('joao'));
  assert.ok(story.cenas.every((s) => s.texto.startsWith('João e Pipoca brincou.')));
  for (const alias of Object.values(ALIASES)) assert.ok(!json.includes(alias), `sobrou o apelido ${alias}`);
});

test('PRIVACIDADE: nome real igual ao apelido usa o apelido reserva', async () => {
  const zarina = { ...CHILD, name: 'Zarina', gender: 'menina', pet_name: '', pet_type: '', interests_extra: 'Zarina canta' };
  mockFetch((body) => (isReview(body)
    ? completion({ aprovada: true, problemas: [] })
    : completion(makeStory({ name: 'Tavina', title: 'Tavina e a Lua' }))));
  const story = await generateStory(zarina, 'coragem', []);
  for (const call of calls) assert.ok(!fold(call.raw).includes('zarina'));
  assert.equal(story.titulo, 'Zarina e a Lua');
  assert.ok(!JSON.stringify(shown(story)).includes('Tavina'));
});

// ---------------------------------------------------------------- demonstração

test('demo: nenhuma chamada à rede e história válida para 2, 5 e 9 anos, todos os gêneros', async () => {
  configure({ LLM_PROVIDER: 'demo', LLM_API_KEY: '' });
  mockFetch(() => {
    throw new Error('não deveria chamar a rede');
  });
  const intros = { menino: 'um menino chamado', menina: 'uma menina chamada', neutro: 'uma criança chamada' };
  for (const age of [2, 5, 9]) {
    for (const gender of ['menino', 'menina', 'neutro']) {
      for (const [petType, petName] of [['', ''], ['cachorro', 'Pipoca'], ['coelho', 'Mel']]) {
        for (const theme of Object.keys(THEMES)) {
          const child = { ...CHILD, name: 'João', age, gender, pet_type: petType, pet_name: petName };
          const story = await generateStory(child, theme, []);
          const label = `${age} anos, ${gender}, ${petName || 'sem bicho'}, ${theme}`;
          assert.deepEqual(validateStory(story, child).problems, [], label);
          const total = words(storyText(story));
          const [min, max] = wordTarget(age);
          assert.ok(total >= min && total <= max, `${label}: ${total} palavras`);
          assert.ok(story.cenas[0].texto.includes(`${intros[gender]} João`), label);
          assert.ok(story.titulo.startsWith('João e '), label);
          if (petName) assert.ok(storyText(story).includes(petName), label);
          assert.equal(story.cenas.at(-1).noite, true);
          assert.ok(story.cenas.at(-1).texto.endsWith('Boa noite, João. Bons sonhos!'));
        }
      }
    }
  }
  assert.equal(calls.length, 0);
});

test('demo: tema desconhecido e frases sem pet continuam coerentes', () => {
  const story = demoStory({ name: 'Alex', age: 9, gender: 'neutro' }, 'tema-que-nao-existe');
  const text = storyText(story);
  assert.ok(!/passaram|subiram|pousaram/.test(text), 'verbo no plural sem bichinho');
  assert.ok(text.includes('Alex subiu') && text.includes('Alex pousou'));
  assert.ok(story.licao.length > 10 && story.resumo.includes('Alex'));
});

test('PRIVACIDADE: diminutivos comuns e acentos raros também viram apelido', () => {
  const cases = [
    ['Carlos', 'o Carlinhos e os Carlinhos brincam'],
    ['Marcos', 'o Marquinhos adora bola'],
    ['Lucas', 'a Luquinhas? não, o Luquinhas'],
    ['Luiz', 'o Luizinho dorme cedo'],
    ['Luís', 'o Luisinho e o LUÍS'],
    ['Beatriz', 'a Beatrizinha ama gatos'],
    ['Isabel', 'a Isabelinha canta'],
    ['Joaquim', 'o Joaquinzinho corre'],
    ['Yūki', 'Yūki e Yuki gostam de trem'],
    ['Kōji', 'Kōji (com acento separado) e Kōjizinho'],
    ['Ana Clara', 'a Aninha, a Clarinha e a Ana Clara'],
    ['Diego', 'o Dieguinho'],
  ];
  for (const [name, text] of cases) {
    const out = hideNames(text, { name, gender: 'menino', pet_name: '' });
    const tokens = fold(name).split(/\s+/).map((t) => t.slice(0, 4));
    for (const token of tokens) assert.ok(!fold(out).includes(token), `${name}: sobrou em "${out}"`);
  }
});

test('PRIVACIDADE: histórias anteriores vão com apelido mesmo depois de trocar o nome', async () => {
  const renamed = { ...CHILD, name: 'Theozinho', pet_name: 'Rex', pet_type: 'cachorro' };
  mockFetch((body) => (isReview(body) ? completion({ aprovada: true, problemas: [] }) : completion(aliasStory())));
  // promptTitle/promptSummary guardados quando a criança ainda se chamava "Theo" e o cachorro "Bolinha"
  await generateStory(renamed, 'coragem', [{ title: 'Zarik e Zuzo na Lua', summary: 'Zarik e Zuzo foram longe.' }]);
  const prompt = fold(calls.map((c) => c.raw).join(' '));
  assert.ok(prompt.includes('zarik e zuzo na lua'));
  for (const real of ['theo', 'rex', 'bolinha']) assert.ok(!prompt.includes(real), real);
});
