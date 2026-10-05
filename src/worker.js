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

let heartbeat = null;

// Última volta do worker (para /saude e o painel).
export const workerHeartbeat = () => heartbeat;

// Uma volta do ciclo. Devolve true se produziu alguma história.
export async function tick() {
  heartbeat = nowIso();
  await services.runPeriodic('last_reconcile', 600, services.reconcilePendingOrders);
  await services.runPeriodic('last_housekeeping', 86400, () => {
    pruneOutbox();
    services.housekeeping();
  });
  services.expireAndRemind();
  services.scheduleDueStories();
  services.recoverAndRetry();
  const storyId = services.nextQueuedStory();
  if (storyId) await produceStory(storyId);
  services.notifyReadyStories();
  services.alertAdminFailures();
  await services.deliverPendingEmails();
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
  const stuck = store.filter('stories', (story) => story.status === 'generating');
  stuck.forEach((story) => { story.status = 'queued'; });
  if (stuck.length) store.save();
  console.log(`Worker iniciado (IA: ${config.llmProvider}, pagamento: ${config.paymentProvider}, e-mail: ${config.emailProvider})`);
  timer = setTimeout(loop, 2000);
  timer.unref?.();
}

export function stopWorker() {
  clearTimeout(timer);
}
