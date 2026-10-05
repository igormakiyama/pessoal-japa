// Gerador de PDF: estrutura do arquivo, texto em WinAnsi, quebra de linhas, caminhos SVG,
// desenho do IR e o livrinho completo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import zlib from 'node:zlib';

import {
  A4, PdfDocument, arcToCubics, drawIR, encodeWinAnsi, parsePath, pdfString, pdfTextString,
  renderStoryPDF, textWidth, wrapLines, wrapText,
} from '../src/pdf.js';

// ---------------------------------------------------------------- utilitários

// Confere cabeçalho, xref, trailer e startxref; devolve os objetos (texto latin1) por número.
function checkStructure(buf) {
  const text = buf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'), 'cabeçalho %PDF-1.4');
  assert.ok(text.endsWith('%%EOF\n'), 'termina com %%EOF');
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 5), 'xref\n', 'startxref aponta para a tabela');
  const header = /^xref\n0 (\d+)\n/.exec(text.slice(startxref));
  const size = Number(header[1]);
  const tableStart = startxref + header[0].length;
  const entries = [];
  for (let i = 0; i < size; i++) {
    const entry = text.slice(tableStart + i * 20, tableStart + (i + 1) * 20);
    assert.match(entry, /^\d{10} \d{5} [nf] \n$/, `entrada ${i} da xref tem 20 bytes`);
    entries.push(entry);
  }
  assert.equal(entries[0], '0000000000 65535 f \n');
  const trailer = text.slice(tableStart + size * 20);
  assert.ok(trailer.startsWith('trailer\n'), 'trailer logo depois da xref');
  assert.match(trailer, new RegExp(`/Size ${size}\\b`));
  const root = Number(/\/Root (\d+) 0 R/.exec(trailer)[1]);
  const info = Number(/\/Info (\d+) 0 R/.exec(trailer)[1]);
  const objects = {};
  for (let n = 1; n < size; n++) {
    const offset = Number(entries[n].slice(0, 10));
    assert.equal(text.slice(offset, offset + `${n} 0 obj\n`.length), `${n} 0 obj\n`, `offset do objeto ${n}`);
    const end = text.indexOf('\nendobj\n', offset);
    objects[n] = text.slice(offset + `${n} 0 obj\n`.length, end);
  }
  assert.match(objects[root], /\/Type \/Catalog/);
  assert.match(objects[info], /\/Producer/);
  return { size, root, info, objects, text };
}

// Conteúdo descomprimido de cada página, na ordem de /Kids.
function pageContents(buf) {
  const { objects, root } = checkStructure(buf);
  const pagesId = Number(/\/Pages (\d+) 0 R/.exec(objects[root])[1]);
  const kids = [...objects[pagesId].matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  return kids.map((id) => {
    const contentId = Number(/\/Contents (\d+) 0 R/.exec(objects[id])[1]);
    const raw = Buffer.from(objects[contentId], 'latin1');
    const dict = raw.toString('latin1', 0, raw.indexOf('stream\n'));
    assert.match(dict, /\/Filter \/FlateDecode/);
    const length = Number(/\/Length (\d+)/.exec(dict)[1]);
    const start = raw.indexOf('stream\n') + 'stream\n'.length;
    assert.equal(raw.toString('latin1', start + length, start + length + 10), '\nendstream', '/Length correto');
    return zlib.inflateSync(raw.subarray(start, start + length)).toString('latin1');
  });
}

const near = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps, `esperado ${expected}, veio ${actual}`);

function nearList(actual, expected, eps = 1e-6) {
  assert.equal(actual.length, expected.length, `tamanho: ${JSON.stringify(actual)}`);
  actual.forEach((value, i) => {
    if (typeof expected[i] === 'number') near(value, expected[i], eps);
    else assert.equal(value, expected[i]);
  });
}

// Ponto da cúbica em t
function bezier([x0, y0], [, x1, y1, x2, y2, x3, y3], t) {
  const u = 1 - t;
  return [
    u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
    u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
  ];
}

// Percorre os segmentos e devolve pontos amostrados das curvas
function samplePoints(segs) {
  const points = [];
  let current = [0, 0];
  for (const seg of segs) {
    if (seg[0] === 'C') {
      for (const t of [0.25, 0.5, 0.75, 1]) points.push(bezier(current, seg, t));
      current = [seg[5], seg[6]];
    } else if (seg[0] !== 'Z') {
      current = [seg[1], seg[2]];
    }
  }
  return points;
}

