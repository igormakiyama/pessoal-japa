// Texto da história com IA: geração, validação e revisão automática.
//
// Provedores:
// - openai: qualquer API compatível com OpenAI (padrão: Groq).
// - demo: história de modelo fixo, sem IA (o site funciona sem chave).
//
// Privacidade: o nome real da criança e o do bichinho nunca saem do servidor.
// A IA só vê apelidos (ALIASES); os nomes reais voltam para o texto depois que
// a história foi gerada, validada e revisada.
import crypto from 'node:crypto';

import { config } from './config.js';
import { INTERESTS, SCENES, THEMES, wordTarget } from './content.js';
import { collapseSpaces } from './util.js';

export const MAX_ATTEMPTS = 3;

// Espera máxima quando a IA pede para aguardar (HTTP 429 com Retry-After)
const MAX_WAIT_MS = 15000;

// Apelidos enviados à IA no lugar dos nomes reais
export const ALIASES = { menino: 'Zarik', menina: 'Zarina', neutro: 'Zarel', pet: 'Zuzo' };
// Reserva, para o caso raro de o nome real ser igual ao apelido
const SPARE_ALIASES = { menino: 'Tavik', menina: 'Tavina', neutro: 'Tavel', pet: 'Bimbo' };

// ---------------------------------------------------------------- texto e regex

// O \b do JS só entende ASCII; esta é a "letra" usada nas fronteiras de palavra.
const LETTER = '[\\p{L}\\p{M}\\p{N}_]';
const bounded = (pattern, flags = 'iu') => new RegExp(`(?<!${LETTER})(?:${pattern})(?!${LETTER})`, flags);
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const cut = (text, max) => Array.from(text).slice(0, max).join('');
const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

// Padrão tolerante a acentos: cada letra-base aceita qualquer acento depois dela.
// Funciona sobre texto em NFD (letra + acento separados), então acha "Joao", "JOÃO",
// "João" e também acentos menos comuns ("Yūki", "Kōji"). Use sempre com nfd().
const nfd = (text) => String(text ?? '').normalize('NFD');
const nfc = (text) => String(text ?? '').normalize('NFC');

function loosePattern(term) {
  return [...fold(term).trim().replace(/\s+/g, ' ')].map((ch) => {
    if (ch === ' ') return '\\s+';
    if (/[\p{L}\p{N}]/u.test(ch)) return `${escapeRe(ch)}\\p{M}*`;
    return escapeRe(ch);
  }).join('');
}

// Converte os padrões no estilo Python (\b e \w com acentos) para regex do JS.
const pyRegex = (pattern) => new RegExp(
  pattern.replace(/^\\b/, `(?<!${LETTER})`).replace(/\\b$/, `(?!${LETTER})`).replaceAll('\\w', LETTER),
  'iu',
);

// Palavras que nunca devem aparecer numa história infantil (checagem determinística).
export const BANNED_PATTERNS = [
  String.raw`\bmort[eoa]s?\b`, String.raw`\bmorr\w*`, String.raw`\bsangu\w*`, String.raw`\bmat(ar|ou|ando|aram)\b`,
  String.raw`\bassassin\w*`, String.raw`\barmas?\b`, String.raw`\brev[óo]lver\b`, String.raw`\bpistola\b`,
  String.raw`\btiros?\b`, String.raw`\bfacas?\b`, String.raw`\bdrogas?\b`, String.raw`\bcigarros?\b`,
  String.raw`\bcervejas?\b`, String.raw`\bb[êe]bad\w*`, String.raw`\b[áa]lcool\b`, String.raw`\bdiabo\w*`,
  String.raw`\binferno\b`, String.raw`\bdem[ôo]ni\w*`, String.raw`\bporra\b`, String.raw`\bmerda\b`,
  String.raw`\bcaralho\b`, String.raw`\bputa\w*`, String.raw`\bidiota\w*`, String.raw`\bestúpid\w*`,
  String.raw`\bsexo\b`,
].map(pyRegex);

// Personagens/marcas protegidos que não podem ser usados.
export const BRANDS = [
  'patrulha canina', 'frozen', 'mickey', 'minnie', 'peppa', 'homem-aranha', 'homem aranha', 'batman',
  'superman', 'pokémon', 'pokemon', 'pikachu', 'bluey', 'sonic', 'barbie', 'hulk', 'moana',
  'galinha pintadinha', 'turma da mônica', 'disney', 'marvel', 'minecraft', 'bob esponja',
];

export class LLMError extends Error {
  constructor(message, { status = null, retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export class StoryGenerationError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'StoryGenerationError';
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------- nomes e apelidos

const PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'di', 'du', 'e', 'del', 'van', 'von']);

const nameTokens = (name) => fold(name).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !PARTICLES.has(t));

// Apelidos desta criança (troca pela reserva se coincidir com algum nome real).
function aliasesFor(child) {
  const taken = new Set([child.name, child.pet_name].flatMap(nameTokens));
  const free = (options) => options.find((alias) => !taken.has(fold(alias))) || options[options.length - 1];
  const gender = Object.hasOwn(ALIASES, child.gender) && child.gender !== 'pet' ? child.gender : 'neutro';
  return { name: free([ALIASES[gender], SPARE_ALIASES[gender]]), pet: free([ALIASES.pet, SPARE_ALIASES.pet]) };
}

// Diminutivo a partir de um radical: "Marc" -> Marquinho(s); "Dieg" -> Dieguinho; "Pedr" -> Pedrinho.
function diminutives(stem, plural) {
  const s = plural ? 's' : 's?';
  const out = [`${loosePattern(stem)}(?:inh|it)[oa]${s}`];
  if (/c$/.test(stem)) out.push(`${loosePattern(stem.slice(0, -1))}qu(?:inh|it)[oa]${s}`);
  if (/g$/.test(stem)) out.push(`${loosePattern(stem)}u(?:inh|it)[oa]${s}`);
  return out;
}

