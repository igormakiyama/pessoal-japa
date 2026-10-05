// Testes do ilustrador: IR válido, SVG bem formado, sorteio determinístico e paridade com a versão Python.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  translate, scale, rotate, multiply, sceneIR, avatarIR, toSVG, sceneSVG, avatarSVG,
} from '../src/illustrate.js';
import {
  SCENES, SKIN_TONES, HAIR_COLORS, HAIR_STYLES, EYE_COLORS, FAVORITE_COLORS, PETS, DEFAULT_APPEARANCE,
} from '../src/content.js';

const HEX = /^#[0-9A-F]{6}$/i;
const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];

const APPEARANCES = [
  { skin: 'escura', hair_style: 'crespo', hair_color: 'preto', eyes: 'castanhos', glasses: true, fav_color: 'roxo' },
  { skin: 'clara', hair_style: 'rabo', hair_color: 'ruivo', eyes: 'azuis', glasses: false, fav_color: 'rosa' },
  {},
];

const apply = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

function assertClose(actual, expected, eps = 1e-9) {
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < eps, `${actual} != ${expected}`));
}

// Verificador mínimo de XML: tags bem formadas e balanceadas, atributos únicos,
// ids únicos e toda referência url(#id) definida.
function assertWellFormedSVG(svg) {
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" '), 'começa com <svg xmlns>');
  assert.ok(svg.endsWith('</svg>'), 'termina com </svg>');
  const stack = [];
  const ids = new Set();
  const refs = [];
  let roots = 0;
  let consumed = 0;
  for (const [tok] of svg.matchAll(/<[^<>]*>|[^<]+/g)) {
    consumed += tok.length;
    if (!tok.startsWith('<')) {
      assert.match(tok, /^\s*$/, `texto solto: ${tok.slice(0, 40)}`);
      continue;
    }
    const m = tok.match(/^<(\/?)([a-zA-Z][\w:-]*)((?:\s+[a-zA-Z][\w:-]*="[^"<>]*")*)\s*(\/?)>$/);
    assert.ok(m, `tag malformada: ${tok}`);
    const [, closing, name, attrs, selfClose] = m;
    if (closing) {
      assert.equal(attrs + selfClose, '', `fechamento com atributos: ${tok}`);
      assert.equal(stack.pop(), name, `fechamento fora de ordem: ${tok}`);
      continue;
    }
    if (stack.length === 0) roots += 1;
    const seen = new Set();
    for (const [, attr, value] of attrs.matchAll(/([a-zA-Z][\w:-]*)="([^"]*)"/g)) {
      assert.ok(!seen.has(attr), `atributo repetido ${attr} em ${tok}`);
      seen.add(attr);
      assert.doesNotMatch(value, /&(?!(?:amp|lt|gt|quot|#39);)/, `& sem escape em ${tok}`);
      if (attr === 'id') {
        assert.ok(!ids.has(value), `id repetido ${value}`);
        ids.add(value);
      }
      const ref = value.match(/^url\(#(.+)\)$/);
      if (ref) refs.push(ref[1]);
    }
    if (!selfClose) stack.push(name);
  }
  assert.equal(consumed, svg.length, 'sobrou "<" sem fechar');
  assert.deepEqual(stack, [], 'tags abertas');
  assert.equal(roots, 1, 'um único elemento raiz');
  for (const ref of refs) assert.ok(ids.has(ref), `url(#${ref}) sem definição`);
  assert.doesNotMatch(svg, /\d\.\d{3,}/, 'números com mais de 2 casas');
  assert.doesNotMatch(svg, /NaN|undefined|Infinity|null/, 'valor inválido no SVG');
}

function assertFinite(node, keys) {
  for (const key of keys) assert.ok(Number.isFinite(node[key]), `${node.type}.${key} = ${node[key]}`);
}

function assertPaint(fill) {
  if (fill === undefined || fill === null) return;
  if (typeof fill === 'string') {
    assert.match(fill, HEX);
    return;
  }
  assert.equal(fill.type, 'linear');
  assertFinite(fill, ['x1', 'y1', 'x2', 'y2']);
  assert.ok(fill.stops.length >= 2);
  for (const [offset, color] of fill.stops) {
    assert.ok(offset >= 0 && offset <= 1);
    assert.match(color, HEX);
  }
}

// Confere o contrato do IR (o mesmo que o pdf.js consome). Devolve o total de formas.
function assertValidIR(root, width, height) {
  assert.equal(root.width, width);
  assert.equal(root.height, height);
  let shapes = 0;
  const walk = (node) => {
    if (node.type === 'group') {
      for (const key of ['opacity', 'fill', 'stroke']) assert.equal(node[key], undefined, `grupo com ${key}`);
      if (node.transform !== undefined) {
        assert.equal(node.transform.length, 6);
        node.transform.forEach((v) => assert.ok(Number.isFinite(v)));
      }
      assert.ok(Array.isArray(node.children));
      node.children.forEach(walk);
      return;
    }
    shapes += 1;
    if (node.type === 'rect') {
      assertFinite(node, ['x', 'y', 'w', 'h']);
      if (node.rx !== undefined) assertFinite(node, ['rx']);
    } else if (node.type === 'circle') {
      assertFinite(node, ['cx', 'cy', 'r']);
    } else if (node.type === 'ellipse') {
      assertFinite(node, ['cx', 'cy', 'rx', 'ry']);
    } else if (node.type === 'path') {
      assert.match(node.d, /^M[-\d.,\sMmLlHhVvCcSsQqTtAaZz]+$/, `caminho inválido: ${node.d}`);
      assert.doesNotMatch(node.d, /NaN|undefined/);
    } else {
      assert.fail(`tipo inválido: ${node.type}`);
    }
    assertPaint(node.fill);
    if (node.stroke !== undefined && node.stroke !== null) assert.match(node.stroke, HEX);
    assert.ok(node.fill || node.stroke, `forma invisível: ${JSON.stringify(node)}`);
    if (node.strokeWidth !== undefined) assert.ok(node.strokeWidth > 0);
    if (node.lineCap !== undefined) assert.ok(CAPS.includes(node.lineCap));
    if (node.lineJoin !== undefined) assert.ok(JOINS.includes(node.lineJoin));
    if (node.opacity !== undefined) assert.ok(node.opacity >= 0 && node.opacity <= 1);
  };
  root.children.forEach(walk);
  return shapes;
}

// Todas as formas do IR, com a matriz acumulada.
function flatten(root) {
  const out = [];
  const walk = (node, m) => {
    if (node.type === 'group') {
      const next = node.transform ? multiply(m, node.transform) : m;
      node.children.forEach((child) => walk(child, next));
    } else {
      out.push({ node, m });
    }
  };
  root.children.forEach((node) => walk(node, [1, 0, 0, 1, 0, 0]));
  return out;
}

const hasFence = (ir) => flatten(ir).some(({ node }) => node.type === 'path' && node.d.startsWith('M0,380 L0,322'));

test('matrizes: translate, scale, rotate e multiply', () => {
  assert.deepEqual(translate(3, 4), [1, 0, 0, 1, 3, 4]);
  assert.deepEqual(scale(2), [2, 0, 0, 2, 0, 0]);
  assert.deepEqual(scale(2, 3), [2, 0, 0, 3, 0, 0]);
  assertClose(apply(rotate(90), 1, 0), [0, 1]);
  assertClose(apply(rotate(90, 10, 0), 20, 0), [10, 10]);
  assertClose(apply(rotate(-18, 166, 128), 166, 128), [166, 128]);
  // multiply(m1, m2) aplica m2 primeiro, como transform="m1 m2"
  assertClose(apply(multiply(translate(5, 0), scale(2)), 1, 1), [7, 2]);
  assertClose(apply(multiply(scale(2), translate(5, 0)), 1, 1), [12, 2]);
  assertClose(multiply(rotate(30), rotate(-30)), [1, 0, 0, 1, 0, 0]);
});

test('toda cena, de dia e de noite, com várias aparências: IR válido e SVG bem formado', () => {
  const pets = Object.keys(PETS);
  let n = 0;
  for (const scene of Object.keys(SCENES)) {
    for (const night of [false, true]) {
      APPEARANCES.forEach((app, i) => {
        const pet = pets[(n + i) % pets.length];
        const ir = sceneIR(scene, night, app, pet, `t${n}`);
        assert.ok(assertValidIR(ir, 800, 500) > 20, `${scene} tem poucas formas`);
        const svg = toSVG(ir);
        assertWellFormedSVG(svg);
        assert.ok(svg.includes('viewBox="0 0 800 500" width="800" height="500" aria-hidden="true"'));
        n += 1;
      });
    }
  }
});

test('cada cenário do catálogo tem desenho próprio e cenário desconhecido vira jardim', () => {
  for (const scene of Object.keys(SCENES)) {
    assert.equal(hasFence(sceneIR(scene, false, {}, '', 'x')), scene === 'jardim', scene);
  }
  for (const scene of ['cenario_inexistente', '', undefined, null, 'constructor', '__proto__', 'toString']) {
    const ir = sceneIR(scene, false, {}, '', 'x');
    assert.ok(hasFence(ir), `fallback de ${scene}`);
    assertValidIR(ir, 800, 500);
    assertWellFormedSVG(toSVG(ir));
  }
});

test('mesma semente desenha igual; semente diferente desenha diferente', () => {
  for (const scene of Object.keys(SCENES)) {
    for (const night of [false, true]) {
      const a = sceneSVG(scene, night, APPEARANCES[0], 'gato', 'x');
      assert.equal(a, sceneSVG(scene, night, APPEARANCES[0], 'gato', 'x'));
      const args = [scene, night, APPEARANCES[0], 'gato', 'x'];
      assert.deepEqual(sceneIR(...args), sceneIR(...args));
      assert.notEqual(a, sceneSVG(scene, night, APPEARANCES[0], 'gato', 'y'), `${scene} ignora a semente`);
    }
  }
  // dia e noite mudam a paleta
  assert.notEqual(sceneSVG('praia', false, {}, '', 'x'), sceneSVG('praia', true, {}, '', 'x'));
  // semente padrão
  assert.equal(sceneSVG('praia', false, {}), sceneSVG('praia', false, {}, '', '0'));
});

test('sorteio idêntico ao da versão Python (histórias antigas continuam iguais)', () => {
  // random.Random("praia-x").uniform(600, 720) e uniform(60, 90) no Python: posição do sol
  const sunCore = flatten(sceneIR('praia', false, {}, '', 'x'))
    .find(({ node }) => node.type === 'circle' && node.r === 38 && node.fill === '#FFD54F');
  assert.equal(sunCore.node.cx, 618.9748948317223);
  assert.equal(sunCore.node.cy, 80.52605621097769);

  // Grupo da criança e do bichinho exatamente como no SVG gerado pelo Python
  const cases = [
    [['cidade', true, {}, 'gato', '12-3'], [171.8, 213.8, 0.8], [432.8, 383.2, -0.8]],
    [['quarto', false, { hair_style: 'rabo' }, 'cachorro', '7-0'], [241.5, 206.8, 0.8], [502.5, 376.2, -0.8]],
    [['espaco', true, {}, 'coelho', 'exemplo-2'], [399.9, 213.8, 0.8], [660.9, 383.2, -0.8]],
  ];
  for (const [args, child, pet] of cases) {
    const ir = sceneIR(...args);
    // a criança e o bichinho começam pela sombra (elipse em y=292 e y=106)
    const byShadow = (cy) => ir.children.find((node) => node.type === 'group'
      && node.children[0].type === 'ellipse' && node.children[0].cy === cy);
    const kid = byShadow(292).transform;
    const animal = byShadow(106).transform;
    assert.deepEqual(kid, [child[2], 0, 0, 0.8, child[0], child[1]]);
    assert.deepEqual(animal, [pet[2], 0, 0, 0.8, pet[0], pet[1]]);
  }
});

test('noite escurece a criança e o cenário (mistura de cor)', () => {
  const day = sceneSVG('jardim', false, { skin: 'clara' }, '', 'x');
  const night = sceneSVG('jardim', true, { skin: 'clara' }, '', 'x');
  assert.ok(day.includes(`fill="${SKIN_TONES.clara}"`));
  assert.ok(!night.includes(`fill="${SKIN_TONES.clara}"`));
  // valores calculados pelo _mix do Python: pele #F8D9C0 a 12% e grama #8BC34A a 42% de #1E2350
  assert.ok(night.includes('fill="#DEC3B3"'));
  assert.ok(night.includes('fill="#5D804D"'));
  // janela apagada #E3F2FD a 50%: 128,5 arredonda para o par (128), como no Python
  assert.ok(sceneSVG('cidade', true, {}, '', 'q').includes('fill="#808AA6"'));
});

test('toda combinação de opções de aparência renderiza', () => {
  const pets = Object.keys(PETS);
  const hairs = Object.keys(HAIR_COLORS);
  let n = 0;
  for (const skin of Object.keys(SKIN_TONES)) {
    for (const style of Object.keys(HAIR_STYLES)) {
      for (const eyes of Object.keys(EYE_COLORS)) {
        for (const fav of Object.keys(FAVORITE_COLORS)) {
          for (const pet of pets) {
            const hair = hairs[n % hairs.length];
            const app = { skin, hair_style: style, hair_color: hair, eyes, glasses: n % 2 === 0, fav_color: fav };
            const ir = avatarIR(app, pet);
            assertValidIR(ir, 300, 300);
            const svg = toSVG(ir);
            assertWellFormedSVG(svg);
            for (const color of [SKIN_TONES[skin], HAIR_COLORS[hair], EYE_COLORS[eyes], FAVORITE_COLORS[fav]]) {
              assert.ok(svg.includes(color), `${color} ausente em ${JSON.stringify(app)}`);
            }
            n += 1;
          }
        }
      }
    }
  }
  assert.equal(n, 5 * 6 * 3 * 7 * 4);
});

test('aparência ausente ou inválida usa o padrão', () => {
  const expected = avatarSVG(DEFAULT_APPEARANCE);
  assert.equal(avatarSVG(null), expected);
  assert.equal(avatarSVG(undefined), expected);
  assert.equal(avatarSVG({}), expected);
  const weird = avatarSVG({
    skin: 'azul', hair_color: 'constructor', eyes: '__proto__', fav_color: 1, hair_style: 'moicano',
  });
  assertWellFormedSVG(weird);
  assert.equal(weird, expected);
  // óculos aparecem só quando pedidos
  assert.ok(avatarSVG({ glasses: true }).includes('#2E2A3A'));
  assert.ok(!expected.includes('#2E2A3A'));
});

test('avatarSVG funciona para todos os bichinhos', () => {
  const fur = { cachorro: '#C98B4E', gato: '#E89A4F', coelho: '#F1EDEA' };
  for (const pet of Object.keys(PETS)) {
    const svg = avatarSVG(APPEARANCES[1], pet);
    assertWellFormedSVG(svg);
    assert.ok(svg.includes('viewBox="0 0 300 300" width="260" height="260"'));
    for (const [kind, color] of Object.entries(fur)) assert.equal(svg.includes(color), kind === pet, `${pet}/${kind}`);
  }
  assert.ok(avatarSVG({}, 'gato', 160).includes('width="160" height="160"'));
  // bichinho desconhecido não quebra
  assertWellFormedSVG(avatarSVG({}, 'dragao'));
});

test('toSVG: degradês em <defs> com ids únicos, userSpaceOnUse e números com até 2 casas', () => {
  const a = sceneSVG('praia', false, {}, '', 'x');
  const b = sceneSVG('jardim', false, {}, '', 'x');
  const ids = (svg) => [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids(a).length, 1);
  assert.ok(a.includes('gradientUnits="userSpaceOnUse"'));
  assert.ok(a.includes(`fill="url(#${ids(a)[0]})"`));
  assert.ok(a.indexOf('<defs>') < a.indexOf('<rect'));
  assert.ok(!ids(a).some((id) => ids(b).includes(id)), 'ids repetidos entre imagens diferentes');

  const ir = sceneIR('fundo_do_mar', true, {}, '', 'x');
  const withPrefix = toSVG(ir, { idPrefix: 'h12c3' });
  assert.ok(withPrefix.includes(
    '<linearGradient id="h12c3-1" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="500">',
  ));
  assert.ok(withPrefix.includes('fill="url(#h12c3-1)"'));
  assertWellFormedSVG(withPrefix);

  const fade = () => ({ type: 'linear', x1: 0, y1: 0, x2: 10, y2: 0, stops: [[0, '#000000'], [1, '#FFFFFF']] });
  const custom = {
    width: 10,
    height: 20,
    children: [
      { type: 'rect', x: 0.123456, y: -0.004, w: 5, h: 5, rx: 1.5, fill: fade() },
      { type: 'rect', x: 1, y: 1, w: 2, h: 2, fill: fade() },
      {
        type: 'group',
        transform: multiply(translate(1, 2), scale(1.23456)),
        children: [
          {
            type: 'path',
            d: 'M0.12345,1 L2,3.14159 A1,1 0 1 0 4,4 Z',
            stroke: '#112233',
            strokeWidth: 1.234,
            lineCap: 'round',
            lineJoin: 'bevel',
            opacity: 0.5,
          },
          { type: 'circle', cx: 1, cy: 1, r: 1, fill: '#ABCDEF', opacity: 1 },
          { type: 'ellipse', cx: 1, cy: 1, rx: 2, ry: 1, fill: null, stroke: '#ABCDEF' },
        ],
      },
    ],
  };
  const svg = toSVG(custom, { width: 100, height: 200, idPrefix: 'x' });
  assertWellFormedSVG(svg);
  assert.ok(svg.includes('viewBox="0 0 10 20" width="100" height="200"'));
  assert.equal([...svg.matchAll(/<linearGradient /g)].length, 1, 'degradês iguais viram um só');
  assert.ok(svg.includes('<rect x="0.12" y="0" width="5" height="5" rx="1.5" fill="url(#x-1)"/>'));
  assert.ok(svg.includes('<g transform="matrix(1.23 0 0 1.23 1 2)">'));
  assert.ok(svg.includes('<path d="M0.12,1 L2,3.14 A1,1 0 1 0 4,4 Z" fill="none" stroke="#112233" '
    + 'stroke-width="1.23" stroke-linecap="round" stroke-linejoin="bevel" opacity="0.5"/>'));
  assert.ok(svg.includes('<circle cx="1" cy="1" r="1" fill="#ABCDEF"/>'));
  assert.ok(svg.includes('<ellipse cx="1" cy="1" rx="2" ry="1" fill="none" stroke="#ABCDEF" stroke-width="1"/>'));
});

test('IR sem opacidade em grupo e nuvens com transparência única', () => {
  const ir = sceneIR('jardim', false, {}, '', 'x');
  const clouds = flatten(ir).filter(({ node }) => node.opacity === 0.92);
  assert.ok(clouds.length >= 2);
  // cada nuvem é um caminho só (4 ovais), para a transparência não marcar as emendas
  for (const { node } of clouds) assert.equal(node.d.match(/M/g).length, 4);
});