const SKY = {
  width: 400,
  height: 250,
  children: [
    { type: 'rect', x: 0, y: 0, w: 400, h: 250, fill: { type: 'linear', x1: 0, y1: 0, x2: 0, y2: 250, stops: [[0, '#2B3A8C'], [0.6, '#E58BB8'], [1, '#FFE3A3']] } },
    { type: 'circle', cx: 320, cy: 60, r: 40, fill: '#FFF6C8', opacity: 0.5 },
    { type: 'ellipse', cx: 100, cy: 180, rx: 60, ry: 20, fill: '#8E44AD', stroke: '#2E1A47', strokeWidth: 3, lineJoin: 'round' },
    { type: 'group', transform: [1, 0, 0, 1, 200, 120], children: [
      { type: 'group', transform: [0.5, 0, 0, 0.5, 0, 0], children: [
        { type: 'rect', x: 0, y: 0, w: 100, h: 80, rx: 12, fill: '#F4D35E', stroke: '#7A4E2D', strokeWidth: 4 },
      ] },
    ] },
    { type: 'path', d: 'M10,10 L60,10', stroke: '#FFFFFF', strokeWidth: 8, lineCap: 'round' },
    { type: 'path', d: 'M150,60 A50,50 0 1 0 150,160 A25,50 0 0 1 150,60 Z', fill: '#FFF8D6' },
  ],
};

const LONG = 'Era uma vez uma menina chamada Ana, que adorava olhar as estrelas — e sonhava em visitá-las um dia… '
  + '“Será que a Lua é feita de queijo?”, perguntava ela à mãe, toda curiosa. ';

// ---------------------------------------------------------------- estrutura

test('PdfDocument gera PDF 1.4 com xref, trailer, /Root e /Info consistentes', () => {
  const doc = new PdfDocument({ title: 'História da Ana', author: 'Era Uma Vez Eu', date: new Date('2026-01-02T03:04:05Z') });
  doc.addPage().text('Olá (mundo) \\ teste', 50, 100);
  doc.addPage(300, 200).fillRect(0, 0, 300, 200, '#5B3E96');
  const buf = doc.toBuffer();
  const { objects, info, root } = checkStructure(buf);
  assert.match(objects[info], /\/CreationDate \(D:20260102030405Z\)/);
  // Título com acento vai em UTF-16BE
  assert.ok(objects[info].includes(`/Title ${pdfTextString('História da Ana')}`));
  assert.match(objects[info], /\/Author \(Era Uma Vez Eu\)/);
  const pagesId = Number(/\/Pages (\d+) 0 R/.exec(objects[root])[1]);
  assert.match(objects[pagesId], /\/Count 2/);
  const fonts = Object.values(objects).filter((body) => body.includes('/Type /Font'));
  assert.equal(fonts.length, 2);
  for (const font of fonts) {
    assert.match(font, /\/Subtype \/Type1 \/BaseFont \/Helvetica(-Bold)? \/Encoding \/WinAnsiEncoding/);
    assert.doesNotMatch(font, /FontFile/);
  }
  assert.ok(Object.values(objects).some((body) => body.includes('/MediaBox [0 0 300 200]')));
  const [first, second] = pageContents(buf);
  assert.ok(first.includes('(Ol\\341 \\(mundo\\) \\\\ teste) Tj'));
  assert.match(second, /0\.357 0\.243 0\.588 rg/);
});

// ---------------------------------------------------------------- texto