// Nome real: aceita sem acento, maiúsculas, plural e os diminutivos comuns
// (Joãozinho, Pedrinho, Aninha, Pipoquinha, Carlinhos, Marquinhos, Luquinhas, Luizinho,
// Isabelinha, Beatrizinha, Joaquinzinho, Rafaelzinho, Davizinho).
function realNameRegex(term) {
  const folded = fold(term).trim().replace(/\s+/g, ' ');
  const options = [`${loosePattern(folded)}(?:s|zinh[oa]s?|zit[oa]s?|inh[oa]s?)?`];
  if (!folded.includes(' ') && folded.length >= 3) {
    if (/[aeo]$/.test(folded)) options.push(...diminutives(folded.slice(0, -1), false));
    if (/[ao]s$/.test(folded)) options.push(...diminutives(folded.slice(0, -2), true));
    if (/m$/.test(folded)) options.push(`${loosePattern(folded.slice(0, -1))}nzinh[oa]s?`);
  }
  return bounded(options.join('|'), 'giu');
}

// Troca o nome real da criança e do bichinho pelos apelidos (antes de mandar para a IA).
export function hideNames(text, child) {
  const { name, pet } = aliasesFor(child);
  const terms = [];
  for (const [real, alias] of [[child.name, name], [child.pet_name, pet]]) {
    if (!fold(real).trim()) continue;
    terms.push([real, alias], ...nameTokens(real).map((token) => [token, alias]));
  }
  terms.sort((a, b) => fold(b[0]).length - fold(a[0]).length);
  let out = nfd(text);
  for (const [real, alias] of terms) out = out.replace(realNameRegex(real), () => alias);
  return nfc(out);
}

// Última barreira antes de enviar: nenhum pedaço do nome real (3+ letras) pode sobrar no pedido.
function leaksRealName(messages, child) {
  const body = nfd(messages.map((m) => m.content).join('\n'));
  const tokens = [child.name, child.pet_name].flatMap((n) => nameTokens(n || '')).filter((t) => t.length >= 3);
  const { name, pet } = aliasesFor(child);
  const aliases = new Set([name, pet].map(fold));
  return tokens.filter((t) => !aliases.has(t)).some((t) => bounded(loosePattern(t), 'iu').test(body));
}

// Volta os apelidos para os nomes reais (depois que a história foi aprovada).
function restoreText(text, child) {
  const { name, pet } = aliasesFor(child);
  let out = nfd(text).replace(bounded(loosePattern(name), 'giu'), () => child.name);
  if (child.pet_name) out = out.replace(bounded(loosePattern(pet), 'giu'), () => child.pet_name);
  return nfc(out);
}

export function restoreNames(story, child) {
  const fix = (text) => restoreText(text, child);
  return {
    ...story,
    titulo: fix(story.titulo),
    resumo: fix(story.resumo),
    licao: fix(story.licao),
    cenas: story.cenas.map((scene) => ({ ...scene, texto: fix(scene.texto) })),
  };
}

// Versão da criança que a IA conhece: só apelidos.
function aliasChild(child) {
  const { name, pet } = aliasesFor(child);
  return {
    ...child,
    name,
    pet_name: child.pet_name ? pet : '',
    interests_extra: hideNames(child.interests_extra, child),
  };
}

// Apelido com diminutivo ou grudado em outra palavra não volta para o nome real; pede de novo.
function aliasProblems(story, child) {
  const { name, pet } = aliasesFor(child);
  const text = nfd([story.titulo, story.resumo, story.licao, storyText(story)].join('\n'));
  const problems = [];
  for (const alias of child.pet_name ? [name, pet] : [name]) {
    const re = new RegExp(`${LETTER}*${loosePattern(alias)}${LETTER}*`, 'giu');
    const odd = [...text.matchAll(re)].map((m) => m[0]).find((word) => fold(word) !== fold(alias));
    if (odd) problems.push(`Escreva o nome ${alias} sempre exatamente assim, sem apelidos ou diminutivos (apareceu "${odd}").`);
  }
  return problems;
}

// Troca personagens de marca citados pelos pais por algo genérico, para a IA não copiar.
export function maskBrands(text) {
  let out = nfd(text);
  for (const brand of BRANDS) out = out.replace(bounded(loosePattern(brand), 'giu'), 'um personagem de desenho');
  return nfc(out);
}

// ---------------------------------------------------------------- chamada à IA

