// Worker: roda dentro do mesmo processo do site, em ciclos.
// Confere pagamentos perdidos, vence/avisa assinaturas, agenda e produz histórias,
// envia os e-mails e avisa o administrador se algo der errado.
import fs from 'node:fs';
import path from 'node:path';

import { config, paths } from './config.js';
import { produceStory } from './pipeline.js';
import * as services from './services.js';
import { db } from './store.js';
import { nowIso } from './util.js';

let running = false;
let timer = null;

// Apaga cópias de e-mails (modo sem Brevo) com mais de 30 dias, para a pasta não crescer sem limite.
export function pruneOutbox(maxAgeDays = 30) {
  const dir = paths.outbox();
  if (!fs.existsSync(dir)) return 0;
  const limit = Date.now() - maxAgeDays * 86400000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).mtimeMs < limit) {
      fs.rmSync(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

// Uma volta do ciclo. Devolve true se produziu alguma história.
export async function tick() {
  db().kvSet('worker_heartbeat', nowIso());
  await services.runPeriodic('last_reconcile', 600, services.reconcilePendingOrders);
  await services.runPeriodic('last_outbox_prune', 86400, () => pruneOutbox());
  await services.expireAndRemind();
  services.scheduleDueStories();
  services.recoverAndRetry();
  const storyId = services.nextQueuedStory();
  if (storyId) await produceStory(storyId);
  await services.notifyReadyStories();
  await services.alertAdminFailures();
  return storyId !== null;
}

async function loop() {
  if (running) return;
  running = true;
  let worked = false;
  try {
    worked = await tick();
  } catch (err) {
    console.error('Erro no ciclo do worker:', err);
  } finally {
    running = false;
  }
  timer = setTimeout(loop, worked ? 1000 : config.workerIntervalMs);
  timer.unref?.();
}

export function startWorker() {
  // Como só existe um processo, qualquer história "gerando" ao subir ficou presa num reinício: volta para a fila.
  const store = db();
  store.transaction(() => {
    for (const story of store.all('stories')) if (story.status === 'generating') story.status = 'queued';
  });
  console.log(`Worker iniciado (IA: ${config.llmProvider}, pagamento: ${config.paymentProvider}, e-mail: ${config.emailProvider})`);
  timer = setTimeout(loop, 2000);
  timer.unref?.();
}

export function stopWorker() {
  clearTimeout(timer);
}