test('encodeWinAnsi codifica português, aspas curvas, travessão e reticências', () => {
  const bytes = (s) => [...encodeWinAnsi(s)];
  assert.deepEqual(bytes('ç ã õ é á ú â ê ô'), [0xe7, 32, 0xe3, 32, 0xf5, 32, 0xe9, 32, 0xe1, 32, 0xfa, 32, 0xe2, 32, 0xea, 32, 0xf4]);
  assert.deepEqual(bytes('Ação'), [0x41, 0xe7, 0xe3, 0x6f]);
  assert.deepEqual(bytes('“oi”'), [147, 0x6f, 0x69, 148]);
  assert.deepEqual(bytes('— – … ‘’ €'), [151, 32, 150, 32, 133, 32, 145, 146, 32, 128]);
  // Acento decomposto (e + acento agudo) vira o caractere composto
  assert.deepEqual(bytes('e' + String.fromCodePoint(0x301)), [0xe9]);
  // Fora da tabela: tira o acento, senão '?'
  assert.deepEqual(bytes('ő ǎ'), [0x6f, 32, 0x61]);
  assert.deepEqual(bytes('中'), [63]);
  assert.deepEqual(bytes(String.fromCodePoint(0x1f600)), [63]);
  // Quebras de linha viram espaço; caracteres invisíveis somem
  assert.deepEqual(bytes(`a\nb${String.fromCodePoint(0x200b)}c`), [0x61, 32, 0x62, 0x63]);
  assert.deepEqual(bytes(''), []);
});

test('pdfString escapa parênteses e barra e usa octal fora do ASCII', () => {
  assert.equal(pdfString(encodeWinAnsi('(a)\\b')), '(\\(a\\)\\\\b)');
  assert.equal(pdfString(encodeWinAnsi('é“')), '(\\351\\223)');
  assert.equal(pdfString(Buffer.from([9, 65])), '(\\011A)');
  assert.equal(pdfTextString('Ana'), '(Ana)');
  assert.equal(pdfTextString('é'), '<FEFF00E9>');
});

test('textWidth usa as larguras reais da Helvetica', () => {
  // H e l l o = 722 + 556 + 222 + 222 + 556
  near(textWidth('Hello', 'Helvetica', 10), 22.78);
  near(textWidth('Hello', 'Helvetica-Bold', 10), (722 + 556 + 278 + 278 + 611) / 100);
  near(textWidth('ã', 'Helvetica', 1000), 556);
  near(textWidth('…', 'Helvetica', 1000), 1000);
  assert.equal(textWidth('', 'Helvetica', 12), 0);
});

test('wrapText respeita a largura, mantém as palavras e trata parágrafos', () => {
  const opts = { font: 'Helvetica', size: 13, width: 200 };
  const lines = wrapText(LONG.repeat(3), opts);
  assert.ok(lines.length > 5);
  for (const line of lines) assert.ok(textWidth(line, 'Helvetica', 13) <= 200 + 1e-6, `linha larga demais: ${line}`);
  assert.equal(lines.join(' '), LONG.repeat(3).trim().replace(/\s+/g, ' '));
  // Guloso: a próxima palavra não caberia na linha
  for (let i = 0; i < lines.length - 1; i++) {
    const next = lines[i + 1].split(' ')[0];
    assert.ok(textWidth(`${lines[i]} ${next}`, 'Helvetica', 13) > 200);
  }
  // Palavra maior que a linha é quebrada por caracteres
  const long = wrapText('a'.repeat(100), { size: 12, width: 50 });
  assert.ok(long.length > 1);
  for (const line of long) assert.ok(textWidth(line, 'Helvetica', 12) <= 50);
  assert.equal(long.join(''), 'a'.repeat(100));
  // Parágrafos, linha em branco preservada e "last" marcando fim de parágrafo
  const paras = wrapLines('Primeiro.\n\nSegundo  parágrafo.', { size: 12, width: 500 });
  assert.deepEqual(paras.map((l) => [l.text, l.last]), [['Primeiro.', true], ['', true], ['Segundo parágrafo.', true]]);
  // Espaço sem quebra não divide a palavra
  const nbsp = String.fromCodePoint(0xa0);
  assert.deepEqual(wrapText(`aaa${nbsp}bbb ccc`, { size: 10, width: textWidth(`aaa${nbsp}bbb`, 'Helvetica', 10) }), [`aaa${nbsp}bbb`, 'ccc']);
  assert.deepEqual(wrapText('   ', opts), []);
  assert.deepEqual(wrapText(undefined, opts), []);
});

// ---------------------------------------------------------------- caminhos