export function extractJson(text) {
  let body = String(text ?? '').trim();
  if (body.startsWith('```')) body = body.replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parse = (value) => {
    try {
      const data = JSON.parse(value);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  };
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  const data = parse(body) ?? (start >= 0 && end > start ? parse(body.slice(start, end + 1)) : null);
  if (data) return data;
  throw new LLMError(`Resposta da IA não é JSON válido: ${JSON.stringify(body.slice(0, 200))}`);
}

// 400 que indica modelo inexistente ou aposentado: passa para o próximo modelo da lista.
const MODEL_GONE = /model_not_found|model_decommissioned|does not exist|decommissioned|not supported/i;

const excerpt = (body) => collapseSpaces(body, 200);

// Envia a conversa para a IA e devolve o JSON da resposta.
export async function chatJSON(messages, { temperature = 0.8 } = {}) {
  if (config.llmProvider !== 'openai') throw new LLMError(`LLM_PROVIDER desconhecido: ${config.llmProvider}`);
  if (!config.llmApiKey) {
    throw new LLMError('Falta a chave da IA: coloque LLM_API_KEY no .env.site (uma chave grátis da Groq serve).');
  }
  const models = config.llmModels || [];
  if (!models.length) throw new LLMError('Nenhum modelo de IA configurado: preencha LLM_MODEL no .env.site.');
  const timeoutMs = config.llmTimeoutMs > 0 ? config.llmTimeoutMs : 120000;
  const unavailable = [];
  // Na Groq, cada modelo tem a sua cota diária: se um estourou (HTTP 429), tenta o próximo.
  const limited = [];
  let limitBody = '';
  let retryAfterMs = null;
  for (const model of models) {
    let res;
    let body;
    try {
      res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.llmApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.text();
    } catch (err) {
      const slow = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new LLMError(slow
        ? `A IA não respondeu em ${Math.round(timeoutMs / 1000)} s (modelo ${model}).`
        : `Falha ao falar com a IA (modelo ${model}): ${err?.message || err}`, { retryable: true });
    }
    if (!res.ok) {
      if (res.status === 404 || (res.status === 400 && MODEL_GONE.test(body))) {
        console.warn(`Modelo de IA indisponível (${model}, HTTP ${res.status}); tentando o próximo.`);
        unavailable.push(`${model} (HTTP ${res.status})`);
        continue;
      }
      if (res.status === 429) {
        const seconds = parseFloat(res.headers.get('retry-after'));
        if (seconds >= 0) retryAfterMs = retryAfterMs === null ? seconds * 1000 : Math.min(retryAfterMs, seconds * 1000);
        console.warn(`Limite de uso da IA atingido (${model}); tentando o próximo modelo.`);
        limited.push(model);
        limitBody = body;
        continue;
      }
      const hint = res.status === 401 || res.status === 403 ? ' Confira LLM_API_KEY.' : '';
      throw new LLMError(`A IA respondeu HTTP ${res.status} (modelo ${model}): ${excerpt(body)}${hint}`, {
        status: res.status,
        retryable: res.status >= 500,
      });
    }
    let content;
    try {
      content = JSON.parse(body).choices[0].message.content;
    } catch {
      content = null;
    }
    if (typeof content !== 'string') throw new LLMError(`Resposta inesperada da IA (modelo ${model}): ${excerpt(body)}`);
    return extractJson(content);
  }
  if (limited.length) {
    throw new LLMError(`A IA respondeu HTTP 429 (limite de uso atingido em ${limited.join(', ')}): ${excerpt(limitBody)}`, {
      status: 429, retryable: true, retryAfterMs,
    });
  }
  throw new LLMError(`Nenhum modelo de IA disponível: ${unavailable.join(', ')}. Confira LLM_MODEL e LLM_BASE_URL.`);
}

// ---------------------------------------------------------------- prompt

function genderLine(child) {
  return {
    menino: 'um menino (use pronomes masculinos)',
    menina: 'uma menina (use pronomes femininos)',
  }[child.gender] || 'uma criança (não marque gênero; prefira repetir o nome)';
}

// Monta o pedido da história já com os apelidos (nada de nome real).
export function buildStoryMessages(child, themeKey, previous = [], feedback = []) {
  const hide = (text) => hideNames(text, child);
  const { name, pet } = aliasesFor(child);
  const [minWords, maxWords] = wordTarget(child.age);
  // Interesses do catálogo vão como estão; qualquer outro texto passa pelo filtro de nomes
  let interests = (child.interests || []).map((i) => (INTERESTS.includes(i) ? i : hide(i))).join(', ')
    || 'brincar e descobrir coisas novas';
  if (child.interests_extra) interests += `; os pais contam também: ${maskBrands(hide(child.interests_extra))}`;
  const themeDesc = Object.hasOwn(THEMES, themeKey) ? THEMES[themeKey][1] : 'uma aventura divertida';

  const lines = [
    'Escreva uma história infantil NOVA e original para ler em voz alta na hora de dormir.',
    '',
    `Protagonista: ${name}, ${child.age} anos, ${genderLine(child)}. Use o nome ${name} várias vezes.`,
    `Coisas de que ${name} gosta: ${interests}.`,
  ];
  if (child.pet_type && child.pet_name) {
    lines.push(`Participa da história o ${child.pet_type} de estimação, chamado ${pet}.`);
  }
  lines.push(
    `Lição da história: ${themeDesc}. Mostre a lição pelas ações, sem dar sermão.`,
    `Tamanho: entre ${minWords} e ${maxWords} palavras no total, em 4 ou 5 cenas `
      + `(cada cena com ${Math.floor(minWords / 4)} a ${Math.floor(maxWords / 4)} palavras).`,
    'Linguagem simples, frases curtas, diálogos, onomatopeias e um final calmo e aconchegante.',
    `A última cena termina com ${name} tranquilo(a), pronto(a) para dormir.`,
    'Nada de violência, sustos fortes, perigo real, morte, vilões malvados ou personagens de marcas famosas '
      + '(se os pais citarem algum, crie um personagem original parecido).',
    '',
    'Para cada cena escolha o cenário (campo "cenario") usando exatamente uma destas palavras: '
      + Object.entries(SCENES).map(([k, v]) => `${k} (${v})`).join(', ') + '.',
    'Varie os cenários: no máximo duas cenas no mesmo cenário.',
    'Use "noite": true quando a cena se passa à noite.',
  );
  if (previous && previous.length) {
    lines.push('', 'Histórias anteriores desta criança (NÃO repita enredos nem títulos):');
    lines.push(...previous.map((p) => `- ${hide(p.title)}: ${hide(p.summary)}`));
  }
  if (feedback && feedback.length) {
    lines.push('', 'Uma versão anterior foi reprovada. Corrija estes problemas:');
    lines.push(...feedback.map((f) => `- ${hide(f)}`));
  }
  lines.push(
    '',
    'Responda somente com JSON neste formato:',
    '{"titulo": "...", "resumo": "uma frase", "licao": "uma frase", '
      + '"cenas": [{"cenario": "jardim", "noite": false, "texto": "..."}]}',
  );
  const system = 'Você é um autor premiado de histórias infantis brasileiras. Escreve em português do Brasil correto, '
    + 'com carinho, humor e imaginação. Responde somente com JSON válido.';
  return [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }];
}

// ---------------------------------------------------------------- validação

function normalizeScene(value) {
  const key = fold(value || '').trim().replaceAll(' ', '_').replaceAll('-', '_');
  if (Object.hasOwn(SCENES, key)) return key;
  for (const scene of Object.keys(SCENES)) {
    if (key.includes(scene.split('_')[0])) return scene;
  }
  return 'jardim';
}

// Restos de JSON que modelos pequenos às vezes deixam no fim do texto, ex.: 'diferente.”} , 152, 0,'
const JSON_TAIL = /(?:["”]\s*[}\]]*\s*(?:,\s*\d*\s*)+|["”]?\s*[}\]]+\s*,?\s*)$/;

// Modelos pequenos às vezes "vazam" pedaços do JSON no título; corta no primeiro sinal disso.
const TITLE_LEAK = new RegExp(`[“”"{}]|(?<!${LETTER})cen[áa]rio(?!${LETTER})`, 'u');

