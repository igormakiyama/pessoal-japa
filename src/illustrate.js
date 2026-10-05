// Ilustrador vetorial: desenha cada cena com o avatar da criança.
//
// Roda na hora, na CPU, sem custo, e mantém a criança com a mesma aparência em
// todas as histórias. A IA escolhe o cenário de cada cena; o ilustrador compõe o desenho.
// O desenho é montado como uma árvore de formas (o "IR"), que vira SVG (toSVG) ou PDF (pdf.js).
import crypto from 'node:crypto';
import { escapeHtml } from './html.js';
import {
  DEFAULT_APPEARANCE, EYE_COLORS, FAVORITE_COLORS, HAIR_COLORS, SKIN_TONES,
} from './content.js';

const W = 800;
const H = 500;
const NIGHT_TINT = '#1E2350';

// ---------------------------------------------------------------- números e cores

// Até 2 casas decimais, sem zeros sobrando.
function fmt(value) {
  const r = Math.round(value * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

// A versão anterior escrevia escala e posição dos grupos com 1 casa (0.85 virava 0.8).
// Repetimos o arredondamento para o desenho sair igual ao que já foi entregue.
const q1 = (value) => Number(value.toFixed(1)) || 0;

// Arredondamento do Python (empate vai para o par).
function pyRound(value) {
  const r = Math.round(value);
  return r - value === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const hexToRgb = (color) => {
  const hex = color.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
};

function mix(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return '#' + ca.map((v, i) => pyRound(v + (cb[i] - v) * t).toString(16).toUpperCase().padStart(2, '0')).join('');
}

const pick = (table, key, fallback) => (Object.hasOwn(table, String(key)) ? table[key] : table[fallback]);

// ---------------------------------------------------------------- matrizes

export const translate = (x, y) => [1, 0, 0, 1, x, y];

export const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];

export function rotate(deg, cx = 0, cy = 0) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

// m1 x m2: aplica m2 primeiro (igual a transform="m1 m2" no SVG).
export function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

const place = (x, y, sx = 1, sy = sx) => multiply(translate(q1(x), q1(y)), scale(q1(sx), q1(sy)));

const applyMatrix = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

// Aplica a matriz a um caminho com comandos absolutos e pontos "x,y".
const mapPath = (d, m) => d.replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, x, y) => {
  const [px, py] = applyMatrix(m, Number(x), Number(y));
  return `${fmt(px)},${fmt(py)}`;
});

// ---------------------------------------------------------------- sorteio determinístico

// Mersenne Twister idêntico ao random.Random(texto) do Python: a mesma semente
// desenha exatamente a mesma cena que a versão anterior (histórias antigas não mudam).
const MT_N = 624;
const MT_M = 397;

class SeededRandom {
  constructor(seed) {
    const text = Buffer.from(String(seed), 'utf8');
    let bytes = Buffer.concat([text, crypto.createHash('sha512').update(text).digest()]);
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    bytes = bytes.subarray(start);
    // Inteiro big-endian -> palavras de 32 bits, da menos significativa para a mais.
    const key = [];
    for (let end = bytes.length; end > 0; end -= 4) {
      let word = 0;
      for (let i = Math.max(0, end - 4); i < end; i++) word = word * 256 + bytes[i];
      key.push(word >>> 0);
    }
    this.mt = new Uint32Array(MT_N);
    this.initByArray(key);
  }

  initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < MT_N; i++) {
      mt[i] = Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i;
    }
    this.index = MT_N;
  }

  initByArray(key) {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(MT_N, key.length); k > 0; k--) {
      mt[i] = (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j;
      i += 1;
      j += 1;
      if (i >= MT_N) { mt[0] = mt[MT_N - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = MT_N - 1; k > 0; k--) {
      mt[i] = (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i;
      i += 1;
      if (i >= MT_N) { mt[0] = mt[MT_N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  next32() {
    const mt = this.mt;
    if (this.index >= MT_N) {
      for (let k = 0; k < MT_N; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % MT_N] & 0x7fffffff);
        mt[k] = mt[(k + MT_M) % MT_N] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  // Número em [0, 1) com 53 bits, como random.random().
  random() {
    const a = this.next32() >>> 5;
    const b = this.next32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  uniform(a, b) {
    return a + (b - a) * this.random();
  }

  below(n) {
    const bits = 32 - Math.clz32(n);
    let r = this.next32() >>> (32 - bits);
    while (r >= n) r = this.next32() >>> (32 - bits);
    return r;
  }

  randint(a, b) {
    return a + this.below(b - a + 1);
  }

  choice(list) {
    return list[this.below(list.length)];
  }
}

// Contexto de desenho: sorteio determinístico e paleta dia/noite.
class Ctx {
  constructor(seed, night) {
    this.rng = new SeededRandom(seed);
    this.night = Boolean(night);
  }

  c(color, amount = 0.42) {
    return this.night ? mix(color, NIGHT_TINT, amount) : color;
  }
}

// ---------------------------------------------------------------- formas

const rect = (x, y, w, h, style) => ({ type: 'rect', x, y, w, h, ...style });
const circle = (cx, cy, r, style) => ({ type: 'circle', cx, cy, r, ...style });
const ellipse = (cx, cy, rx, ry, style) => ({ type: 'ellipse', cx, cy, rx, ry, ...style });
const path = (d, style) => ({ type: 'path', d, ...style });
const group = (transform, children) => ({ type: 'group', transform, children: children.filter(Boolean) });

// Traço sem preenchimento.
const line = (d, stroke, strokeWidth, extra) => path(d, { stroke, strokeWidth, ...extra });
const ROUND = { lineCap: 'round' };

// Elipse ou círculo como subcaminho fechado de 4 curvas, sempre no mesmo sentido: dá para
// unir formas num caminho só e aplicar a transparência uma vez (como a do grupo no SVG antigo).
// "deg" gira a elipse em torno do próprio centro. Curvas, e não arcos, porque arco de meia
// volta com pontas arredondadas desloca o centro e deixa a borda torta.
const KAPPA = 0.5522847498;

function ovalPath(cx, cy, rx, ry = rx, deg = 0) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const pt = (a, b) => `${fmt(cx + a * cos - b * sin)},${fmt(cy + a * sin + b * cos)}`;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  return `M${pt(rx, 0)} C${pt(rx, ky)} ${pt(kx, ry)} ${pt(0, ry)} `
    + `C${pt(-kx, ry)} ${pt(-rx, ky)} ${pt(-rx, 0)} `
    + `C${pt(-rx, -ky)} ${pt(-kx, -ry)} ${pt(0, -ry)} `
    + `C${pt(kx, -ry)} ${pt(rx, -ky)} ${pt(rx, 0)} Z`;
}

const vertical = (top, bottom) => ({ type: 'linear', x1: 0, y1: 0, x2: 0, y2: H, stops: [[0, top], [1, bottom]] });

// ---------------------------------------------------------------- personagens

// Desenha a criança com os pés em (x, y). Coordenadas locais: 200 x 300.
function avatar(appearance, x, y, s = 1, flip = false, shade = null) {
  const app = { ...DEFAULT_APPEARANCE, ...(appearance || {}) };
  const tone = shade || ((color) => color);
  const skin = tone(pick(SKIN_TONES, app.skin, 'media_clara'));
  const skinDark = mix(skin, '#000000', 0.12);
  const hair = tone(pick(HAIR_COLORS, app.hair_color, 'castanho'));
  const shirt = tone(pick(FAVORITE_COLORS, app.fav_color, 'azul'));
  const shirtDark = mix(shirt, '#000000', 0.15);
  const eye = pick(EYE_COLORS, app.eyes, 'castanhos');
  const pants = tone('#3D4F7A');
  const style = app.hair_style;

  const back = [];
  const front = [];
  if (style === 'liso_longo') {
    back.push(path('M36,100 C34,40 166,40 164,100 L168,214 Q100,232 32,214 Z', { fill: hair }));
    front.push(path('M38,118 C30,38 170,38 162,118 C156,92 146,80 132,74 C112,88 82,90 60,80 C48,90 42,104 38,118 Z',
      { fill: hair }));
  } else if (style === 'crespo') {
    back.push(circle(100, 88, 84, { fill: hair }));
    front.push(path('M44,100 C44,48 156,48 156,100 C148,82 126,72 100,72 C74,72 52,82 44,100 Z', { fill: hair }));
  } else if (style === 'cacheado') {
    for (const [cx, cy, r] of [[44, 118, 18], [156, 118, 18], [42, 150, 16], [158, 150, 16]]) {
      back.push(circle(cx, cy, r, { fill: hair }));
    }
    for (let i = 0; i < 9; i++) {
      const ang = 3.30 + i * (2.82 / 8);
      front.push(circle(100 + 60 * Math.cos(ang), 100 + 58 * Math.sin(ang), 19, { fill: hair }));
    }
  } else if (style === 'rabo') {
    back.push(path(ovalPath(166, 128, 20, 42, -18), { fill: hair }));
    front.push(path('M40,108 C38,42 162,42 160,108 C150,82 126,70 100,70 C74,70 50,82 40,108 Z', { fill: hair }));
    front.push(circle(156, 96, 8, { fill: shirt }));
  } else if (style === 'raspado') {
    front.push(path('M42,100 C42,46 158,46 158,100 C150,78 126,66 100,66 C74,66 50,78 42,100 Z',
      { fill: hair, opacity: 0.55 }));
  } else { // curto
    front.push(path('M40,108 C36,40 164,40 160,108 C154,86 140,74 124,70 C116,82 94,86 74,80 C60,84 46,94 40,108 Z',
      { fill: hair }));
  }

  const eyes = [];
  for (const ex of [80, 120]) {
    eyes.push(ellipse(ex, 112, 7.5, 9, { fill: eye }));
    eyes.push(circle(ex, 113, 4, { fill: '#1A1414' }));
    eyes.push(circle(ex + 2.5, 109, 2.6, { fill: '#FFFFFF' }));
  }
  const brows = [
    line('M70,96 Q80,90 90,96', hair, 3.5, ROUND),
    line('M110,96 Q120,90 130,96', hair, 3.5, ROUND),
  ];
  const glasses = [];
  if (app.glasses) {
    for (const ex of [80, 120]) {
      glasses.push(circle(ex, 112, 15, { fill: '#FFFFFF', opacity: 0.18 }));
      glasses.push(circle(ex, 112, 15, { stroke: '#2E2A3A', strokeWidth: 3.5 }));
    }
    glasses.push(line('M95,111 Q100,107 105,111', '#2E2A3A', 3.5));
  }

  const body = [
    ellipse(100, 292, 58, 8, { fill: '#000000', opacity: 0.15 }),
    ...back,
    rect(74, 226, 23, 56, { rx: 9, fill: pants }),
    rect(103, 226, 23, 56, { rx: 9, fill: pants }),
    ellipse(82, 284, 18, 9, { fill: '#5A3A2A' }),
    ellipse(118, 284, 18, 9, { fill: '#5A3A2A' }),
    line('M66,174 L46,222', shirtDark, 20, ROUND),
    line('M134,174 L154,222', shirtDark, 20, ROUND),
    circle(45, 228, 11, { fill: skin }),
    circle(155, 228, 11, { fill: skin }),
    rect(89, 148, 22, 24, { fill: skinDark }),
    path('M60,172 Q100,152 140,172 L148,236 Q100,248 52,236 Z', { fill: shirt }),
    line('M84,160 Q100,172 116,160', shirtDark, 4),
    circle(41, 114, 12, { fill: skin }),
    circle(159, 114, 12, { fill: skin }),
    circle(100, 106, 60, { fill: skin }),
    ...front,
    ...brows,
    ...eyes,
    circle(70, 132, 9, { fill: '#F28C9B', opacity: 0.45 }),
    circle(130, 132, 9, { fill: '#F28C9B', opacity: 0.45 }),
    line('M97,124 Q100,128 103,124', skinDark, 3, ROUND),
    path('M85,138 Q100,154 115,138 Q100,145 85,138 Z', { fill: '#8C3B33' }),
    ...glasses,
  ];
  const tx = x + (flip ? 100 * s : -100 * s);
  return group(place(tx, y - 292 * s, flip ? -s : s, s), body);
}

// Desenha o bichinho com as patas em (x, y). Coordenadas locais: 140 x 110.
function pet(kind, x, y, s = 1, flip = false, shade = null) {
  const tone = shade || ((color) => color);
  const eyeDark = { fill: '#2A1A14' };
  let body;
  if (kind === 'cachorro') {
    const fur = { fill: tone('#C98B4E') };
    const dark = { fill: tone('#8A5A2E') };
    body = [
      ellipse(70, 106, 46, 6, { fill: '#000000', opacity: 0.15 }),
      line('M22,62 Q6,46 14,36', fur.fill, 9, ROUND),
      ellipse(60, 70, 40, 24, fur),
      rect(30, 78, 12, 28, { rx: 6, ...fur }),
      rect(76, 78, 12, 28, { rx: 6, ...fur }),
      circle(104, 46, 26, fur),
      path(ovalPath(86, 44, 9, 20, 20), dark),
      path(ovalPath(122, 44, 9, 20, -20), dark),
      ellipse(112, 58, 13, 10, { fill: '#F2D3B1' }),
      circle(116, 54, 5, eyeDark),
      circle(97, 42, 3.5, eyeDark),
      circle(111, 42, 3.5, eyeDark),
      line('M108,64 Q113,68 118,64', '#2A1A14', 2),
    ];
  } else if (kind === 'gato') {
    const fur = { fill: tone('#E89A4F') };
    const dark = tone('#B86A2A');
    body = [
      ellipse(70, 106, 44, 6, { fill: '#000000', opacity: 0.15 }),
      line('M24,80 Q2,60 16,30', fur.fill, 9, ROUND),
      ellipse(62, 78, 36, 22, fur),
      rect(36, 84, 11, 22, { rx: 5, ...fur }),
      rect(74, 84, 11, 22, { rx: 5, ...fur }),
      line('M58,70 L66,70 M50,78 L60,78', dark, 4, ROUND),
      path('M84,34 L88,10 L100,28 Z', fur),
      path('M124,34 L120,10 L108,28 Z', fur),
      circle(104, 50, 24, fur),
      circle(96, 48, 3.5, eyeDark),
      circle(112, 48, 3.5, eyeDark),
      path('M101,56 L107,56 L104,60 Z', { fill: '#E06A7A' }),
      line('M86,58 L74,56 M86,62 L74,64 M122,58 L134,56 M122,62 L134,64', '#5A3A2A', 1.5),
    ];
  } else if (kind === 'coelho') {
    const fur = { fill: tone('#F1EDEA') };
    const inner = { fill: '#F4B6C2' };
    body = [
      ellipse(70, 106, 40, 6, { fill: '#000000', opacity: 0.15 }),
      circle(30, 80, 10, { fill: '#FFFFFF' }),
      ellipse(62, 80, 34, 24, fur),
      ellipse(80, 100, 14, 7, fur),
      ellipse(94, 20, 8, 26, fur),
      ellipse(94, 20, 4, 18, inner),
      ellipse(112, 20, 8, 26, fur),
      ellipse(112, 20, 4, 18, inner),
      circle(104, 56, 22, fur),
      circle(96, 53, 3.5, eyeDark),
      circle(112, 53, 3.5, eyeDark),
      ellipse(104, 62, 3.5, 2.5, { fill: '#E06A7A' }),
    ];
  } else {
    return null;
  }
  const tx = x + (flip ? 70 * s : -70 * s);
  return group(place(tx, y - 106 * s, flip ? -s : s, s), body);
}

// ---------------------------------------------------------------- elementos

function sky(ctx, day = ['#8FD3F4', '#E4F6FF'], night = ['#151B3D', '#4A3F78']) {
  const [top, bottom] = ctx.night ? night : day;
  return rect(0, 0, W, H, { fill: vertical(top, bottom) });
}

function stars(ctx, n = 40, maxY = 260) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = ctx.rng.uniform(5, W - 5);
    const y = ctx.rng.uniform(5, maxY);
    const r = ctx.rng.choice([1.2, 1.6, 2.2, 2.8]);
    const opacity = Math.round(ctx.rng.uniform(0.6, 1) * 100) / 100;
    out.push(circle(x, y, r, { fill: '#FFF8D6', opacity }));
  }
  return out;
}

function moon(x, y, r = 34) {
  return [
    circle(x, y, r * 1.7, { fill: '#FFF6C8', opacity: 0.12 }),
    path(`M${fmt(x)},${fmt(y - r)} A${fmt(r)},${fmt(r)} 0 1 0 ${fmt(x)},${fmt(y + r)} `
      + `A${fmt(r * 0.72)},${fmt(r)} 0 1 1 ${fmt(x)},${fmt(y - r)} Z`, { fill: '#FFF3B8' }),
  ];
}

function sun(x, y, r = 38) {
  return [
    circle(x, y, r * 1.6, { fill: '#FFE58A', opacity: 0.35 }),
    circle(x, y, r, { fill: '#FFD54F' }),
  ];
}

// Nuvem num caminho só: a transparência vale para o contorno todo, sem marcar as emendas.
function cloud(x, y, s = 1, color = '#FFFFFF') {
  const d = [ovalPath(0, 10, 52, 18), ovalPath(-20, 2, 20), ovalPath(10, -6, 26), ovalPath(34, 6, 16)].join(' ');
  return group(place(x, y, s), [path(d, { fill: color, opacity: 0.92 })]);
}

function skyDetails(ctx, sunX = null) {
  if (ctx.night) {
    const out = stars(ctx);
    const mx = ctx.rng.uniform(560, 720);
    return [...out, ...moon(mx, ctx.rng.uniform(60, 100))];
  }
  const sx = sunX ?? ctx.rng.uniform(600, 720);
  const out = sun(sx, ctx.rng.uniform(60, 90));
  const clouds = ctx.rng.randint(2, 3);
  for (let i = 0; i < clouds; i++) {
    const cx = ctx.rng.uniform(60, 520);
    const cy = ctx.rng.uniform(50, 130);
    out.push(cloud(cx, cy, ctx.rng.uniform(0.6, 1.0)));
  }
  return out;
}

function hill(ctx, y, color, amp = 30) {
  const a = ctx.rng.uniform(-amp, amp);
  const b = ctx.rng.uniform(-amp, amp);
  return path(`M0,${fmt(y)} C200,${fmt(y + a)} 300,${fmt(y - amp + b)} 450,${fmt(y)} `
    + `S700,${fmt(y + a)} ${W},${fmt(y - b / 2)} L${W},${H} L0,${H} Z`, { fill: ctx.c(color) });
}

function tree(ctx, x, y, s = 1, crown = '#5DBB63') {
  const trunk = { fill: ctx.c('#8B5A3C') };
  const c1 = { fill: ctx.c(crown) };
  const c2 = { fill: ctx.c(mix(crown, '#FFFFFF', 0.18)) };
  return group(place(x, y, s), [
    rect(-9, -70, 18, 70, { rx: 5, ...trunk }),
    circle(0, -100, 42, c1),
    circle(-30, -78, 30, c1),
    circle(30, -80, 30, c1),
    circle(-10, -118, 22, c2),
  ]);
}

function pine(ctx, x, y, s = 1, snow = false) {
  const green = { fill: ctx.c('#2E7D5B') };
  const children = [
    rect(-7, -24, 14, 24, { fill: ctx.c('#7A4E35') }),
    path('M0,-150 L-36,-82 L36,-82 Z', green),
    path('M0,-120 L-46,-24 L46,-24 Z', green),
  ];
  if (snow) {
    const white = { fill: ctx.c('#FFFFFF', 0.25) };
    children.push(path('M0,-150 L-16,-124 L16,-124 Z', white));
    children.push(path('M-30,-82 L30,-82 L22,-74 L-22,-74 Z', white));
  }
  return group(place(x, y, s), children);
}

function flower(ctx, x, y, color, s = 1) {
  const petal = { fill: ctx.c(color, 0.3) };
  return group(place(x, y, s), [
    line('M0,0 L0,-22', ctx.c('#3E8E41'), 3),
    circle(0, -30, 6, petal),
    circle(-7, -24, 6, petal),
    circle(7, -24, 6, petal),
    circle(-5, -16, 6, petal),
    circle(5, -16, 6, petal),
    circle(0, -23, 5, { fill: '#FFD54F' }),
  ]);
}

function flowers(ctx, n, y0, y1) {
  const colors = ['#F06292', '#BA68C8', '#FFB74D', '#E57373', '#64B5F6', '#FFFFFF'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = ctx.rng.uniform(10, W - 10);
    const y = ctx.rng.uniform(y0, y1);
    const color = ctx.rng.choice(colors);
    out.push(flower(ctx, x, y, color, ctx.rng.uniform(0.8, 1.2)));
  }
  return out;
}

function fireflies(ctx, n = 14, y0 = 220, y1 = 440) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = ctx.rng.uniform(20, W - 20);
    const y = ctx.rng.uniform(y0, y1);
    out.push(circle(x, y, 8, { fill: '#FFF59D', opacity: 0.3 }), circle(x, y, 3, { fill: '#FFF9C4' }));
  }
  return out;
}

function butterfly(x, y, color) {
  const wing = { fill: color };
  return group(place(x, y), [
    ellipse(-8, -4, 9, 7, wing),
    ellipse(8, -4, 9, 7, wing),
    ellipse(-6, 6, 6, 5, wing),
    ellipse(6, 6, 6, 5, wing),
    rect(-1.5, -8, 3, 18, { rx: 1.5, fill: '#3A2A2A' }),
  ]);
}

// ---------------------------------------------------------------- cenários
// Cada cenário devolve { back, front, ground }. O personagem é desenhado entre os dois.

function sceneQuarto(ctx) {
  const wall = ctx.night ? '#3E3868' : '#F6E3CF';
  const floor = ctx.night ? '#5E4A55' : '#C99E73';
  const winSky = ctx.night ? '#1A2148' : '#9BD8F7';
  const curtain = { fill: ctx.c('#F28C9B', 0.3) };
  const back = [
    rect(0, 0, W, H, { fill: wall }),
    path(`M0,0 L${W},0 L${W},40 L0,40 Z`, { fill: mix(wall, '#000000', 0.05) }),
    rect(0, 390, W, 110, { fill: floor }),
    rect(0, 384, W, 8, { fill: mix(floor, '#000000', 0.2) }),
    // janela
    rect(90, 90, 190, 170, { rx: 10, fill: '#FFFFFF' }),
    rect(102, 102, 166, 146, { rx: 6, fill: winSky }),
  ];
  if (ctx.night) {
    for (let i = 0; i < 14; i++) {
      const x = ctx.rng.uniform(110, 260);
      back.push(circle(x, ctx.rng.uniform(110, 240), 1.8, { fill: '#FFF8D6' }));
    }
    back.push(...moon(220, 150, 22));
  } else {
    back.push(cloud(160, 170, 0.6), ...sun(235, 135, 18));
  }
  back.push(
    rect(183, 102, 6, 146, { fill: '#FFFFFF' }),
    rect(102, 172, 166, 6, { fill: '#FFFFFF' }),
    path('M80,84 Q130,180 96,270 L80,270 Z', curtain),
    path('M290,84 Q240,180 274,270 L290,270 Z', curtain),
    // quadro de estrela
    rect(360, 110, 80, 80, { rx: 6, fill: ctx.c('#FFFFFF', 0.2), stroke: ctx.c('#C58B5C', 0.2), strokeWidth: 6 }),
    path('M400,128 L408,146 L428,148 L413,161 L418,180 L400,170 L382,180 L387,161 L372,148 L392,146 Z',
      { fill: '#FFD54F' }),
    // cama
    rect(520, 300, 250, 110, { rx: 14, fill: ctx.c('#8D6E63') }),
    rect(510, 250, 26, 170, { rx: 8, fill: ctx.c('#6D4C41') }),
    rect(540, 280, 90, 36, { rx: 16, fill: ctx.c('#FFFFFF', 0.25) }),
    path('M560,300 L780,300 L780,380 Q660,400 560,380 Z', { fill: ctx.c('#7FA7E0', 0.3) }),
    line('M600,330 L780,330', ctx.c('#FFFFFF', 0.3), 6, { opacity: 0.6 }),
    // tapete
    ellipse(380, 455, 220, 30, { fill: ctx.c('#F2C14E', 0.3) }),
  );
  if (ctx.night) {
    back.push(
      circle(470, 300, 70, { fill: '#FFE9A8', opacity: 0.18 }),
      rect(452, 320, 36, 90, { rx: 4, fill: '#A1887F' }),
      path('M444,300 L496,300 L486,270 L454,270 Z', { fill: '#FFE082' }),
    );
  } else {
    back.push(
      rect(440, 330, 60, 70, { rx: 6, fill: ctx.c('#4FC3F7') }),
      rect(452, 300, 36, 30, { rx: 4, fill: ctx.c('#E57373') }),
    );
  }
  return { back, front: [], ground: 455 };
}

function sceneJardim(ctx) {
  const back = [sky(ctx), ...skyDetails(ctx), hill(ctx, 300, '#9CCC65', 20), hill(ctx, 360, '#7CB342', 14)];
  const fence = { fill: ctx.c('#FFFFFF', 0.35) };
  for (let x = 0; x <= W; x += 46) {
    back.push(path(`M${x},380 L${x},322 L${x + 14},308 L${x + 28},322 L${x + 28},380 Z`, fence));
  }
  back.push(rect(0, 336, W, 10, fence));
  back.push(rect(0, 380, W, 120, { fill: ctx.c('#8BC34A') }));
  back.push(...flowers(ctx, 16, 390, 430));
  const front = flowers(ctx, 8, 470, 500);
  if (ctx.night) {
    front.push(...fireflies(ctx));
  } else {
    let x = ctx.rng.uniform(100, 300);
    front.push(butterfly(x, ctx.rng.uniform(200, 280), '#BA68C8'));
    x = ctx.rng.uniform(500, 700);
    front.push(butterfly(x, ctx.rng.uniform(220, 300), '#FFB74D'));
  }
  return { back, front, ground: 460 };
}

function sceneParque(ctx) {
  const back = [sky(ctx), ...skyDetails(ctx), hill(ctx, 320, '#9CCC65', 24)];
  back.push(rect(0, 380, W, 120, { fill: ctx.c('#8BC34A') }));
  back.push(tree(ctx, 90, 390, 1.2));
  // balanço
  back.push(line('M560,390 L600,200 L640,390 M680,390 L720,200 L760,390 M592,206 L728,206',
    ctx.c('#E57373'), 10, ROUND));
  back.push(line('M640,206 L640,330 M680,206 L680,330', ctx.c('#757575'), 3));
  back.push(rect(630, 328, 60, 10, { rx: 4, fill: ctx.c('#FFB74D') }));
  // escorregador
  const blue = ctx.c('#64B5F6');
  back.push(line('M190,390 L190,250 M230,390 L230,250', blue, 8));
  for (let yy = 270; yy < 390; yy += 24) back.push(line(`M190,${yy} L230,${yy}`, blue, 5));
  back.push(path('M230,250 L250,250 Q300,260 330,385 L310,390 Q282,276 230,268 Z', { fill: ctx.c('#FFD54F') }));
  const front = flowers(ctx, 7, 470, 500);
  if (ctx.night) front.push(...fireflies(ctx));
  return { back, front, ground: 460 };
}

function sceneFloresta(ctx) {
  const back = [sky(ctx, ['#A8E0C8', '#E8F7EE']), ...skyDetails(ctx)];
  for (let i = 0; i < 9; i++) {
    const x = i * 100 + ctx.rng.uniform(-20, 20);
    back.push(tree(ctx, x, 330, ctx.rng.uniform(0.8, 1.1), '#3F8F5A'));
  }
  back.push(hill(ctx, 340, '#6AAF5C', 16));
  back.push(rect(0, 390, W, 110, { fill: ctx.c('#5E9E4E') }));
  for (const x of [60, 720]) back.push(tree(ctx, x + ctx.rng.uniform(-20, 20), 420, 1.5, '#4CAF50'));
  // cogumelos
  const front = [];
  for (let i = 0; i < 4; i++) {
    const mx = ctx.rng.uniform(150, 650);
    const my = ctx.rng.uniform(455, 490);
    front.push(
      rect(mx - 5, my - 18, 10, 18, { rx: 3, fill: '#FFF3E0' }),
      path(`M${fmt(mx - 18)},${fmt(my - 16)} Q${fmt(mx)},${fmt(my - 44)} ${fmt(mx + 18)},${fmt(my - 16)} Z`,
        { fill: ctx.c('#E53935', 0.3) }),
      circle(mx - 6, my - 26, 3, { fill: '#FFFFFF' }),
      circle(mx + 7, my - 23, 2.5, { fill: '#FFFFFF' }),
    );
  }
  if (ctx.night) front.push(...fireflies(ctx, 20, 150, 440));
  return { back, front, ground: 465 };
}

function scenePraia(ctx) {
  const back = [sky(ctx, ['#7FD0F5', '#FFF1D0']), ...skyDetails(ctx)];
  back.push(rect(0, 250, W, 120, { fill: ctx.c('#3BA6DB') }));
  for (let i = 0; i < 6; i++) {
    const y = 270 + i * 16;
    back.push(line(`M${fmt(ctx.rng.uniform(0, 400))},${y} q20,-8 40,0 t40,0`, '#FFFFFF', 3, { opacity: 0.6 }));
  }
  back.push(path(`M0,360 Q200,340 400,356 T${W},350 L${W},${H} L0,${H} Z`, { fill: ctx.c('#F7DCA0') }));
  back.push(line(`M0,360 Q200,340 400,356 T${W},350`, '#FFFFFF', 6, { opacity: 0.7 }));
  // coqueiro
  const leaf = ctx.c('#43A047');
  back.push(line('M700,440 Q690,320 730,220', ctx.c('#A1704A'), 18, ROUND));
  for (const d of ['M730,220 Q680,190 640,230', 'M730,220 Q700,170 660,170', 'M730,220 Q770,180 800,210',
    'M730,220 Q760,160 790,150', 'M730,220 Q730,240 700,280']) {
    back.push(line(d, leaf, 16, ROUND));
  }
  // guarda-sol
  back.push(
    line('M150,440 L170,300', ctx.c('#795548'), 5),
    path('M90,310 Q170,240 250,300 Z', { fill: ctx.c('#EF5350') }),
    path('M130,290 Q170,250 210,295 Z', { fill: ctx.c('#FFFFFF', 0.3) }),
  );
  const ball = circle(ctx.rng.uniform(260, 340), 470, 18, { fill: ctx.c('#FFD54F') });
  const shell = path(`M${fmt(ctx.rng.uniform(560, 620))},480 q8,-16 16,0 z`, { fill: ctx.c('#F48FB1') });
  return { back, front: [ball, shell], ground: 455 };
}

function sceneFundoDoMar(ctx) {
  const [top, bottom] = ctx.night ? ['#123A6B', '#081C3A'] : ['#2BA3DB', '#0D4F86'];
  const back = [rect(0, 0, W, H, { fill: vertical(top, bottom) })];
  for (const x of [120, 330, 560]) {
    back.push(path(`M${x},0 L${x + 70},0 L${x + 180},420 L${x + 60},420 Z`, { fill: '#FFFFFF', opacity: 0.07 }));
  }
  back.push(path(`M0,410 Q200,390 400,410 T${W},404 L${W},${H} L0,${H} Z`, { fill: ctx.c('#E8C98A', 0.3) }));
  for (const x of [40, 110, 660, 740]) {
    back.push(line(`M${x},420 q-18,-40 0,-80 q18,-40 0,-80`, ctx.c('#2E9E5B', 0.3), 10, ROUND));
  }
  for (const [x, color] of [[200, '#FF8A65'], [600, '#F06292']]) {
    back.push(line(`M${x},420 L${x},370 M${x},390 L${x - 22},360 M${x},385 L${x + 20},350`,
      ctx.c(color, 0.3), 12, ROUND));
  }
  // peixes
  for (let i = 0; i < 5; i++) {
    const fx = ctx.rng.uniform(60, 740);
    const fy = ctx.rng.uniform(60, 300);
    const fish = { fill: ctx.c(ctx.rng.choice(['#FFB74D', '#FFEB3B', '#F06292', '#4DD0E1']), 0.3) };
    const dir = ctx.rng.choice([1, -1]);
    back.push(group(place(fx, fy, dir, 1), [
      ellipse(0, 0, 24, 14, fish),
      path('M-20,0 L-38,-12 L-38,12 Z', fish),
      circle(12, -3, 3, { fill: '#222222' }),
    ]));
  }
  // bolhas
  const front = [];
  for (let i = 0; i < 16; i++) {
    const x = ctx.rng.uniform(20, 780);
    const y = ctx.rng.uniform(20, 380);
    front.push(circle(x, y, ctx.rng.uniform(4, 10), { stroke: '#FFFFFF', strokeWidth: 2, opacity: 0.5 }));
  }
  return { back, front, ground: 462 };
}

function sceneEspaco(ctx) {
  const back = [
    rect(0, 0, W, H, { fill: vertical('#0B1026', '#3A2470') }),
    ...stars(ctx, 70, 380),
    circle(640, 110, 52, { fill: '#FF8A65' }),
    circle(625, 95, 10, { fill: '#F4511E', opacity: 0.5 }),
    path(ovalPath(640, 110, 90, 16, -15), { stroke: '#FFE082', strokeWidth: 7 }),
  ];
  const px = ctx.rng.uniform(100, 260);
  back.push(circle(px, ctx.rng.uniform(70, 150), 24, { fill: '#4FC3F7' }));
  // foguete: pontos já girados (a matriz de rotação com 2 casas entortaria o desenho)
  const tilt = multiply(translate(470, 250), rotate(25));
  const [hx, hy] = applyMatrix(tilt, 0, -20);
  back.push(
    path(mapPath('M0,-80 Q30,-40 26,30 L-26,30 Q-30,-40 0,-80 Z', tilt), { fill: '#ECEFF1' }),
    circle(hx, hy, 13, { fill: '#4FC3F7', stroke: '#90A4AE', strokeWidth: 4 }),
    path(mapPath('M-26,10 L-46,44 L-24,34 Z M26,10 L46,44 L24,34 Z', tilt), { fill: '#E53935' }),
    path(mapPath('M-16,32 Q0,80 16,32 Z', tilt), { fill: '#FFB300' }),
  );
  back.push(path(`M0,400 Q200,370 400,392 T${W},380 L${W},${H} L0,${H} Z`, { fill: '#B7B4C9' }));
  // crateras
  for (let i = 0; i < 6; i++) {
    const cx = ctx.rng.uniform(30, 770);
    const cy = ctx.rng.uniform(420, 490);
    back.push(ellipse(cx, cy, ctx.rng.uniform(14, 34), 7, { fill: '#9A97B0' }));
  }
  return { back, front: [], ground: 462 };
}

function sceneCastelo(ctx) {
  const back = [sky(ctx, ['#9AD5F7', '#FBE7F2']), ...skyDetails(ctx), hill(ctx, 330, '#A5D6A7', 26)];
  const stone = { fill: ctx.c('#D7CCE8') };
  const dark = ctx.c('#5E4B8B');
  back.push(
    rect(420, 190, 260, 190, stone),
    rect(390, 150, 70, 230, stone),
    rect(640, 150, 70, 230, stone),
    rect(515, 110, 70, 120, stone),
    path('M382,152 L425,80 L468,152 Z M632,152 L675,80 L718,152 Z M507,112 L550,40 L593,112 Z',
      { fill: ctx.c('#7E57C2') }),
    line('M550,40 L550,14', dark, 3),
    path('M550,14 L574,22 L550,30 Z', { fill: ctx.c('#EF5350') }),
    path('M520,380 L520,320 Q550,286 580,320 L580,380 Z', { fill: dark }),
  );
  for (const [wx, wy] of [[415, 200], [665, 200], [540, 150], [460, 260], [620, 260]]) {
    back.push(rect(wx, wy, 20, 30, { rx: 10, fill: ctx.night ? '#FFE082' : dark }));
  }
  for (let x = 420; x <= 680; x += 26) back.push(rect(x, 176, 16, 16, stone));
  back.push(rect(0, 380, W, 120, { fill: ctx.c('#81C784') }));
  back.push(path('M520,380 Q500,440 420,500 L620,500 Q590,440 580,380 Z', { fill: ctx.c('#E0C9A6') }));
  back.push(tree(ctx, 90, 400, 1.1));
  return { back, front: flowers(ctx, 6, 470, 500), ground: 462 };
}

function sceneFazenda(ctx) {
  const back = [sky(ctx), ...skyDetails(ctx), hill(ctx, 300, '#AED581', 30), hill(ctx, 350, '#9CCC65', 18)];
  const red = ctx.c('#D84343');
  const white = ctx.c('#FFFFFF', 0.3);
  const wood = { fill: ctx.c('#A1887F') };
  back.push(
    rect(520, 220, 200, 170, { fill: red }),
    path('M500,226 L620,140 L740,226 Z', { fill: ctx.c('#8D3A3A') }),
    rect(580, 290, 80, 100, { fill: mix(red, '#000000', 0.2), stroke: white, strokeWidth: 6 }),
    line('M580,290 L660,390 M660,290 L580,390', white, 6),
    rect(600, 186, 40, 34, { fill: white }),
  );
  back.push(rect(0, 388, W, 112, { fill: ctx.c('#8BC34A') }));
  for (let x = 0; x < 480; x += 40) back.push(rect(x, 350, 10, 44, wood));
  back.push(rect(0, 360, 480, 8, wood), rect(0, 378, 480, 8, wood));
  const hay = ctx.c('#F2C14E');
  const front = [
    ellipse(740, 460, 46, 32, { fill: hay }),
    line('M708,450 L772,450 M712,466 L768,466', mix(hay, '#000000', 0.2), 3),
  ];
  // galinha
  front.push(group(place(ctx.rng.uniform(120, 220), 470), [
    ellipse(0, -14, 18, 14, { fill: white }),
    circle(14, -28, 9, { fill: white }),
    path('M22,-28 L30,-25 L22,-22 Z', { fill: '#FFB300' }),
    path('M12,-38 L16,-44 L18,-36 Z', { fill: '#E53935' }),
    circle(16, -30, 1.8, { fill: '#222222' }),
  ]));
  return { back, front, ground: 462 };
}

function sceneCidade(ctx) {
  const back = [sky(ctx, ['#9BD3F2', '#F3F8FC']), ...skyDetails(ctx)];
  const palette = ['#90A4AE', '#B0BEC5', '#F48FB1', '#FFCC80', '#A5D6A7', '#9FA8DA'];
  const unlit = ctx.c('#E3F2FD', 0.5);
  let x = -10;
  while (x < W) {
    const w = ctx.rng.uniform(80, 130);
    const h = ctx.rng.uniform(140, 260);
    const top = 380 - h;
    back.push(rect(x, top, w, h, { fill: ctx.c(ctx.rng.choice(palette)) }));
    for (let wy = Math.trunc(top) + 16; wy < 360; wy += 30) {
      for (let wx = Math.trunc(x) + 12; wx < Math.trunc(x + w) - 18; wx += 26) {
        const lit = ctx.night && ctx.rng.random() < 0.6;
        back.push(rect(wx, wy, 14, 18, { rx: 2, fill: lit ? '#FFE082' : unlit }));
      }
    }
    x += w + ctx.rng.uniform(4, 14);
  }
  back.push(rect(0, 380, W, 30, { fill: ctx.c('#CFD8DC') }));
  back.push(rect(0, 410, W, 90, { fill: ctx.c('#607D8B') }));
  back.push(rect(0, 404, W, 8, { fill: ctx.c('#B0BEC5') }));
  for (let sx = 20; sx < W; sx += 90) back.push(rect(sx, 476, 46, 6, { rx: 3, fill: '#FFFFFF', opacity: 0.8 }));
  // poste
  const pole = { fill: ctx.c('#455A64') };
  back.push(rect(96, 250, 8, 160, pole), rect(84, 240, 32, 16, { rx: 6, ...pole }));
  if (ctx.night) {
    back.push(circle(100, 262, 40, { fill: '#FFF59D', opacity: 0.25 }), circle(100, 258, 8, { fill: '#FFF59D' }));
  }
  return { back, front: [], ground: 462 };
}

function sceneMontanhaNeve(ctx) {
  const back = [sky(ctx, ['#B3E0F7', '#F2FAFF']), ...skyDetails(ctx)];
  const rock = { fill: ctx.c('#8EA3C2') };
  const snow = { fill: ctx.c('#FFFFFF', 0.25) };
  for (const [baseX, peakY, width] of [[80, 120, 360], [380, 70, 440], [650, 140, 340]]) {
    const px = baseX + width / 2;
    back.push(path(`M${baseX - 40},380 L${px},${peakY} L${baseX + width + 40},380 Z`, rock));
    const cap = peakY + 60;
    back.push(path(`M${px},${peakY} L${px - 38},${cap} Q${px - 18},${cap - 10} ${px},${cap + 6} `
      + `Q${px + 18},${cap - 10} ${px + 38},${cap} Z`, snow));
  }
  back.push(path(`M0,370 Q200,350 400,372 T${W},360 L${W},${H} L0,${H} Z`, { fill: ctx.c('#F4F8FF', 0.3) }));
  back.push(pine(ctx, 70, 420, 1.1, true), pine(ctx, 150, 400, 0.8, true), pine(ctx, 720, 430, 1.2, true));
  // boneco de neve
  const ball = { fill: ctx.c('#FFFFFF', 0.2) };
  back.push(group(translate(600, 440), [
    circle(0, -24, 30, ball),
    circle(0, -74, 22, ball),
    circle(-7, -78, 3, { fill: '#333333' }),
    circle(7, -78, 3, { fill: '#333333' }),
    path('M0,-72 L18,-68 L0,-66 Z', { fill: '#FF8A3D' }),
    line('M-20,-56 Q0,-48 20,-56', '#E53935', 7),
  ]));
  // flocos
  const front = [];
  for (let i = 0; i < 45; i++) {
    const x = ctx.rng.uniform(0, W);
    const y = ctx.rng.uniform(0, H);
    front.push(circle(x, y, ctx.rng.uniform(2, 4.5), { fill: '#FFFFFF', opacity: 0.85 }));
  }
  return { back, front, ground: 462 };
}

function sceneDinossauros(ctx) {
  const back = [sky(ctx, ['#FFD59A', '#FFF4DD']), ...skyDetails(ctx)];
  back.push(path('M520,330 L600,170 L660,170 L740,330 Z', { fill: ctx.c('#8D6E63') }));
  back.push(path('M600,170 L615,195 L630,180 L645,198 L660,170 Z', { fill: ctx.c('#FF7043') }));
  const smoke = ctx.c('#D7CCC8', 0.3);
  back.push(cloud(630, 130, 0.7, smoke), cloud(660, 80, 0.55, smoke));
  back.push(hill(ctx, 330, '#C5D86D', 20));
  back.push(rect(0, 390, W, 110, { fill: ctx.c('#A8C256') }));
  // dinossauro pescoçudo e fofo
  const dino = { fill: ctx.c('#66BB6A') };
  const belly = { fill: ctx.c('#C5E1A5') };
  back.push(group(translate(160, 400), [
    ellipse(0, -40, 90, 48, dino),
    path('M-80,-40 Q-150,-30 -170,-10 Q-120,-20 -80,-20 Z', dino),
    line('M50,-60 Q90,-150 110,-190', dino.fill, 34, ROUND),
    ellipse(122, -196, 32, 22, dino),
    circle(130, -202, 4, { fill: '#222222' }),
    line('M126,-186 Q138,-180 148,-188', '#2E5E30', 3),
    ellipse(-10, -26, 56, 22, belly),
    rect(-60, -14, 26, 40, { rx: 10, ...dino }),
    rect(30, -14, 26, 40, { rx: 10, ...dino }),
    circle(-20, -70, 9, belly),
    circle(20, -78, 7, belly),
  ]));
  // samambaias
  const fern = ctx.c('#43A047');
  const front = [];
  for (const fx of [60, 760, 420]) {
    for (const ang of [-50, -25, 0, 25, 50]) {
      front.push(line(`M${fx},500 q${fmt(ang * 0.8)},-60 ${fmt(ang * 1.6)},-110`, fern, 12, ROUND));
    }
  }
  return { back, front, ground: 455 };
}

function sceneEscola(ctx) {
  const back = [sky(ctx), ...skyDetails(ctx), hill(ctx, 330, '#AED581', 20)];
  const wall = { fill: ctx.c('#FFCC80') };
  const roof = { fill: ctx.c('#E57373') };
  back.push(
    rect(380, 200, 360, 190, wall),
    path('M360,206 L560,120 L760,206 Z', roof),
    rect(530, 60, 60, 80, wall),
    path('M520,64 L560,30 L600,64 Z', roof),
    circle(560, 170, 22, { fill: '#FFFFFF' }),
    line('M560,170 L560,156 M560,170 L570,176', '#333333', 3),
    path('M530,390 L530,320 Q560,296 590,320 L590,390 Z', { fill: ctx.c('#8D6E63') }),
  );
  for (const wx of [410, 470, 630, 690]) {
    const glass = ctx.night ? '#FFE082' : ctx.c('#B3E5FC');
    back.push(rect(wx, 250, 40, 40, { rx: 4, fill: glass, stroke: '#FFFFFF', strokeWidth: 4 }));
  }
  back.push(rect(0, 390, W, 110, { fill: ctx.c('#8BC34A') }));
  back.push(path('M530,390 Q520,440 470,500 L650,500 Q600,440 590,390 Z', { fill: ctx.c('#E0C9A6') }));
  back.push(tree(ctx, 110, 400, 1.2));
  return { back, front: flowers(ctx, 6, 470, 500), ground: 462 };
}

const SCENE_DRAWERS = {
  quarto: sceneQuarto,
  jardim: sceneJardim,
  parque: sceneParque,
  floresta: sceneFloresta,
  praia: scenePraia,
  fundo_do_mar: sceneFundoDoMar,
  espaco: sceneEspaco,
  castelo: sceneCastelo,
  fazenda: sceneFazenda,
  cidade: sceneCidade,
  montanha_neve: sceneMontanhaNeve,
  dinossauros: sceneDinossauros,
  escola: sceneEscola,
};

// Onde a criança fica em cada cenário (para não ficar em cima de prédios, cama etc.)
const CHILD_X_RANGE = {
  quarto: [300, 400],
  parque: [380, 470],
  castelo: [230, 330],
  fazenda: [260, 420],
  escola: [240, 360],
  dinossauros: [420, 560],
  praia: [330, 520],
};

// ---------------------------------------------------------------- montagem

// Cena completa (800 x 500) com a criança e o bichinho, se houver.
export function sceneIR(scene, night, appearance, petType = '', seed = '0') {
  const drawer = Object.hasOwn(SCENE_DRAWERS, String(scene)) ? SCENE_DRAWERS[scene] : sceneJardim;
  const ctx = new Ctx(`${scene}-${seed}`, night);
  const { back, front, ground } = drawer(ctx);
  const [lo, hi] = Object.hasOwn(CHILD_X_RANGE, String(scene)) ? CHILD_X_RANGE[scene] : [250, 520];
  const cx = ctx.rng.uniform(lo, hi);
  const flip = ctx.rng.random() < 0.35;
  const shade = ctx.night ? (color) => mix(color, NIGHT_TINT, 0.12) : null;
  const characters = [avatar(appearance, cx, ground, 0.85, flip, shade)];
  if (petType) characters.push(pet(petType, cx + (flip ? -120 : 120), ground + 6, 0.8, !flip, shade));
  return { width: W, height: H, children: [...back, ...characters, ...front].filter(Boolean) };
}

// Retrato da criança (prévia do formulário e área do cliente), 300 x 300.
export function avatarIR(appearance, petType = '') {
  const children = [
    circle(150, 150, 148, { fill: '#FFF1D6' }),
    path('M2,230 Q150,200 298,230 L298,300 L2,300 Z', { fill: '#CDE8B5' }),
    avatar(appearance, petType ? 130 : 150, 290, 0.85),
  ];
  if (petType) children.push(pet(petType, 225, 292, 0.62, true));
  return { width: 300, height: 300, children: children.filter(Boolean) };
}

// ---------------------------------------------------------------- SVG

const attr = (value) => escapeHtml(value);

// Números do caminho com no máximo 2 casas.
const roundPath = (d) => d.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi, (m) => fmt(Number(m)));

function styleAttrs(node, gradientId) {
  const out = [];
  const { fill } = node;
  if (fill === undefined || fill === null) out.push('fill="none"');
  else if (typeof fill === 'string') out.push(`fill="${attr(fill)}"`);
  else out.push(`fill="url(#${gradientId(fill)})"`);
  if (node.stroke) {
    out.push(`stroke="${attr(node.stroke)}"`, `stroke-width="${fmt(node.strokeWidth ?? 1)}"`);
    if (node.lineCap && node.lineCap !== 'butt') out.push(`stroke-linecap="${attr(node.lineCap)}"`);
    if (node.lineJoin && node.lineJoin !== 'miter') out.push(`stroke-linejoin="${attr(node.lineJoin)}"`);
  }
  if (node.opacity !== undefined && node.opacity !== null && node.opacity < 1) {
    out.push(`opacity="${fmt(node.opacity)}"`);
  }
  return out.join(' ');
}

function nodeSVG(node, gradientId) {
  switch (node.type) {
    case 'group': {
      const inner = node.children.map((child) => nodeSVG(child, gradientId)).join('');
      const t = node.transform ? ` transform="matrix(${node.transform.map(fmt).join(' ')})"` : '';
      return `<g${t}>${inner}</g>`;
    }
    case 'rect': {
      const rx = node.rx ? ` rx="${fmt(node.rx)}"` : '';
      return `<rect x="${fmt(node.x)}" y="${fmt(node.y)}" width="${fmt(node.w)}" height="${fmt(node.h)}"${rx} `
        + `${styleAttrs(node, gradientId)}/>`;
    }
    case 'circle':
      return `<circle cx="${fmt(node.cx)}" cy="${fmt(node.cy)}" r="${fmt(node.r)}" ${styleAttrs(node, gradientId)}/>`;
    case 'ellipse':
      return `<ellipse cx="${fmt(node.cx)}" cy="${fmt(node.cy)}" rx="${fmt(node.rx)}" ry="${fmt(node.ry)}" `
        + `${styleAttrs(node, gradientId)}/>`;
    case 'path':
      return `<path d="${attr(roundPath(node.d))}" ${styleAttrs(node, gradientId)}/>`;
    default:
      throw new Error(`Forma desconhecida: ${node.type}`);
  }
}

// Serializa o IR. Os ids dos degradês vêm de idPrefix ou de um hash do desenho,
// para várias imagens na mesma página não se misturarem.
// label: nome para leitores de tela; sem label a imagem é decorativa (aria-hidden).
export function toSVG(root, { width, height, idPrefix, label } = {}) {
  const prefix = idPrefix
    || 'g' + crypto.createHash('sha1').update(JSON.stringify(root)).digest('hex').slice(0, 10);
  const gradients = new Map();
  const gradientId = (paint) => {
    const key = JSON.stringify(paint);
    if (!gradients.has(key)) gradients.set(key, { id: `${prefix}-${gradients.size + 1}`, paint });
    return gradients.get(key).id;
  };
  const body = root.children.map((node) => nodeSVG(node, gradientId)).join('');
  let defs = '';
  if (gradients.size) {
    defs = '<defs>' + [...gradients.values()].map(({ id, paint }) => {
      const stops = paint.stops
        .map(([offset, color]) => `<stop offset="${fmt(offset)}" stop-color="${attr(color)}"/>`).join('');
      return `<linearGradient id="${attr(id)}" gradientUnits="userSpaceOnUse" x1="${fmt(paint.x1)}" `
        + `y1="${fmt(paint.y1)}" x2="${fmt(paint.x2)}" y2="${fmt(paint.y2)}">${stops}</linearGradient>`;
    }).join('') + '</defs>';
  }
  const w = width ?? root.width;
  const h = height ?? root.height;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(root.width)} ${fmt(root.height)}" `
    + `width="${fmt(w)}" height="${fmt(h)}" ${label ? `role="img" aria-label="${attr(label)}"` : 'aria-hidden="true"'}>`
    + `${defs}${body}</svg>`;
}

export function sceneSVG(scene, night, appearance, petType = '', seed = '0') {
  return toSVG(sceneIR(scene, night, appearance, petType, seed));
}

export function avatarSVG(appearance, petType = '', size = 260, label = '') {
  return toSVG(avatarIR(appearance, petType), { width: size, height: size, label });
}