test('parsePath: absolutos, H/V, Z e lineto implícito', () => {
  assert.deepEqual(parsePath('M10 20 L30 40 H50 V60 Z'),
    [['M', 10, 20], ['L', 30, 40], ['L', 50, 40], ['L', 50, 60], ['Z']]);
  assert.deepEqual(parsePath('M0 0 10 10 20 0'), [['M', 0, 0], ['L', 10, 10], ['L', 20, 0]]);
  assert.deepEqual(parsePath('M.5.5L-1-2,3e1 1E-1'), [['M', 0.5, 0.5], ['L', -1, -2], ['L', 30, 0.1]]);
  // Caminho que não começa com M não desenha nada
  assert.deepEqual(parsePath('L10 10'), []);
  // Erro de sintaxe: para no ponto do erro, como o navegador
  assert.deepEqual(parsePath('M0 0 L10 10 L20'), [['M', 0, 0], ['L', 10, 10]]);
  assert.deepEqual(parsePath('M0 0 L5 5 X 9 9'), [['M', 0, 0], ['L', 5, 5]]);
});

test('parsePath: comandos relativos, m implícito e retomada depois de z', () => {
  assert.deepEqual(parsePath('m10 20 l10 0 h5 v5 z m5 5 l1 1'), [
    ['M', 10, 20], ['L', 20, 20], ['L', 25, 20], ['L', 25, 25], ['Z'], ['M', 15, 25], ['L', 16, 26],
  ]);
  assert.deepEqual(parsePath('m1 1 2 2 3 3'), [['M', 1, 1], ['L', 3, 3], ['L', 6, 6]]);
  // Desenho depois de Z sem moveto recomeça no início do subcaminho
  assert.deepEqual(parsePath('M5 5 L10 5 Z l0 10'), [['M', 5, 5], ['L', 10, 5], ['Z'], ['M', 5, 5], ['L', 5, 15]]);
  assert.deepEqual(parsePath('M0 0 c10 0 20 10 30 10'), [['M', 0, 0], ['C', 10, 0, 20, 10, 30, 10]]);
});

test('parsePath: S e T refletem o controle anterior; Q vira C', () => {
  assert.deepEqual(parsePath('M0 0 C10 0 20 10 30 10 S50 20 60 10'),
    [['M', 0, 0], ['C', 10, 0, 20, 10, 30, 10], ['C', 40, 10, 50, 20, 60, 10]]);
  assert.deepEqual(parsePath('M0 0 C10 0 20 10 30 10 s20 10 30 0'),
    [['M', 0, 0], ['C', 10, 0, 20, 10, 30, 10], ['C', 40, 10, 50, 20, 60, 10]]);
  // S sem C antes: primeiro controle = ponto atual
  assert.deepEqual(parsePath('M5 5 S10 10 20 5'), [['M', 5, 5], ['C', 5, 5, 10, 10, 20, 5]]);
  const q = parsePath('M0 0 Q10 10 20 0');
  nearList(q[1], ['C', 20 / 3, 20 / 3, 20 - 20 / 3, 20 / 3, 20, 0]);
  // T reflete o controle de Q: (10,10) refletido em (20,0) = (30,-10)
  const t = parsePath('M0 0 Q10 10 20 0 T40 0');
  nearList(t[2], ['C', 20 + (2 / 3) * 10, (2 / 3) * -10, 40 - (2 / 3) * 10, (2 / 3) * -10, 40, 0]);
  const tRel = parsePath('m0 0 q10 10 20 0 t20 0');
  nearList(tRel[2], t[2]);
  // T sem Q antes: controle = ponto atual (vira reta)
  nearList(parsePath('M0 0 T30 0')[1], ['C', 0, 0, 10, 0, 30, 0]);
  // S depois de Q não reflete
  assert.deepEqual(parsePath('M0 0 Q10 10 20 0 S30 10 40 0')[2], ['C', 20, 0, 30, 10, 40, 0]);
});

