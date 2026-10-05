// Livrinho da história em PDF, sem dependências: capa, uma página por cena e a página "Fim".
// As ilustrações vêm do grafo de cena (IR) do ilustrador e viram desenho vetorial no PDF.
// Usa as fontes padrão do PDF (Helvetica, sem embutir) e comprime as páginas com zlib.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { WIN_ANSI_SPECIAL, WIDTHS } from './pdf-fonts.js';

export const A4 = { width: 595.28, height: 841.89 };

const FONTS = { Helvetica: 'F1', 'Helvetica-Bold': 'F2' };
const KAPPA = 0.5522847498307936; // controle de Bézier para um quarto de círculo
const CAPS = { butt: 0, round: 1, square: 2 };
const JOINS = { miter: 0, round: 1, bevel: 2 };

// Número no formato do PDF: até 3 casas, sem notação científica e sem "-0".
export function num(value) {
  const n = Math.round(Number(value) * 1000) / 1000;
  if (!Number.isFinite(n) || n === 0) return '0';
  return String(Math.max(-1e9, Math.min(1e9, n)));
}

// '#RRGGBB' (ou '#RGB') -> [r, g, b] entre 0 e 1; qualquer outra coisa -> null.
export function parseColor(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

const rgb = (color) => color.map(num).join(' ');

// ---------------------------------------------------------------- texto

const BLANKS = /[\t\n\r\f\v\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200d\u2060\ufeff\p{M}]/u;
const HYPHENS = /[\u2010-\u2012\u2212]/;

function winAnsiCode(ch) {
  const cp = ch.codePointAt(0);
  if ((cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255)) return cp;
  return WIN_ANSI_SPECIAL[ch] ?? null;
}

// Texto -> bytes WinAnsi. Fora da tabela: tira o acento (NFD/NFKD) ou vira '?'.
export function encodeWinAnsi(text) {
  const out = [];
  for (const ch of String(text ?? '').normalize('NFC')) {
    if (BLANKS.test(ch)) {
      out.push(32);
      continue;
    }
    if (INVISIBLE.test(ch)) continue;
    const code = winAnsiCode(ch);
    if (code !== null) {
      out.push(code);
      continue;
    }
    if (HYPHENS.test(ch)) {
      out.push(45);
      continue;
    }
    let base = ch.normalize('NFD').replace(/\p{M}+/gu, '');
    if (!base || base === ch) base = ch.normalize('NFKD').replace(/\p{M}+/gu, '');
    const codes = [...base].map(winAnsiCode);
    if (base && base !== ch && codes.every((c) => c !== null)) out.push(...codes);
    else out.push(63);
  }
  return Buffer.from(out);
}

// Bytes -> string literal do PDF: escapa ( ) \ e usa octal fora do ASCII visível.
export function pdfString(bytes) {
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

// Texto dos metadados (/Info): literal se for ASCII, senão UTF-16BE em hexadecimal.
export function pdfTextString(text) {
  const value = String(text ?? '');
  if (/^[\x20-\x7e]*$/.test(value)) return pdfString(Buffer.from(value, 'latin1'));
  return '<FEFF' + Buffer.from(value, 'utf16le').swap16().toString('hex').toUpperCase() + '>';
}

// Largura do texto em pontos, pelas métricas reais da fonte.
export function textWidth(text, font = 'Helvetica', size = 1) {
  const widths = WIDTHS[font] || WIDTHS.Helvetica;
  let total = 0;
  for (const b of encodeWinAnsi(text)) if (b >= 32) total += widths[b - 32];
  return (total * size) / 1000;
}

// Palavra maior que a linha: quebra por caracteres.
function splitLongWord(word, font, size, width) {
  if (textWidth(word, font, size) <= width) return [word];
  const pieces = [];
  let piece = '';
  for (const ch of word) {
    if (piece && textWidth(piece + ch, font, size) > width) {
      pieces.push(piece);
      piece = '';
    }
    piece += ch;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

// Quebra em linhas que cabem em `width`. Cada "\n" começa um parágrafo novo.
// Devolve [{ text, width, last }] (last = última linha do parágrafo, não é justificada).
export function wrapLines(text, { font = 'Helvetica', size = 12, width = Infinity } = {}) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  const space = textWidth(' ', font, size);
  const lines = [];
  for (const paragraph of source.split(/\r\n|\r|\n/)) {
    let words = [];
    let lineWidth = 0;
    const flush = (last) => {
      lines.push({ text: words.join(' '), width: lineWidth, last });
      words = [];
      lineWidth = 0;
    };
    // Espaço sem quebra (U+00A0) fica dentro da palavra
    for (const word of paragraph.split(/[ \t\f\v\u2000-\u200a\u205f\u3000]+/).filter(Boolean)) {
      for (const piece of splitLongWord(word, font, size, width)) {
        const w = textWidth(piece, font, size);
        if (words.length && lineWidth + space + w > width + 1e-6) flush(false);
        lineWidth += (words.length ? space : 0) + w;
        words.push(piece);
      }
    }
    flush(true);
  }
  return lines;
}

export function wrapText(text, options = {}) {
  return wrapLines(text, options).map((line) => line.text);
}

// Corta as linhas em `max`, terminando a última com reticências.
function truncateLines(lines, max, { font, size, width }) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, Math.max(0, max));
  if (!kept.length) return kept;
  let words = kept[kept.length - 1].text.split(' ');
  let text = words.join(' ') + '…';
  while (words.length > 1 && textWidth(text, font, size) > width) {
    words = words.slice(0, -1);
    text = words.join(' ') + '…';
  }
  kept[kept.length - 1] = { text, width: textWidth(text, font, size), last: true };
  return kept;
}

// ---------------------------------------------------------------- caminhos

// Retângulo (cantos arredondados opcionais) como operadores de caminho do PDF.
export function rectPath(x, y, w, h, rx = 0, ry = rx) {
  const rX = Math.max(0, Math.min(Number(rx) || 0, w / 2));
  const rY = Math.max(0, Math.min(Number(ry ?? rx) || 0, h / 2));
  if (!rX || !rY) return `${num(x)} ${num(y)} ${num(w)} ${num(h)} re`;
  const x2 = x + w;
  const y2 = y + h;
  const cx = rX * KAPPA;
  const cy = rY * KAPPA;
  const p = (...values) => values.map(num).join(' ');
  return [
    `${p(x + rX, y)} m`,
    `${p(x2 - rX, y)} l`,
    `${p(x2 - rX + cx, y, x2, y + rY - cy, x2, y + rY)} c`,
    `${p(x2, y2 - rY)} l`,
    `${p(x2, y2 - rY + cy, x2 - rX + cx, y2, x2 - rX, y2)} c`,
    `${p(x + rX, y2)} l`,
    `${p(x + rX - cx, y2, x, y2 - rY + cy, x, y2 - rY)} c`,
    `${p(x, y + rY)} l`,
    `${p(x, y + rY - cy, x + rX - cx, y, x + rX, y)} c`,
    'h',
  ].join(' ');
}

// Elipse com 4 curvas de Bézier.
export function ellipsePath(cx, cy, rx, ry) {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  const p = (...values) => values.map(num).join(' ');
  return [
    `${p(cx + rx, cy)} m`,
    `${p(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry)} c`,
    `${p(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy)} c`,
    `${p(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry)} c`,
    `${p(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy)} c`,
    'h',
  ].join(' ');
}

// Arco elíptico do SVG (ponto inicial/final) -> curvas cúbicas [c1x, c1y, c2x, c2y, x, y].
// Conversão padrão para o centro (SVG 1.1, apêndice F.6). Raio zero -> null (vira reta).
export function arcToCubics(x1, y1, rx, ry, angle, largeArc, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  let rX = Math.abs(rx);
  let rY = Math.abs(ry);
  if (!rX || !rY) return null;
  const phi = ((Number(angle) || 0) % 360) * Math.PI / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  // Raios pequenos demais: aumenta na proporção até o arco fechar
  const lambda = (x1p * x1p) / (rX * rX) + (y1p * y1p) / (rY * rY);
  if (lambda > 1) {
    rX *= Math.sqrt(lambda);
    rY *= Math.sqrt(lambda);
  }
  const numer = rX * rX * rY * rY - rX * rX * y1p * y1p - rY * rY * x1p * x1p;
  const denom = rX * rX * y1p * y1p + rY * rY * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, numer / denom));
  if (Boolean(largeArc) === Boolean(sweep)) coef = -coef;
  const cxp = (coef * rX * y1p) / rY;
  const cyp = (-coef * rY * x1p) / rX;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ux = (x1p - cxp) / rX;
  const uy = (y1p - cyp) / rY;
  const vx = (-x1p - cxp) / rX;
  const vy = (-y1p - cyp) / rY;
  const theta = Math.atan2(uy, ux);
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  // No máximo 90° por curva
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / count;
  const t = (4 / 3) * Math.tan(step / 4);
  const point = (ex, ey) => [cx + rX * cos * ex - rY * sin * ey, cy + rX * sin * ex + rY * cos * ey];
  const curves = [];
  let a = theta;
  for (let i = 0; i < count; i++) {
    const b = a + step;
    const [c1x, c1y] = point(Math.cos(a) - t * Math.sin(a), Math.sin(a) + t * Math.cos(a));
    const [c2x, c2y] = point(Math.cos(b) + t * Math.sin(b), Math.sin(b) - t * Math.cos(b));
    const [ex, ey] = i === count - 1 ? [x2, y2] : point(Math.cos(b), Math.sin(b));
    curves.push([c1x, c1y, c2x, c2y, ex, ey]);
    a = b;
  }
  return curves;
}

