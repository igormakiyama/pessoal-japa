// Linha de produção de uma história: texto (IA) -> ilustrações -> PDF.
import fs from 'node:fs';
import path from 'node:path';

import { config, paths } from './config.js';
import { THEMES } from './content.js';
import { sceneIR, toSVG } from './illustrate.js';
import { generateStory } from './llm.js';
import { renderStoryPDF } from './pdf.js';
import { db } from './store.js';
import { nowIso } from './util.js';

// Espera antes de tentar de novo quando a IA está no limite de uso ou instável.
export const RETRY_DELAY_MINUTES = 15;

// Formato esperado pelo módulo de IA
export function llmChild(child) {
  return {
    id: child.id,
    name: child.name,
    age: child.age,
    gender: child.gender,
    appearance: child.appearance,
    interests: child.interests,
    interests_extra: child.interestsExtra,
    themes: child.themes,
    pet_type: child.petType,
    pet_name: child.petName,
  };
}

export function removeStoryFiles(storyId) {
  fs.rmSync(paths.storyDir(storyId), { recursive: true, force: true });
}

export function readStory(storyId) {
  return JSON.parse(fs.readFileSync(path.join(paths.storyDir(storyId), 'story.json'), 'utf8'));
}

export function readScene(storyId, index) {
  return fs.readFileSync(path.join(paths.storyDir(storyId), `cena${index + 1}.svg`), 'utf8');
}

export function storyPdfPath(storyId) {
  return path.join(paths.storyDir(storyId), 'historia.pdf');
}

// Tema usado há mais tempo entre os escolhidos pelos pais.
export function pickTheme(child) {
  const options = child.themes.filter((t) => THEMES[t]);
  const pool = options.length ? options : Object.keys(THEMES);
  const lastUsed = {};
  for (const story of db().filter('stories', (s) => s.childId === child.id && s.status === 'ready')) {
    lastUsed[story.theme] = Math.max(lastUsed[story.theme] || 0, story.id);
  }
  return [...pool].sort((a, b) => (lastUsed[a] || 0) - (lastUsed[b] || 0) || pool.indexOf(a) - pool.indexOf(b))[0];
}

export function previousStories(childId, limit = 6) {
  return db()
    // Só a versão com apelidos vai para a IA; história sem ela (ex.: muito antiga) fica de fora.
    .filter('stories', (s) => s.childId === childId && s.status === 'ready' && s.promptTitle)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit)
    .map((s) => ({ title: s.promptTitle, summary: s.promptSummary || '' }));
}

function renderAssets(storyId, story, child) {
  const folder = paths.storyDir(storyId);
  fs.mkdirSync(folder, { recursive: true });
  const images = story.cenas.map((scene, i) =>
    sceneIR(scene.cenario, scene.noite, child.appearance, child.petType, `${storyId}-${i}`));
  images.forEach((ir, i) => {
    fs.writeFileSync(path.join(folder, `cena${i + 1}.svg`), toSVG(ir, { idPrefix: `h${storyId}c${i}` }));
  });
  let hasPdf = false;
  try {
    const pdf = renderStoryPDF({
      title: story.titulo,
      childName: child.name,
      siteName: config.siteName,
      lesson: story.licao,
      scenes: story.cenas.map((scene, i) => ({ text: scene.texto, image: images[i] })),
    });
    fs.writeFileSync(storyPdfPath(storyId), pdf);
    hasPdf = true;
  } catch (err) {
    console.error(`Falha ao gerar o PDF da história ${storyId}:`, err);
  }
  fs.writeFileSync(path.join(folder, 'story.json'), JSON.stringify(story));
  return { hasPdf };
}

// Produz uma história da fila. Devolve true se ficou pronta.
export async function produceStory(storyId) {
  const store = db();
  const row = store.get('stories', storyId);
  const child = store.get('children', row.childId);
  const theme = row.theme || pickTheme(child);
  const previousAttempts = row.attempts || 0; // row é o próprio registro do banco: guarde antes de alterar
  store.update('stories', storyId, {
    status: 'generating', theme, attempts: previousAttempts + 1, startedAt: nowIso(), error: null,
  });
  console.log(`Gerando história ${storyId} (tema: ${theme})`);
  try {
    const { promptTitle = null, promptSummary = null, ...story } = await generateStory(
      llmChild(child), theme, previousStories(child.id));
    // Os dados podem ter sido apagados (LGPD) enquanto a IA escrevia: aí não grava nada.
    if (!store.get('stories', storyId)) {
      console.log(`História ${storyId} descartada: os dados foram apagados durante a geração.`);
      return false;
    }
    const { hasPdf } = renderAssets(storyId, story, child);
    store.update('stories', storyId, {
      status: 'ready', title: story.titulo, summary: story.resumo, promptTitle, promptSummary, hasPdf,
      readyAt: nowIso(), error: null, retryAt: null, deferrals: 0, adminAlerted: false, deferralAlerted: false,
    });
    console.log(`História ${storyId} pronta: ${story.titulo}`);
    return true;
  } catch (err) {
    if (!store.get('stories', storyId)) return false;
    const error = String(err.message || err).slice(0, 1000);
    if (err.retryable) {
      // Limite da IA ou instabilidade passageira: volta para a fila sem gastar tentativa.
      console.warn(`História ${storyId} adiada (${error}); nova tentativa em ${RETRY_DELAY_MINUTES} min.`);
      store.update('stories', storyId, {
        status: 'queued', attempts: previousAttempts, error, deferrals: (row.deferrals || 0) + 1,
        retryAt: new Date(Date.now() + RETRY_DELAY_MINUTES * 60000).toISOString(),
      });
      return false;
    }
    console.error(`História ${storyId} falhou:`, error);
    store.update('stories', storyId, { status: 'failed', error });
    return false;
  }
}