test('parsePath: arcos viram cúbicas sobre a elipse certa', () => {
  // Meia-volta com sweep=1 (sentido positivo no y para baixo): passa por (10,-10)
  const half = parsePath('M0 0 A10 10 0 0 1 20 0');
  assert.equal(half.length, 3);
  assert.deepEqual(half.slice(1).map((s) => s[0]), ['C', 'C']);
  near(half[1][5], 10, 1e-9);
  near(half[1][6], -10, 1e-9);
  assert.deepEqual(half[2].slice(5), [20, 0]);
  for (const [x, y] of samplePoints(half)) near(Math.hypot(x - 10, y), 10, 0.01);
  // sweep=0 vai pelo outro lado
  const other = parsePath('M0 0 A10 10 0 0 0 20 0');
  near(other[1][6], 10, 1e-9);
  // Relativo, com flags compactas ("0120" = flags 0 e 1, depois x=20)
  assert.deepEqual(parsePath('M0 0a10 10 0 0120 0'), half);
  // Raio pequeno demais é aumentado até caber
  const scaled = parsePath('M0 0 A1 1 0 0 0 20 0');
  for (const [x, y] of samplePoints(scaled)) near(Math.hypot(x - 10, y), 10, 0.01);
  // Arco grande (large-arc=1, sweep=1) de 270°: centro (10,10), em 3 cúbicas
  const large = parsePath('M10 0 A10 10 0 1 1 0 10');
  assert.equal(large.length, 4);
  for (const [x, y] of samplePoints(large)) near(Math.hypot(x - 10, y - 10), 10, 0.02);
  // Elipse girada de 30° centrada na origem: de θ=0 a θ=90°, pelos dois lados
  const phi = (30 * Math.PI) / 180;
  const at = (deg) => {
    const a = (deg * Math.PI) / 180;
    const [u, v] = [40 * Math.cos(a), 20 * Math.sin(a)];
    return [Math.cos(phi) * u - Math.sin(phi) * v, Math.sin(phi) * u + Math.cos(phi) * v];
  };
  const onEllipse = ([x, y]) => {
    const u = Math.cos(phi) * x + Math.sin(phi) * y;
    const v = -Math.sin(phi) * x + Math.cos(phi) * y;
    return (u * u) / 1600 + (v * v) / 400;
  };
  const [p0, p1] = [at(0), at(90)];
  const small = parsePath(`M${p0[0]} ${p0[1]} A40 20 30 0 1 ${p1[0]} ${p1[1]}`);
  assert.equal(small.length, 2);
  nearList(small[1].slice(5), p1, 1e-9);
  for (const p of samplePoints(small)) near(onEllipse(p), 1, 0.01);
  near(bezier(p0, small[1], 0.5)[0], at(45)[0], 0.05);
  near(bezier(p0, small[1], 0.5)[1], at(45)[1], 0.05);
  const rest = parsePath(`M${p0[0]} ${p0[1]} A40 20 30 1 0 ${p1[0]} ${p1[1]}`);
  assert.equal(rest.length, 4);
  for (const p of samplePoints(rest)) near(onEllipse(p), 1, 0.01);
  nearList(rest[1].slice(5), at(-90), 1e-9);
  assert.equal(arcToCubics(...p0, 40, 20, 30, true, false, ...p1).length, 3);
  // Raio zero vira reta; ponto final igual ao inicial não desenha
  assert.deepEqual(parsePath('M0 0 A0 10 0 0 1 20 0'), [['M', 0, 0], ['L', 20, 0]]);
  assert.deepEqual(parsePath('M5 5 A10 10 0 0 1 5 5 L6 6'), [['M', 5, 5], ['L', 6, 6]]);
});

// ---------------------------------------------------------------- IR

test('drawIR desenha o IR na caixa: inversão do y, recorte, degradê, opacidade e traço', () => {
  const doc = new PdfDocument();
  const page = doc.addPage();
  const area = drawIR(page, SKY, { x: 50, y: 60, width: 200, radius: 10 });
  assert.deepEqual(area, { x: 50, y: 60, width: 200, height: 125 });
  const buf = doc.toBuffer();
  const [content] = pageContents(buf);
  // Escala 0.5, y invertido, origem no topo da caixa
  assert.ok(content.includes(`0.5 0 0 -0.5 50 ${Math.round((A4.height - 60) * 1000) / 1000} cm`));
  // Recorte arredondado (raio 10 pt = 20 unidades do IR) logo depois
  assert.match(content, /cm\n20 0 m 380 0 l [^\n]* c [^\n]*h W n/);
  assert.match(content, /W n\n\/Sh1 sh/);
  assert.match(content, /\/GS1 gs/);
  // Grupos aninhados: as matrizes entram em ordem, cada uma dentro de q/Q
  const outer = content.indexOf('q\n1 0 0 1 200 120 cm');
  assert.ok(outer > 0 && content.indexOf('q\n0.5 0 0 0.5 0 0 cm') > outer);
  assert.match(content, / B\n/);
  assert.match(content, /1 J/);
  assert.match(content, /1 j/);
  assert.match(content, /8 w/);
  assert.match(content, /4 M/);
  // q/Q equilibrados
  assert.equal((content.match(/^q$/gm) || []).length, (content.match(/^Q$/gm) || []).length);
  const resources = checkStructure(buf).text;
  assert.match(resources, /\/GS1 << \/Type \/ExtGState \/ca 0\.5 \/CA 0\.5 >>/);
  assert.match(resources, /\/ShadingType 2 \/ColorSpace \/DeviceRGB \/Coords \[0 0 0 250\]/);
  assert.match(resources, /\/FunctionType 3 .*\/Bounds \[0\.6\] \/Encode \[0 1 0 1\]/);
  assert.match(resources, /\/Extend \[true true\]/);
  // Altura limitada: encaixa na caixa mantendo a proporção, centralizado na horizontal
  const fit = drawIR(doc.addPage(), SKY, { x: 0, y: 0, width: 400, height: 100 });
  assert.deepEqual(fit, { x: 120, y: 0, width: 160, height: 100 });
  // IR inválido não desenha
  assert.equal(drawIR(page, null, { x: 0, y: 0, width: 10 }), null);
  assert.equal(drawIR(page, { width: 0, height: 10, children: [] }, { x: 0, y: 0, width: 10 }), null);
});