const STOP = Symbol('fim do caminho');
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

// Dados de caminho do SVG -> segmentos absolutos ['M', x, y] | ['L', x, y] |
// ['C', x1, y1, x2, y2, x, y] | ['Z']. H/V viram L, Q/T viram C, arcos viram C.
// Como no navegador, um erro de sintaxe encerra o caminho no ponto em que ocorreu.
export function parsePath(d) {
  const src = String(d ?? '');
  const segs = [];
  let i = 0;
  const skip = () => {
    while (i < src.length && /[\s,]/.test(src[i])) i++;
  };
  const number = () => {
    skip();
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(src);
    if (!match) throw STOP;
    i = NUMBER.lastIndex;
    return parseFloat(match[0]);
  };
  const flag = () => {
    skip();
    const c = src[i];
    if (c !== '0' && c !== '1') throw STOP;
    i++;
    return c === '1';
  };

  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCubic = null; // 2º controle da última C/S (para refletir em S)
  let lastQuad = null; // controle da última Q/T (para refletir em T)
  let reopen = false; // depois de Z, o próximo desenho recomeça no início do subcaminho
  let cmd = '';

  const start = () => {
    if (reopen) {
      segs.push(['M', cx, cy]);
      reopen = false;
    }
  };
  const line = (x, y) => {
    start();
    segs.push(['L', x, y]);
    [cx, cy, lastCubic, lastQuad] = [x, y, null, null];
  };
  const cubic = (x1, y1, x2, y2, x, y) => {
    start();
    segs.push(['C', x1, y1, x2, y2, x, y]);
    [cx, cy, lastCubic, lastQuad] = [x, y, [x2, y2], null];
  };
  const quad = (qx, qy, x, y) => {
    start();
    segs.push(['C', cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy),
      x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y]);
    [cx, cy, lastCubic, lastQuad] = [x, y, null, [qx, qy]];
  };

  try {
    for (;;) {
      skip();
      if (i >= src.length) break;
      const ch = src[i];
      if (/[a-z]/i.test(ch)) {
        if (!/[MLHVCSQTAZ]/i.test(ch)) break;
        cmd = ch;
        i++;
      } else if (!cmd || cmd === 'Z' || cmd === 'z' || !/[\d.+-]/.test(ch)) {
        break;
      }
      if (!segs.length && cmd !== 'M' && cmd !== 'm') break;
      const rel = cmd !== cmd.toUpperCase();
      const ox = rel ? cx : 0;
      const oy = rel ? cy : 0;
      switch (cmd.toUpperCase()) {
        case 'M': {
          const x = number() + ox;
          const y = number() + oy;
          segs.push(['M', x, y]);
          [cx, cy, sx, sy, lastCubic, lastQuad, reopen] = [x, y, x, y, null, null, false];
          cmd = rel ? 'l' : 'L'; // pares seguintes são lineto
          break;
        }
        case 'Z':
          segs.push(['Z']);
          [cx, cy, lastCubic, lastQuad, reopen] = [sx, sy, null, null, true];
          break;
        case 'L': {
          const x = number() + ox;
          line(x, number() + oy);
          break;
        }
        case 'H':
          line(number() + ox, cy);
          break;
        case 'V':
          line(cx, number() + oy);
          break;
        case 'C': {
          const v = [number() + ox, number() + oy, number() + ox, number() + oy, number() + ox, number() + oy];
          cubic(...v);
          break;
        }
        case 'S': {
          const v = [number() + ox, number() + oy, number() + ox, number() + oy];
          const [rx, ry] = lastCubic ? [2 * cx - lastCubic[0], 2 * cy - lastCubic[1]] : [cx, cy];
          cubic(rx, ry, ...v);
          break;
        }
        case 'Q': {
          const v = [number() + ox, number() + oy, number() + ox, number() + oy];
          quad(...v);
          break;
        }
        case 'T': {
          const x = number() + ox;
          const y = number() + oy;
          const [qx, qy] = lastQuad ? [2 * cx - lastQuad[0], 2 * cy - lastQuad[1]] : [cx, cy];
          quad(qx, qy, x, y);
          break;
        }
        case 'A': {
          const [rx, ry, angle] = [number(), number(), number()];
          const [large, sweep] = [flag(), flag()];
          const x = number() + ox;
          const y = number() + oy;
          const curves = arcToCubics(cx, cy, rx, ry, angle, large, sweep, x, y);
          if (curves === null) line(x, y);
          else for (const c of curves) cubic(...c);
          [lastCubic, lastQuad] = [null, null];
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    if (err !== STOP) throw err;
  }
  return segs;
}

function segmentsToOps(segs) {
  const p = (values) => values.map(num).join(' ');
  return segs.map((s) => {
    if (s[0] === 'M') return `${p(s.slice(1))} m`;
    if (s[0] === 'L') return `${p(s.slice(1))} l`;
    if (s[0] === 'C') return `${p(s.slice(1))} c`;
    return 'h';
  }).join(' ');
}

// Forma do IR -> operadores de caminho ('' = nada a desenhar).
function shapePath(node) {
  const n = (value) => Number(value) || 0;
  switch (node.type) {
    case 'rect': {
      const w = n(node.w);
      const h = n(node.h);
      if (w <= 0 || h <= 0) return '';
      return rectPath(n(node.x), n(node.y), w, h, n(node.rx), node.ry ?? node.rx);
    }
    case 'circle':
      return n(node.r) > 0 ? ellipsePath(n(node.cx), n(node.cy), n(node.r), n(node.r)) : '';
    case 'ellipse':
      return n(node.rx) > 0 && n(node.ry) > 0 ? ellipsePath(n(node.cx), n(node.cy), n(node.rx), n(node.ry)) : '';
    case 'path': {
      const segs = parsePath(node.d);
      return segs.length > 1 ? segmentsToOps(segs) : '';
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------- degradês

// Paradas do degradê como no SVG: offset entre 0 e 1 e nunca menor que o anterior.
function normalizeStops(stops) {
  const out = [];
  let previous = 0;
  for (const stop of Array.isArray(stops) ? stops : []) {
    const color = parseColor(stop?.[1]);
    if (!color) continue;
    previous = Math.max(previous, Math.min(1, Math.max(0, Number(stop[0]) || 0)));
    out.push([previous, color]);
  }
  return out;
}

const interpolation = (c0, c1) =>
  `<< /FunctionType 2 /Domain [0 1] /C0 [${rgb(c0)}] /C1 [${rgb(c1)}] /N 1 >>`;

// Função de cor do degradê: uma interpolação por trecho, costuradas (FunctionType 3).
function gradientFunction(stops) {
  const points = [...stops];
  if (points[0][0] > 0) points.unshift([0, points[0][1]]);
  if (points[points.length - 1][0] < 1) points.push([1, points[points.length - 1][1]]);
  const pieces = [];
  for (let k = 0; k < points.length - 1; k++) {
    const [o0, c0] = points[k];
    const [o1, c1] = points[k + 1];
    if (o1 > o0) pieces.push({ from: o0, to: o1, fn: interpolation(c0, c1) });
  }
  if (!pieces.length) return interpolation(points[points.length - 1][1], points[points.length - 1][1]);
  if (pieces.length === 1) return pieces[0].fn;
  const bounds = pieces.slice(1).map((piece) => num(piece.from)).join(' ');
  const encode = pieces.map(() => '0 1').join(' ');
  return `<< /FunctionType 3 /Domain [0 1] /Functions [${pieces.map((piece) => piece.fn).join(' ')}]` +
    ` /Bounds [${bounds}] /Encode [${encode}] >>`;
}

function shadingDict(paint) {
  const coords = [paint.x1, paint.y1, paint.x2, paint.y2].map(num).join(' ');
  return `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${coords}]` +
    ` /Function ${gradientFunction(paint.stops)} /Extend [true true] >>`;
}

// Paint do IR -> { color } | { shading } | null (sem preenchimento).
function resolvePaint(paint, doc) {
  if (typeof paint === 'string') {
    const color = parseColor(paint);
    return color ? { color } : null;
  }
  if (!paint || paint.type !== 'linear') return null;
  const stops = normalizeStops(paint.stops);
  if (!stops.length) return null;
  const [x1, y1, x2, y2] = [paint.x1, paint.y1, paint.x2, paint.y2].map((v) => Number(v) || 0);
  // Vetor de comprimento zero: o SVG pinta com a cor da última parada
  if (stops.length === 1 || (x1 === x2 && y1 === y2)) return { color: stops[stops.length - 1][1] };
  return { shading: doc.shading({ x1, y1, x2, y2, stops }) };
}

// ---------------------------------------------------------------- documento

// Uma página: lista de operadores do PDF. Os métodos usam origem no topo (y para baixo).
export class PdfPage {
  constructor(doc, width, height) {
    this.doc = doc;
    this.width = width;
    this.height = height;
    this.ops = [];
  }

  write(...ops) {
    for (const op of ops) if (op) this.ops.push(op);
    return this;
  }

  fillRect(x, top, w, h, color, radius = 0) {
    const c = parseColor(color);
    if (c) this.write(`${rgb(c)} rg`, rectPath(x, this.height - top - h, w, h, radius), 'f');
    return this;
  }

  // Uma linha de texto; `baseline` medido a partir do topo da página.
  text(value, x, baseline, { font = 'Helvetica', size = 12, color = '#000000', wordSpacing = 0 } = {}) {
    const bytes = encodeWinAnsi(value);
    if (!bytes.length) return this;
    return this.write('BT', `/${this.doc.font(font)} ${num(size)} Tf`, `${rgb(parseColor(color) || [0, 0, 0])} rg`,
      `${num(wordSpacing)} Tw`, `1 0 0 1 ${num(x)} ${num(this.height - baseline)} Tm`, `${pdfString(bytes)} Tj`, 'ET');
  }
}

export class PdfDocument {
  constructor({ title = '', author = '', subject = '', creator = '', date = new Date() } = {}) {
    this.info = { title, author, subject, creator, date };
    this.pages = [];
    this.alphas = new Map(); // opacidade -> nome do ExtGState
    this.shadings = new Map(); // degradê (JSON) -> { name, dict }
  }

  get currentPage() {
    return this.pages[this.pages.length - 1] || null;
  }

  addPage(width = A4.width, height = A4.height) {
    const page = new PdfPage(this, width, height);
    this.pages.push(page);
    return page;
  }

  font(name) {
    return FONTS[name] || FONTS.Helvetica;
  }

  alpha(opacity) {
    const key = num(Math.min(1, Math.max(0, opacity)));
    if (!this.alphas.has(key)) this.alphas.set(key, `GS${this.alphas.size + 1}`);
    return this.alphas.get(key);
  }

  shading(paint) {
    const key = JSON.stringify(paint);
    if (!this.shadings.has(key)) this.shadings.set(key, { name: `Sh${this.shadings.size + 1}`, dict: shadingDict(paint) });
    return this.shadings.get(key).name;
  }

  resources(fontIds) {
    const fonts = Object.values(FONTS).map((name, i) => `/${name} ${fontIds[i]} 0 R`).join(' ');
    let out = `<< /ProcSet [/PDF /Text] /Font << ${fonts} >>`;
    if (this.alphas.size) {
      const states = [...this.alphas].map(([value, name]) => `/${name} << /Type /ExtGState /ca ${value} /CA ${value} >>`);
      out += ` /ExtGState << ${states.join(' ')} >>`;
    }
    if (this.shadings.size) {
      out += ` /Shading << ${[...this.shadings.values()].map((s) => `/${s.name} ${s.dict}`).join(' ')} >>`;
    }
    return out + ' >>';
  }

  toBuffer() {
    const objects = [];
    const add = (body) => objects.push(body);
    const catalogId = add(null);
    const pagesId = add(null);
    const date = this.info.date instanceof Date && !Number.isNaN(this.info.date.getTime()) ? this.info.date : new Date();
    const stamp = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const info = [`/Producer ${pdfTextString('Era Uma Vez Eu (gerador de PDF próprio)')}`, `/CreationDate (D:${stamp}Z)`];
    for (const key of ['title', 'author', 'subject', 'creator']) {
      if (this.info[key]) info.push(`/${key[0].toUpperCase()}${key.slice(1)} ${pdfTextString(this.info[key])}`);
    }
    const infoId = add(`<< ${info.join(' ')} >>`);
    const fontIds = Object.keys(FONTS).map((base) =>
      add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`));
    const resourcesId = add(null);
    const kids = this.pages.map((page) => {
      const data = zlib.deflateSync(Buffer.from(page.ops.join('\n'), 'latin1'));
      const contentId = add(Buffer.concat([
        Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream', 'latin1'),
      ]));
      return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}]` +
        ` /Resources ${resourcesId} 0 R /Contents ${contentId} 0 R >>`);
    });
    // Recursos por último: só agora se sabe quais opacidades e degradês foram usados
    objects[resourcesId - 1] = this.resources(fontIds);
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = objects.map((body, index) => {
      const chunk = Buffer.concat([
        Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
        Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
        Buffer.from('\nendobj\n', 'latin1'),
      ]);
      chunks.push(chunk);
      const at = offset;
      offset += chunk.length;
      return at;
    });
    const id = crypto.createHash('md5').update(Buffer.concat(chunks)).digest('hex');
    // Cada entrada da tabela xref tem exatamente 20 bytes
    const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ',
      ...offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n `)].join('\n');
    chunks.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R` +
      ` /Info ${infoId} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}

// ---------------------------------------------------------------- desenho do IR

// Escreve operadores lembrando o estado gráfico, para não repetir cor/espessura à toa.
class Painter {
  constructor(page) {
    this.page = page;
    this.doc = page.doc;
    this.state = {};
    this.stack = [];
  }

  op(...ops) {
    this.page.write(...ops);
  }

  save() {
    this.stack.push({ ...this.state });
    this.op('q');
  }

  restore() {
    this.state = this.stack.pop();
    this.op('Q');
  }

  set(key, value, operator) {
    if (this.state[key] === value) return;
    this.state[key] = value;
    this.op(`${value} ${operator}`);
  }

  node(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'group') this.group(node);
    else this.shape(node);
  }

  group(node) {
    const children = Array.isArray(node.children) ? node.children : [];
    if (!children.length) return;
    const m = node.transform;
    const hasMatrix = Array.isArray(m) && m.length === 6 && m.every(Number.isFinite);
    if (hasMatrix && Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) return; // escala zero: invisível
    this.save();
    if (hasMatrix && m.join(' ') !== '1 0 0 1 0 0') this.op(`${m.map(num).join(' ')} cm`);
    for (const child of children) this.node(child);
    this.restore();
  }

  shape(node) {
    const opacity = node.opacity === undefined || node.opacity === null ? 1 : Number(node.opacity);
    if (!(opacity > 0)) return;
    const strokeColor = parseColor(node.stroke);
    const strokeWidth = node.strokeWidth === undefined || node.strokeWidth === null ? 1 : Number(node.strokeWidth);
    const stroke = strokeColor && strokeWidth > 0;
    if (!node.fill && !stroke) return;
    const path = shapePath(node);
    if (!path) return;
    const fill = resolvePaint(node.fill, this.doc);
    if (!fill && !stroke) return;

    if (opacity < 1) {
      this.save();
      this.op(`/${this.doc.alpha(opacity)} gs`);
    }
    if (fill?.shading) {
      // Degradê: recorta pela forma e pinta o sombreamento no espaço da própria forma
      this.save();
      this.op(`${path} W n`, `/${fill.shading} sh`);
      this.restore();
    } else if (fill) {
      this.set('fill', rgb(fill.color), 'rg');
    }
    if (stroke) {
      this.set('stroke', rgb(strokeColor), 'RG');
      this.set('width', num(strokeWidth), 'w');
      this.set('cap', CAPS[node.lineCap] ?? 0, 'J');
      this.set('join', JOINS[node.lineJoin] ?? 0, 'j');
    }
    if (fill?.color) this.op(`${path} ${stroke ? 'B' : 'f'}`);
    else if (stroke) this.op(`${path} S`);
    if (opacity < 1) this.restore();
  }
}

const isIR = (root) => Boolean(root) && Number(root.width) > 0 && Number(root.height) > 0 && Array.isArray(root.children);

// Tamanho final da imagem cabendo em maxWidth x maxHeight, sem distorcer.
export function fitIR(root, maxWidth, maxHeight = Infinity) {
  if (!isIR(root)) return null;
  const scale = Math.min(maxWidth / root.width, maxHeight / root.height);
  return { scale, width: root.width * scale, height: root.height * scale };
}

// Desenha o IR numa caixa da página: box = { x, y, width, height?, radius? } em pontos,
// com y medido do topo. Mantém a proporção (alinha no topo e centraliza na horizontal)
// e recorta tudo pela caixa de cantos arredondados. Devolve a área ocupada.
export function drawIR(target, root, box) {
  const page = target instanceof PdfDocument ? target.currentPage : target;
  const fit = fitIR(root, box.width, box.height || Infinity);
  if (!page || !fit) return null;
  const x = box.x + (box.width - fit.width) / 2;
  const top = box.y;
  const painter = new Painter(page);
  painter.save();
  // IR tem y para baixo: escala e inverte o eixo y, com origem no canto superior esquerdo da caixa
  painter.op(`${num(fit.scale)} 0 0 ${num(-fit.scale)} ${num(x)} ${num(page.height - top)} cm`);
  painter.op(`${rectPath(0, 0, root.width, root.height, (box.radius || 0) / fit.scale)} W n`, '4 M');
  for (const child of root.children) painter.node(child);
  painter.restore();
  return { x, y: top, width: fit.width, height: fit.height };
}

// Desenha linhas já quebradas (de wrapLines). align: left | center | right | justify.
// Em "justify" a última linha de cada parágrafo fica alinhada à esquerda.
export function drawLines(page, lines, { x, top, width, font = 'Helvetica', size = 12, lineHeight = 1.4,
  color = '#000000', align = 'left' }) {
  const lh = size * lineHeight;
  if (!lines.length) return 0;
  const ops = ['BT', `/${page.doc.font(font)} ${num(size)} Tf`, `${rgb(parseColor(color) || [0, 0, 0])} rg`];
  let spacingNow = null;
  lines.forEach((item, index) => {
    const line = typeof item === 'string' ? { text: item, width: textWidth(item, font, size), last: true } : item;
    const bytes = encodeWinAnsi(line.text);
    if (!bytes.length) return;
    let lx = x;
    let spacing = 0;
    if (align === 'center') lx = x + (width - line.width) / 2;
    else if (align === 'right') lx = x + width - line.width;
    else if (align === 'justify' && !line.last) {
      const gaps = bytes.filter((b) => b === 32).length;
      const extra = gaps ? (width - line.width) / gaps : 0;
      if (extra > 0 && extra < size) spacing = extra; // espaço exagerado: deixa à esquerda
    }
    if (spacing !== spacingNow) {
      ops.push(`${num(spacing)} Tw`);
      spacingNow = spacing;
    }
    const baseline = top + index * lh + (lh - size) / 2 + size * 0.8;
    ops.push(`1 0 0 1 ${num(lx)} ${num(page.height - baseline)} Tm`, `${pdfString(bytes)} Tj`);
  });
  ops.push('ET');
  page.write(...ops);
  return lines.length * lh;
}

// ---------------------------------------------------------------- livrinho

const MARGIN = 56;
const CONTENT_W = A4.width - 2 * MARGIN;
const COLORS = {
  ink: '#2D2A3E',
  purple: '#5B3E96',
  cover: '#FFF4E0',
  coverShadow: '#F2E2C4',
  paper: '#FFFDF8',
  muted: '#7A6F8F',
  counter: '#A898CF',
  lilac: '#D9CCF2',
  star: '#FFD54F',
};
const TITLE = { font: 'Helvetica-Bold', size: 28, lineHeight: 1.25 };
const SUBTITLE = { font: 'Helvetica', size: 12, lineHeight: 1.5 };
const BODY = { font: 'Helvetica', size: 16, lineHeight: 1.55 };
const LESSON = { font: 'Helvetica', size: 15, lineHeight: 1.5 };

function drawCover(doc, { title, childName, siteName, image }) {
  const page = doc.addPage();
  page.fillRect(0, 0, page.width, page.height, COLORS.cover);
  const titleLines = truncateLines(wrapLines(title || 'Minha história', { ...TITLE, width: CONTENT_W }), 4,
    { ...TITLE, width: CONTENT_W });
  const subtitle = `Uma história feita especialmente para ${childName || 'você'}` + (siteName ? ` · ${siteName}` : '');
  const subWidth = CONTENT_W - 40;
  const subLines = truncateLines(wrapLines(subtitle, { ...SUBTITLE, width: subWidth }), 3, { ...SUBTITLE, width: subWidth });
  const fit = fitIR(image, CONTENT_W, 440);
  const titleH = titleLines.length * TITLE.size * TITLE.lineHeight;
  const subH = subLines.length * SUBTITLE.size * SUBTITLE.lineHeight;
  const imageH = fit ? fit.height + 36 : 0;
  // Bloco (imagem + título + subtítulo) centralizado na vertical, um pouco acima do meio
  let top = Math.max(MARGIN, (page.height - (imageH + titleH + 12 + subH)) / 2 - 16);
  if (fit) {
    const x = MARGIN + (CONTENT_W - fit.width) / 2;
    page.fillRect(x + 5, top + 6, fit.width, fit.height, COLORS.coverShadow, 18);
    drawIR(page, image, { x: MARGIN, y: top, width: CONTENT_W, height: 440, radius: 18 });
    top += imageH;
  }
  drawLines(page, titleLines, { x: MARGIN, top, width: CONTENT_W, ...TITLE, color: COLORS.purple, align: 'center' });
  top += titleH + 12;
  drawLines(page, subLines, { x: MARGIN + 20, top, width: subWidth, ...SUBTITLE, color: COLORS.muted, align: 'center' });
}

function addScenePage(doc, counter) {
  const page = doc.addPage();
  page.fillRect(0, 0, page.width, page.height, COLORS.paper);
  const size = 10;
  page.text(counter, (page.width - textWidth(counter, 'Helvetica', size)) / 2, page.height - 32,
    { size, color: COLORS.counter });
  return page;
}

// Uma cena: ilustração no topo e o texto embaixo; o que não couber continua na página seguinte.
function drawScene(doc, scene, index, total) {
  const counter = `${index + 1} / ${total}`;
  const lh = BODY.size * BODY.lineHeight;
  const bottom = A4.height - MARGIN - 8;
  let lines = wrapLines(scene?.text, { ...BODY, width: CONTENT_W });
  let page = addScenePage(doc, counter);
  let top = MARGIN;
  const drawn = drawIR(page, scene?.image, { x: MARGIN, y: top, width: CONTENT_W, height: 420, radius: 14 });
  if (drawn) top += drawn.height + 30;
  for (;;) {
    const fits = Math.max(0, Math.floor((bottom - top + 1e-6) / lh));
    const chunk = lines.slice(0, fits);
    if (chunk.length) drawLines(page, chunk, { x: MARGIN, top, width: CONTENT_W, ...BODY, color: COLORS.ink, align: 'justify' });
    lines = lines.slice(fits);
    while (lines.length && !lines[0].text) lines.shift(); // não começa página com linha vazia
    if (!lines.length) break;
    page = addScenePage(doc, counter);
    top = MARGIN;
  }
}

// Estrela de 5 pontas como caminho SVG.
function starPath(cx, cy, r) {
  const points = [];
  for (let k = 0; k < 10; k++) {
    const angle = -Math.PI / 2 + (k * Math.PI) / 5;
    const radius = k % 2 ? r * 0.45 : r;
    points.push(`${num(cx + radius * Math.cos(angle))},${num(cy + radius * Math.sin(angle))}`);
  }
  return `M${points.join(' L')} Z`;
}

function drawEnd(doc, { lesson, siteName }) {
  const page = doc.addPage();
  page.fillRect(0, 0, page.width, page.height, COLORS.purple);
  const fimTop = page.height * 0.3;
  const fimSize = 60;
  // Estrelinhas em volta do "Fim" (desenhadas como IR, reaproveitando drawIR)
  const stars = [[-120, 10, 13, 1], [118, -4, 10, 0.9], [-82, -36, 7, 0.7], [94, 36, 7, 0.6], [150, 22, 5, 0.5]];
  drawIR(page, {
    width: page.width,
    height: page.height,
    children: stars.map(([dx, dy, r, opacity]) => ({
      type: 'path', d: starPath(page.width / 2 + dx, fimTop + 30 + dy, r), fill: COLORS.star, opacity,
    })),
  }, { x: 0, y: 0, width: page.width });
  drawLines(page, ['Fim'], { x: MARGIN, top: fimTop, width: CONTENT_W, font: 'Helvetica-Bold', size: fimSize,
    lineHeight: 1.2, color: '#FFFFFF', align: 'center' });
  const width = 400;
  const top = fimTop + fimSize * 1.2 + 26;
  const maxLines = Math.floor((page.height - MARGIN - 40 - top) / (LESSON.size * LESSON.lineHeight));
  const lines = truncateLines(wrapLines(lesson, { ...LESSON, width }), maxLines, { ...LESSON, width });
  drawLines(page, lines, { x: (page.width - width) / 2, top, width, ...LESSON, color: '#FFFFFF', align: 'center' });
  if (siteName) {
    const size = 10;
    page.text(siteName, (page.width - textWidth(siteName, 'Helvetica', size)) / 2, page.height - 40,
      { size, color: COLORS.lilac });
  }
}

// O livrinho completo. scenes = [{ text, image }], com image no formato IR.
export function renderStoryPDF({ title = '', childName = '', siteName = '', lesson = '', scenes = [] } = {}) {
  const list = Array.isArray(scenes) ? scenes : [];
  const doc = new PdfDocument({
    title: title || 'História',
    author: siteName,
    subject: childName ? `Uma história para ${childName}` : '',
    creator: siteName,
  });
  drawCover(doc, { title, childName, siteName, image: list[0]?.image });
  list.forEach((scene, index) => drawScene(doc, scene, index, list.length));
  drawEnd(doc, { lesson, siteName });
  return doc.toBuffer();
}
