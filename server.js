// Ponto de entrada: `npm start`.
// Lê .env.site (se existir), abre o banco em DATA_DIR, sobe o site em HOSTNAME:PORT e liga o worker.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from './src/env.js';

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(root, '.env.site'));

const { config, loadConfig, paths } = await import('./src/config.js');
loadConfig();
const { openStore } = await import('./src/store.js');
const { createHandler } = await import('./src/web.js');
const { startWorker, stopWorker } = await import('./src/worker.js');

fs.mkdirSync(config.dataDir, { recursive: true });
openStore(paths.store());

const server = http.createServer(createHandler());
server.requestTimeout = 60000;
server.listen(config.port, config.hostname, () => {
  console.log(`${config.siteName} no ar em http://${config.hostname}:${config.port} (dados em ${config.dataDir})`);
});
startWorker();

function shutdown() {
  stopWorker();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