test('drawIR ignora formas invisíveis e degradês degenerados', () => {
  const doc = new PdfDocument();
  const page = doc.addPage();
  drawIR(page, {
    width: 100,
    height: 100,
    children: [
      { type: 'rect', x: 0, y: 0, w: 0, h: 10, fill: '#FF0000' },
      { type: 'circle', cx: 5, cy: 5, r: 3, fill: '#FF0000', opacity: 0 },
      { type: 'circle', cx: 5, cy: 5, r: 3, stroke: '#00FF00', strokeWidth: 0 },
      { type: 'path', d: 'M0 0', fill: '#FF0000' },
      { type: 'group', transform: [0, 0, 0, 0, 0, 0], children: [{ type: 'rect', x: 0, y: 0, w: 5, h: 5, fill: '#FF0000' }] },
      { type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: { type: 'linear', x1: 5, y1: 5, x2: 5, y2: 5, stops: [[0, '#000000'], [1, '#0000FF']] } },
    ],
  }, { x: 0, y: 0, width: 100 });
  const content = pageContents(doc.toBuffer())[0];
  assert.doesNotMatch(content, /1 0 0 rg/);
  assert.doesNotMatch(content, / sh/);
  // Vetor de comprimento zero: pinta com a cor da última parada
  assert.match(content, /0 0 1 rg\n0 0 10 10 re f/);
});

// ---------------------------------------------------------------- livrinho

const scene = (text) => ({ text, image: SKY });

test('renderStoryPDF: capa, uma página por cena e Fim, mesmo sem lição', () => {
  for (const lesson of ['', undefined]) {
    const buf = renderStoryPDF({ title: 'A aventura', childName: 'Ana', siteName: 'Era Uma Vez Eu', lesson, scenes: [scene('Oi.'), scene('Tchau.')] });
    const pages = pageContents(buf);
    assert.equal(pages.length, 4);
    assert.ok(pages[0].includes('(A aventura) Tj'));
    assert.ok(pages[0].includes(pdfString(encodeWinAnsi('Uma história feita especialmente para Ana · Era Uma Vez Eu'))));
    assert.ok(pages[1].includes('(1 / 2) Tj'));
    assert.ok(pages[2].includes('(2 / 2) Tj'));
    assert.ok(pages[3].includes('(Fim) Tj'));
    // Fundo roxo da página final
    assert.match(pages[3], /0\.357 0\.243 0\.588 rg/);
  }
  // Sem cenas: capa e Fim
  assert.equal(pageContents(renderStoryPDF({ title: 'Vazia' })).length, 2);
});