function cleanText(text) {
  let out = String(text || '').replace(/[*_#`]+/g, '');
  out = out.replace(/[ \t]+/g, ' ').trim();
  return out.replace(JSON_TAIL, '').trim();
}

const truthy = (value) => (typeof value === 'string'
  ? ['true', 'sim', '1'].includes(value.trim().toLowerCase())
  : Boolean(value));

export function storyText(story) {
  return story.cenas.map((scene) => scene.texto).join('\n\n');
}

// Normaliza a história e devolve { story, problems }. Lista vazia = aprovada.
export function validateStory(data, child) {
  const input = data && typeof data === 'object' ? data : {};
  const problems = [];
  const scenes = [];
  for (const raw of Array.isArray(input.cenas) ? input.cenas : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const texto = cleanText(raw.texto);
    if (texto.length < 30) continue;
    scenes.push({ cenario: normalizeScene(raw.cenario), noite: truthy(raw.noite), texto });
  }
  const title = cleanText(input.titulo).split(TITLE_LEAK)[0].replace(/^[ ,.:;-]+|[ ,.:;-]+$/g, '');
  const story = {
    titulo: cut(title, 90),
    resumo: cut(cleanText(input.resumo), 300),
    licao: cut(cleanText(input.licao), 300),
    cenas: scenes,
  };
  if (!story.titulo) problems.push('A história não tem título.');
  if (scenes.length < 3 || scenes.length > 7) {
    problems.push(`A história deve ter de 4 a 5 cenas (veio com ${scenes.length}).`);
  }

  const full = scenes.length ? storyText(story) : '';
  const words = countWords(full);
  const [minWords, maxWords] = wordTarget(child.age);
  if (words < minWords * 0.6) {
    problems.push(`História curta demais (${words} palavras). Escreva entre ${minWords} e ${maxWords} palavras.`);
  } else if (words > maxWords * 1.6) {
    problems.push(`História longa demais (${words} palavras). Escreva entre ${minWords} e ${maxWords} palavras.`);
  }

  if (/[{}]|"(?:cenario|texto|noite)"/.test(full)) {
    problems.push('O texto das cenas veio com pedaços de código/JSON. Escreva só a história.');
  }

  const name = String(child.name ?? '').trim();
  if (name) {
    const hits = [...nfd(full).matchAll(bounded(loosePattern(name), 'giu'))].length;
    if (hits < 2) problems.push(`O nome da criança (${name}) precisa aparecer na história várias vezes.`);
  }

  const lowered = `${story.titulo}\n${full}`.toLowerCase();
  for (const pattern of BANNED_PATTERNS) {
    const match = lowered.match(pattern);
    if (match) problems.push(`Remova a palavra imprópria para crianças: "${match[0]}".`);
  }
  const ownNames = new Set(
    [child.name, child.pet_name, ...Object.values(ALIASES), ...Object.values(SPARE_ALIASES)]
      .filter(Boolean).map((n) => fold(n).trim()),
  );
  for (const brand of BRANDS) {
    if (!ownNames.has(fold(brand)) && bounded(loosePattern(brand)).test(nfd(lowered))) {
      problems.push(`Não use personagens ou marcas protegidas ("${brand}"). Crie um personagem original.`);
    }
  }
  return { story, problems };
}

// ---------------------------------------------------------------- revisão e geração

// Segunda passada da IA, como revisora (também só com apelidos). Devolve os problemas (vazia = aprovada).
export async function reviewStory(story, child) {
  const hide = (text) => hideNames(text, child);
  const { name } = aliasesFor(child);
  const messages = [
    { role: 'system', content: 'Você é um revisor cuidadoso de livros infantis brasileiros. Responde somente com JSON.' },
    {
      role: 'user',
      content: `Revise a história abaixo, escrita para ${name}, de ${child.age} anos.\n`
        + 'Reprove SOMENTE se houver: conteúdo assustador, violento ou impróprio para crianças; texto incoerente '
        + 'ou sem sentido; erros graves de português; personagens de marcas famosas. '
        + 'Questões de gosto ou estilo NÃO são motivo para reprovar.\n'
        + 'Responda: {"aprovada": true ou false, "problemas": ["..."]}\n\n'
        + `TÍTULO: ${hide(story.titulo)}\n\n${hide(storyText(story))}`,
    },
  ];
  if (leaksRealName(messages, child)) throw new LLMError(PRIVACY_BLOCK);
  const result = await chatJSON(messages, { temperature: 0.1 });
  const list = Array.isArray(result.problemas) ? result.problemas : [result.problemas].filter(Boolean);
  const problems = list.map((p) => String(p ?? '').trim()).filter(Boolean);
  const rejected = result.aprovada === false || String(result.aprovada).toLowerCase() === 'false';
  return rejected && problems.length ? problems : [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRIVACY_BLOCK = 'Proteção de privacidade: o pedido para a IA ainda tinha o nome real; nada foi enviado.';

// Gera, valida e revisa uma história. Tenta até MAX_ATTEMPTS vezes antes de desistir.
export async function generateStory(child, themeKey, previous = []) {
  if (config.llmProvider === 'demo') {
    const { story, problems } = validateStory(demoStory(child, themeKey), child);
    if (problems.length) throw new StoryGenerationError(problems.join('; '));
    return story;
  }

  const masked = aliasChild(child);
  let feedback = [];
  let lastError = '';
  let retryable = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let data;
    const messages = buildStoryMessages(child, themeKey, previous, feedback);
    if (leaksRealName(messages, child)) throw new StoryGenerationError(PRIVACY_BLOCK);
    try {
      data = await chatJSON(messages);
    } catch (err) {
      if (!(err instanceof LLMError)) throw err;
      console.warn(`Tentativa ${attempt}: ${err.message}`);
      feedback = [];
      lastError = err.message;
      retryable = err.retryable;
      if (err.retryAfterMs && attempt < MAX_ATTEMPTS) await sleep(Math.min(err.retryAfterMs, MAX_WAIT_MS));
      continue;
    }
    retryable = false;
    const { story, problems: found } = validateStory(data, masked);
    let problems = found.length ? found : aliasProblems(story, child);
    if (!problems.length && config.llmReview) {
      try {
        problems = await reviewStory(story, child);
      } catch (err) {
        if (!(err instanceof LLMError)) throw err;
        console.warn(`Revisão falhou (seguindo sem ela): ${err.message}`);
      }
    }
    if (!problems.length) {
      // Título e resumo com apelidos: é o que vai para a IA como "histórias anteriores" no futuro,
      // mesmo que os pais troquem o nome da criança ou do bichinho depois.
      return { ...restoreNames(story, child), promptTitle: story.titulo, promptSummary: story.resumo };
    }
    console.log(`Tentativa ${attempt} reprovada: ${problems.join('; ')}`);
    feedback = problems;
    lastError = problems.join('; ');
  }
  throw new StoryGenerationError(
    `Não consegui gerar uma história aprovada em ${MAX_ATTEMPTS} tentativas: ${restoreText(lastError, child)}`,
    { retryable },
  );
}

// ---------------------------------------------------------------- história de demonstração

// Bichinho de estimação: diminutivo, reação e jeito de ajudar
const DEMO_PETS = {
  cachorro: {
    noun: 'cachorrinho',
    react: (p) => `${p} abanou o rabo e latiu bem feliz: au-au!`,
    help: 'abanando o rabo e fazendo todo mundo rir',
  },
  gato: {
    noun: 'gatinho',
    react: (p) => `${p} se espreguiçou e ronronou bem alto: rrrrom, rrrrom!`,
    help: 'ronronando para deixar todo mundo calminho',
  },
  coelho: {
    noun: 'coelhinho',
    react: (p) => `${p} deu três pulinhos e mexeu o narizinho, de tanta alegria.`,
    help: 'dando pulinhos de alegria',
  },
};
const DEMO_PET_DEFAULT = {
  noun: 'bichinho de estimação',
  react: (p) => `${p} pulou de alegria.`,
  help: 'fazendo companhia o tempo todo',
};

// Lugares mágicos: cenário do ilustrador, descrição e o amigo que a criança conhece lá
const DEMO_PLACES = {
  floresta: {
    nome: 'a Floresta dos Cogumelos Brilhantes',
    da: 'da Floresta dos Cogumelos Brilhantes',
    titulo: 'a Corujinha de Óculos',
    desc: [
      'As árvores eram tão altas que pareciam fazer cócegas nas nuvens, e os cogumelos brilhavam como lanterninhas coloridas.',
      'Um riacho cantava glub-glub entre as pedras, e o chão era fofinho como um tapete de musgo.',
      'Esquilos apostavam corrida nos galhos, e as borboletas pareciam pedacinhos de arco-íris voando por todo lado.',
    ],
    amigo: {
      apresenta: 'uma corujinha de óculos redondos chamada Lume', nome: 'Lume', fem: true,
      extra: 'Lume sabia o nome de todas as árvores e piscava os olhões bem devagar sempre que pensava.',
    },
  },
  praia: {
    nome: 'a Praia das Conchas Cantoras',
    da: 'da Praia das Conchas Cantoras',
    titulo: 'o Caranguejo Pequenino',
    desc: [
      'A areia era branquinha e macia, e as ondas chegavam devagar, fazendo chuá, chuá, como quem conta um segredo.',
      'Cada concha encostada no ouvido cantava uma musiquinha diferente.',
      'Gaivotas desenhavam círculos no céu, e o mar brilhava como se alguém tivesse espalhado purpurina na água.',
    ],
    amigo: {
      apresenta: 'um caranguejo pequenino chamado Tico', nome: 'Tico', fem: false,
      extra: 'Tico andava de lado, sempre de lado, e acenava com as duas garrinhas para todo mundo que passava.',
    },
  },
  castelo: {
    nome: 'o Castelo das Nuvens',
    da: 'do Castelo das Nuvens',
    titulo: 'o Dragão de Bolhas',
    desc: [
      'As torres eram feitas de nuvem fofinha, e as bandeirinhas lá no alto balançavam para dar boas-vindas.',
      'Na entrada, uma escada em caracol subia, subia, e cada degrau tocava uma nota de música: dó, ré, mi!',
      'Lá dentro havia almofadas gigantes, janelas redondas e um jardim suspenso cheio de flores que davam risadinhas.',
    ],
    amigo: {
      apresenta: 'um dragãozinho que soltava bolhas de sabão em vez de fogo, chamado Faísca', nome: 'Faísca', fem: false,
      extra: 'Quando Faísca ficava contente, as bolhas saíam em formato de coração e flutuavam pelo salão.',
    },
  },
  espaco: {
    nome: 'a Lua de Algodão',
    da: 'da Lua de Algodão',
    titulo: 'a Estrelinha Cintila',
    desc: [
      'Tudo ali era macio e prateado, e dava para pular tão alto que o corpo parecia uma pena.',
      'Lá longe, os planetas giravam devagar: um azul, um laranja e outro com anéis coloridos como um pião.',
      'Cometas passavam riscando o céu, deixando rastros de brilho que pareciam fitas de presente.',
    ],
    amigo: {
      apresenta: 'uma estrelinha chamada Cintila', nome: 'Cintila', fem: true,
      extra: 'Cintila tinha cinco pontinhas que acendiam uma de cada vez, como um pisca-pisca de Natal.',
    },
  },
  fazenda: {
    nome: 'a Fazenda do Arco-Íris',
    da: 'da Fazenda do Arco-Íris',
    titulo: 'a Ovelhinha Nuvem',
    desc: [
      'Havia um celeiro vermelho, uma horta cheia de verduras e um arco-íris que terminava bem em cima do moinho.',
      'A vaca fazia muuu, o galo fazia cocoricó, e os patinhos marchavam em fila até o laguinho: quá, quá, quá!',
      'O cheirinho de pão de milho saía da cozinha, e as galinhas ciscavam felizes pelo terreiro.',
    ],
    amigo: {
      apresenta: 'uma ovelhinha chamada Nuvem', nome: 'Nuvem', fem: true,
      extra: 'Nuvem tinha a lã tão branquinha e fofa que parecia mesmo um pedaço do céu.',
    },
  },
};

// Cada tema: o problema do amigo, a solução, um trecho extra e a reflexão na hora de dormir
const DEMO_THEMES = {
  coragem: {
    resumo: 'descobre que ter coragem é dar o primeiro passo, mesmo com um friozinho na barriga',
    licao: 'Coragem é dar o primeiro passo, mesmo com um friozinho na barriga.',
    beats: (n, f) => ({
      problema: `${f.nome} precisava buscar uma semente mágica do outro lado de um caminho escurinho, mas tremia só de olhar para ele. — Eu tenho medo — confessou ${f.nome}, baixinho.`,
      acao: `${n} também sentiu um friozinho na barriga. Mas respirou fundo, contou até três e disse: — Vamos lá, passinho por passinho? E lá se foi a dupla, de mãos dadas, cantarolando uma música para espantar o medo. No fim do caminho, a semente mágica brilhava no meio de um campo de flores.`,
      mais: `${f.nome} plantou a semente ali mesmo, e na mesma hora nasceu uma flor que brilhava como um farolzinho, iluminando todo o caminho de volta.`,
      reflexao: `${n} pensou em como o caminho escurinho ficou pequeno depois do primeiro passo. Ter coragem não é deixar de sentir medo: é seguir em frente mesmo com o coração fazendo tum-tum.`,
    }),
  },
  amizade: {
    resumo: 'aprende que um convite para brincar pode ser o começo de uma grande amizade',
    licao: 'Um simples convite para brincar pode ser o começo de uma grande amizade.',
    beats: (n, f) => ({
      problema: `${f.nome} estava num cantinho, olhando os outros bichinhos brincarem. — Eu queria ter amigos, mas não sei como começar — contou ${f.nome}, com a voz bem baixinha.`,
      acao: `${n} sorriu e estendeu a mão: — É fácil! A gente começa assim: oi, quer brincar comigo? Então ${n} e ${f.nome} brincaram de pega-pega, de esconde-esconde e de inventar músicas engraçadas. Logo os outros bichinhos chegaram perto, curiosos, e a roda de brincadeira foi ficando cada vez maior.`,
      mais: 'No fim da tarde, todos se sentaram em roda e combinaram de brincar de novo no dia seguinte.',
      reflexao: `${n} pensou em ${f.nome} e na roda de novos amigos. Ser amigo é chamar para brincar, ouvir com carinho e dividir as risadas.`,
    }),
  },
  dividir: {
    resumo: 'descobre que dividir e esperar a vez deixa a brincadeira mais gostosa',
    licao: 'Dividir e esperar a vez deixa a brincadeira ainda mais gostosa.',
    beats: (n, f) => ({
      problema: `${f.nome} tinha uma bola mágica, que mudava de cor a cada quique, e não queria emprestar para ninguém. Mas brincar sem companhia logo ficou sem graça, e ${f.nome} suspirou.`,
      acao: `${n} teve uma ideia: — E se todo mundo brincar junto, cada um na sua vez? Formaram uma fila, e cada um jogava a bola uma vez: primeiro ${f.nome}, depois ${n}, depois os outros bichinhos. Esperar a vez nem pareceu demorado, porque todo mundo torcia, batia palmas e ria junto.`,
      mais: `${f.nome} descobriu que a bola ficava ainda mais colorida quando passava por muitas mãos, como se gostasse de ser dividida.`,
      reflexao: `${n} lembrou da bola colorida pulando de mão em mão. Quando a gente divide, a brincadeira fica maior e a alegria também.`,
    }),
  },
  dormir: {
    resumo: 'descobre que o escuro é só o dia descansando',
    licao: 'O escuro é só o dia descansando, e a noite é feita para sonhar.',
    beats: (n, f) => ({
      problema: `${f.nome} contou um segredo: — Eu não gosto da noite. Quando fica tudo escuro, tenho medo de dormir.`,
      acao: `${n} pensou um pouquinho e teve uma ideia. Então ${n} e ${f.nome} entraram numa cabaninha bem escurinha e ficaram em silêncio, prestando atenção. No escurinho havia coisas boas: o barulhinho do vento lá fora, a respiração calma de cada um e, pelas frestas, pontinhos de luz que pareciam estrelas. — Viu? O escuro é só o dia descansando — disse ${n}, e ${f.nome} sorriu.`,
      mais: `Quando saíram da cabaninha, ${f.nome} disse que nunca mais ia ter medo do escuro, porque agora sabia escutar o silêncio.`,
      reflexao: `${n} olhou pela janela, para o céu escurinho, e sorriu. O escuro não assustava mais: era só o mundo apagando a luz para todo mundo descansar.`,
    }),
  },
  irmao: {
    resumo: 'descobre que irmãos são companheiros para cuidar, ensinar e amar',
    licao: 'Irmãos são companheiros para cuidar, ensinar e amar.',
    beats: (n, f) => ({
      problema: `${f.nome} estava com cara de chateação: — Agora tenho um irmãozinho, e todo mundo só presta atenção nele.`,
      acao: `${n} pensou um pouquinho e disse: — Irmãozinhos são pequenos e ainda não sabem brincar direito. Mas a gente pode ensinar! Então ${n} e ${f.nome} mostraram ao irmãozinho como fazer caretas engraçadas, e o pequeno deu a risada mais gostosa do mundo. ${f.nome} riu também, com o peito cheio de orgulho.`,
      mais: `O irmãozinho agarrou o dedo de ${f.nome} com a mãozinha pequenina e não quis mais soltar.`,
      reflexao: `${n} lembrou da risada do irmãozinho de ${f.nome}. Ter um irmão ou uma irmã é ganhar alguém para cuidar, ensinar e amar.`,
    }),
  },
  escola: {
    resumo: 'descobre que a escola é lugar de aprender, brincar e fazer amigos',
    licao: 'A escola é lugar de aprender, brincar e fazer novos amigos.',
    beats: (n, f) => ({
      problema: `${f.nome} ia começar na escolinha no dia seguinte e estava com um nó de preocupação na barriga: — E se eu não souber fazer nada? E se ninguém brincar comigo?`,
      acao: `${n} contou tudo de bom que acontece na escola: tem tinta para pintar, história na roda, lanche com os colegas e uma professora que adora ensinar. Para treinar, ${n} e ${f.nome} brincaram de escolinha com uma lousa de mentirinha, e cada um teve a sua vez de ser a professora. No fim, ${f.nome} já estava contando os minutos para o primeiro dia de aula.`,
      mais: `${f.nome} até treinou como dizer oi para os colegas novos, com o sorriso mais bonito que tinha.`,
      reflexao: `${n} pensou na escola com um sorriso. Lá é lugar de aprender coisas novas, fazer amigos e descobrir que errar também faz parte de aprender.`,
    }),
  },
  natureza: {
    resumo: 'aprende que cuidar da natureza é cuidar da casa de todos',
    licao: 'Cuidar dos animais e das plantas é cuidar da casa de todos nós.',
    beats: (n, f) => ({
      problema: `${f.nome} mostrou o cantinho preferido, todo cheio de papéis e garrafinhas jogados no chão. — Assim as plantinhas não conseguem crescer, e os passarinhos foram embora — disse ${f.nome}, com um suspiro.`,
      acao: `${n} arregaçou as mangas: — Vamos cuidar disso agora mesmo! Recolheram cada papel, separaram as garrafinhas para reciclar e regaram as florzinhas com um regador em forma de elefante. Pouco a pouco, as flores levantaram a cabeça, e os passarinhos voltaram, cantando piu-piu de alegria.`,
      mais: `Uma borboleta azul pousou no nariz de ${n}, como quem diz obrigado, e todo mundo caiu na risada.`,
      reflexao: `${n} lembrou das flores levantando a cabeça. Cuidar da natureza é cuidar da nossa casa, que é de todos os bichos, de todas as plantas e de todas as pessoas.`,
    }),
  },
  gentileza: {
    resumo: 'descobre a força das palavrinhas mágicas: por favor e obrigado',
    licao: 'Por favor, obrigado e com licença são palavrinhas mágicas que abrem corações.',
    beats: (n, f) => ({
      problema: `${f.nome} estava triste porque tinha pedido ajuda de um jeito muito mandão, e ninguém quis ajudar. — Me dá isso agora! — tinha gritado ${f.nome}.`,
      acao: `${n} contou o segredo das palavrinhas mágicas: por favor, obrigado e com licença. ${f.nome} tentou de novo, com a voz bem gentil: — Vocês podem me ajudar, por favor? Na mesma hora, todos vieram ajudar. — Muito ${f.fem ? 'obrigada' : 'obrigado'}! — agradeceu ${f.nome}, com um sorriso enorme.`,
      mais: `Daquele dia em diante, ${f.nome} espalhou palavrinhas mágicas por onde passava, e todo mundo sorria de volta.`,
      reflexao: `${n} pensou nas palavrinhas mágicas e em como elas abrem portas e corações. Ser gentil é fácil e deixa o dia de todo mundo mais bonito.`,
    }),
  },
  emocoes: {
    resumo: 'descobre que falar sobre os sentimentos deixa o coração mais leve',
    licao: 'Falar sobre o que sentimos deixa o coração mais leve.',
    beats: (n, f) => ({
      problema: `${f.nome} estava com uma nuvem cinzenta por dentro e nem sabia explicar por quê. Às vezes dava vontade de chorar, às vezes de bater o pé.`,
      acao: `${n} segurou a mão de ${f.nome} e disse: — Quando eu fico triste, ajuda contar para alguém o que estou sentindo. ${f.nome} respirou fundo e contou tudo: era saudade da vovó, que morava longe. Só de falar, a nuvem cinzenta foi ficando menor, menor, até virar uma nuvenzinha branquinha.`,
      mais: 'Depois, a dupla desenhou um cartão bem colorido para mandar para a vovó, cheio de corações e estrelinhas.',
      reflexao: `${n} pensou na nuvenzinha que ficou branquinha. Todo sentimento pode ser dito em voz alta, e falar sobre o que a gente sente deixa o coração mais leve.`,
    }),
  },
  alimentacao: {
    resumo: 'descobre que experimentar comidas novas pode ser uma grande surpresa',
    licao: 'Experimentar comidas novas é descobrir sabores que a gente nem imaginava.',
    beats: (n, f) => ({
      problema: `Na hora do lanche, ${f.nome} torceu o nariz para uma fruta que nunca tinha provado: — Eca! Essa cor é esquisita, não quero comer.`,
      acao: `${n} pegou um pedacinho e disse: — Que tal provar só uma mordidinha, junto comigo? Nhac! A fruta era docinha, suculenta e fazia cosquinha na língua. — Hum, que delícia! — disse ${f.nome}, e pediu mais um pedaço.`,
      mais: 'Depois, a dupla ainda provou uma cenoura crocante e um pedacinho de pão de queijo quentinho.',
      reflexao: `${n} lembrou da fruta de cor esquisita que era tão gostosa. Experimentar comidas novas é como abrir um presente: a gente só descobre o que tem dentro depois de provar.`,
    }),
  },
  persistencia: {
    resumo: 'aprende que tentar mais uma vez faz toda a diferença',
    licao: 'Quando algo é difícil, tentar mais uma vez faz toda a diferença.',
    beats: (n, f) => ({
      problema: `${f.nome} tentava empinar uma pipa, mas toda vez ela caía no chão: plof! — Não consigo, vou desistir — disse ${f.nome}.`,
      acao: `${n} ajudou a arrumar a rabiola e disse: — Vamos tentar mais uma vez! Na segunda tentativa, a pipa subiu um pouquinho. Na terceira, um pouco mais. E na quarta, o vento pegou a pipa, que dançou lá no alto, colorida como um arco-íris. ${f.nome} pulava de alegria.`,
      mais: `${f.nome} aprendeu que cada tentativa ensina um pouquinho, e que desistir cedo demais faz a gente perder o melhor da festa.`,
      reflexao: `${n} pensou na pipa dançando no céu. Quando algo é difícil, a gente tenta de novo, um pouquinho de cada vez, até conseguir.`,
    }),
  },
  imaginacao: {
    resumo: 'descobre que, com imaginação, até uma caixa vazia vira uma aventura',
    licao: 'Com imaginação, até uma caixa vazia vira uma grande aventura.',
    beats: (n, f) => ({
      problema: `${f.nome} estava sem ideias: — Já brinquei de tudo, não tem mais nada para fazer.`,
      acao: `${n} encontrou uma caixa de papelão vazia e sorriu: — Isto não é uma caixa. É um navio! Ou um foguete! Ou um castelo! E a caixa virou tudo isso e muito mais. ${n} e ${f.nome} navegaram por mares de mentirinha, voaram até planetas inventados e deram nome a cada estrela que criaram.`,
      mais: 'No fim, a caixa voltou a ser só uma caixa, mas cheia de lembranças de mentirinha que pareciam de verdade.',
      reflexao: `${n} lembrou da caixa que virou navio, foguete e castelo. Com imaginação, qualquer coisa pode virar uma grande aventura.`,
    }),
  },
};

const DEMO_MAX_LEVEL = 3;

// História de modelo fixo (sem IA). Usa o nome real: nada sai do servidor.
// Cada frase tem um nível; histórias para crianças maiores incluem mais níveis.
export function demoStory(child, themeKey) {
  const n = String(child.name ?? '').trim();
  const theme = DEMO_THEMES[themeKey] || DEMO_THEMES.imaginacao;
  const placeKeys = Object.keys(DEMO_PLACES);
  const placeKey = placeKeys[crypto.createHash('sha1').update(`${n}-${themeKey}`).digest()[0] % placeKeys.length];
  const place = DEMO_PLACES[placeKey];
  const friend = place.amigo;
  const petName = String(child.pet_name ?? '').trim();
  const pet = petName ? DEMO_PETS[child.pet_type] || DEMO_PET_DEFAULT : null;
  const who = pet ? `${n} e ${petName}` : n;
  const verb = (one, many) => (pet ? many : one);
  const intro = {
    menino: `Era uma vez um menino chamado ${n}`,
    menina: `Era uma vez uma menina chamada ${n}`,
  }[child.gender] || `Era uma vez uma criança chamada ${n}`;
  const b = theme.beats(n, friend);

  const scenes = [
    {
      cenario: 'quarto',
      noite: false,
      parts: [
        [0, `${intro}, que adorava descobrir coisas novas.`],
        pet && [0, `${n} morava com o ${pet.noun} ${petName}, companheiro de todas as brincadeiras.`],
        [1, `Todas as manhãs, ${n} abria a janela, se espreguiçava bem devagarinho e dava bom dia para o sol.`],
        [2, 'Era um dia de céu azulzinho, sem nenhuma nuvem de chuva, perfeito para uma aventura.'],
        [0, 'Naquela manhã, um aviãozinho de papel entrou voando pela janela e pousou, de levinho, em cima do travesseiro.'],
        [0, `Nele estava escrito, com letrinhas coloridas: venha conhecer ${place.nome}!`],
        [2, `${n} leu o recado duas vezes, só para ter certeza, e deu uma risadinha de alegria.`],
        pet && [0, pet.react(petName)],
        [0, `Quando ${n} segurou o aviãozinho, ele cresceu, cresceu, até ficar do tamanho de um tapete. ${who} ${verb('subiu', 'subiram')} nele e, zuuum, lá ${verb('foi', 'foram')} pelo céu!`],
        [1, 'Lá de cima, as casas pareciam pecinhas de brinquedo, e as nuvens faziam cosquinha no nariz.'],
        [2, 'O vento assobiava fiu-fiu, e os passarinhos voavam ao lado, como se quisessem apostar corrida.'],
        [3, `No caminho, ${verb('passou', 'passaram')} por cima de um rio que brilhava como uma fita prateada e de montanhas que pareciam sorvete de creme.`],
      ],
    },
    {
      cenario: placeKey,
      noite: false,
      parts: [
        [0, `${who} ${verb('pousou', 'pousaram')} bem no meio ${place.da}.`],
        [0, place.desc[0]],
        [1, place.desc[1]],
        [2, place.desc[2]],
        [3, `${n} olhava para todos os lados, querendo ver tudo ao mesmo tempo, com os olhos arregalados de encanto.`],
        [0, `Foi ali que ${n} conheceu ${friend.apresenta}.`],
        [1, friend.extra],
        [0, b.problema],
        [2, `${n} sentou bem pertinho e escutou com atenção, porque ouvir com carinho também é um jeito de ajudar.`],
      ],
    },
    {
      cenario: placeKey,
      noite: false,
      parts: [
        [0, b.acao],
        [2, b.mais],
        pet && [1, `${petName} também ajudou do seu jeitinho, ${pet.help}.`],
        [1, `${friend.nome} deu um abraço bem apertado em ${n} e disse que aquele tinha sido o dia mais feliz de todos.`],
        [2, `Depois, todo mundo fez um piquenique com suco de frutas e biscoitinhos em forma de estrela, e ${n} riu tanto que até soluçou: hic!`],
        [0, `Quando o céu começou a ficar cor de laranja, ${n} percebeu que estava na hora de voltar para casa.`],
        [1, `— Volte sempre que quiser! — disse ${friend.nome}, acenando com carinho.`],
        [3, 'O tapete de papel subiu outra vez, leve como uma folha, e fez o caminho de volta entre nuvens cor-de-rosa e passarinhos sonolentos.'],
      ],
    },
    {
      cenario: 'quarto',
      noite: true,
      parts: [
        [0, 'O tapete de papel pousou de mansinho no quarto e encolheu até virar de novo um aviãozinho pequenininho.'],
        [0, `${n} vestiu o pijama, escovou os dentes e se aconchegou debaixo das cobertas.`],
        pet && [0, `${petName} se ajeitou aos pés da cama e logo começou a cochilar.`],
        [2, 'Pela janela entrava um ventinho fresco com cheiro de flor, e a casa inteira já estava em silêncio.'],
        [0, b.reflexao],
        [3, 'Lembrou também de cada cor, de cada som e de cada risada daquele dia tão especial.'],
        [1, 'Lá fora, a lua brilhava redondinha, e as estrelas piscavam devagar, como quem canta uma canção de ninar.'],
        [2, `${n} guardou o aviãozinho na gaveta, bem guardadinho, para outra aventura qualquer dia desses.`],
        [3, `Antes de dormir, pensou em ${friend.nome}, que lá longe também devia estar se preparando para descansar.`],
        [1, `Os olhinhos foram ficando pesados, pesados... e um sorriso tranquilo apareceu no rosto de ${n}.`],
        [0, `Boa noite, ${n}. Bons sonhos!`],
      ],
    },
  ];

  // Escolhe o menor nível que alcança o tamanho mínimo para a idade, sem passar do máximo.
  const textAt = (scene, level) => scene.parts.filter((p) => p && p[0] <= level).map((p) => p[1]).join(' ');
  const wordsAt = (level) => scenes.reduce((sum, scene) => sum + countWords(textAt(scene, level)), 0);
  const [minWords, maxWords] = wordTarget(child.age);
  let level = 0;
  while (level < DEMO_MAX_LEVEL && wordsAt(level) < minWords) level += 1;
  if (level > 0 && wordsAt(level) > maxWords) level -= 1;

  return {
    titulo: `${n} e ${place.titulo}`,
    resumo: `Numa viagem até ${place.nome}, ${n} ${theme.resumo}.`,
    licao: theme.licao,
    cenas: scenes.map((scene) => ({ cenario: scene.cenario, noite: scene.noite, texto: textAt(scene, level) })),
  };
}