test('renderStoryPDF: texto longo continua em páginas novas, sem perder palavras', () => {
  const text = LONG.repeat(40);
  const buf = renderStoryPDF({ title: 'Longa', childName: 'Ana', siteName: 'Site', lesson: 'Lição.', scenes: [scene(text), scene('Curta.')] });
  const pages = pageContents(buf);
  assert.ok(pages.length >= 6, `páginas: ${pages.length}`);
  const scenePages = pages.filter((p) => p.includes('(1 / 2) Tj'));
  assert.ok(scenePages.length >= 3);
  // Só a primeira página da cena tem a ilustração
  assert.equal(scenePages.filter((p) => p.includes(' sh')).length, 1);
  // Todas as palavras aparecem, na ordem
  const words = scenePages.join('\n').match(/\((?:[^()\\]|\\.)*\) Tj/g)
    .map((s) => s.slice(1, -4)).filter((s) => s !== '1 / 2').join(' ');
  assert.equal(words, pdfString(encodeWinAnsi(text.trim())).slice(1, -1));
  // Nenhuma linha passa da margem inferior (y >= 56 pt do rodapé, fora o contador)
  for (const page of scenePages) {
    for (const [, y] of page.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm\n\((?!1 \/ 2)/g)) assert.ok(Number(y) >= 56, `linha em y=${y}`);
  }
  assert.ok(pages[pages.length - 2].includes('(2 / 2) Tj'));
});

test('renderStoryPDF: livrinho de 5 cenas fica bem abaixo de 1 MB', () => {
  const buf = renderStoryPDF({ title: 'Cinco', childName: 'Bia', siteName: 'Site', lesson: 'Seja gentil.', scenes: Array.from({ length: 5 }, () => scene(LONG.repeat(3))) });
  checkStructure(buf);
  assert.ok(buf.length < 200 * 1024, `tamanho: ${buf.length}`);
});

// ---------------------------------------------------------------- ferramentas externas (opcional)

const hasPoppler = fs.existsSync('/usr/bin/pdftotext') && fs.existsSync('/usr/bin/pdftoppm');

test('poppler lê o PDF sem avisos e extrai o texto com acentos', { skip: !hasPoppler && 'poppler ausente' }, () => {
  const buf = renderStoryPDF({
    title: 'Ação, coração e emoção',
    childName: 'João',
    siteName: 'Era Uma Vez Eu',
    lesson: 'Às vezes é difícil — mas você consegue… “sempre”.',
    scenes: [scene('Ela pôs o chapéu e saiu: “Vamos à praia!”')],
  });
  const text = spawnSync('/usr/bin/pdftotext', ['-', '-'], { input: buf });
  assert.equal(text.status, 0);
  assert.equal(text.stderr.toString(), '');
  const out = text.stdout.toString('utf8');
  assert.ok(out.includes('Ação, coração e emoção'));
  assert.ok(out.includes('Uma história feita especialmente para João · Era Uma Vez Eu'));
  assert.ok(out.includes('Ela pôs o chapéu e saiu: “Vamos à praia!”'));
  assert.ok(out.includes('Às vezes é difícil — mas você consegue… “sempre”.'));
  const png = spawnSync('/usr/bin/pdftoppm', ['-png', '-r', '20', '-'], { input: buf, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(png.status, 0);
  assert.equal(png.stderr.toString(), '');
  assert.ok(png.stdout.subarray(1, 4).toString() === 'PNG');
});

// ---------------------------------------------------------------- integração com o ilustrador

const hasIllustrator = fs.existsSync(new URL('../src/illustrate.js', import.meta.url));

test('integração: cenas do ilustrador (sceneIR) viram um livrinho válido', { skip: !hasIllustrator && 'ilustrador ausente' }, async () => {
  const { sceneIR } = await import('../src/illustrate.js');
  const { DEFAULT_APPEARANCE, SCENES } = await import('../src/content.js');
  const keys = Object.keys(SCENES).slice(0, 5);
  const buf = renderStoryPDF({
    title: 'Ana e o Dragão Gentil',
    childName: 'Ana',
    siteName: 'Era Uma Vez Eu',
    lesson: 'Ser gentil é a maior magia.',
    scenes: keys.map((key, i) => ({ text: LONG.repeat(2), image: sceneIR(key, i % 2 === 1, DEFAULT_APPEARANCE, 'gato', `t${i}`) })),
  });
  const pages = pageContents(buf);
  assert.equal(pages.length, 7);
  assert.ok(buf.length < 1024 * 1024, `tamanho: ${buf.length}`);
  if (hasPoppler) {
    const png = spawnSync('/usr/bin/pdftoppm', ['-png', '-r', '20', '-'], { input: buf, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(png.status, 0);
    assert.equal(png.stderr.toString(), '');
  }
});
