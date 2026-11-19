import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createRunModel, selectProvider } from './model.js';
import { startDispatcher } from './outbox.js';
import { createRuntime } from './runtime.js';
import { startScheduler } from './scheduler.js';
import { startServer } from './server.js';
import { startWorker } from './worker.js';

async function main() {
  const config = loadConfig();
  const provider = await selectProvider(config);
  createRunModel(config, provider);
  const db = openDatabase(config.dataDir);
  let worker;
  let stopScheduler;
  let stopDispatcher;
  let server;
  let stopping = false;

  async function stop() {
    if (stopping) return;
    stopping = true;
    stopScheduler?.();
    stopDispatcher?.();
    const closingServer = server ? new Promise(resolve => server.close(resolve)) : undefined;
    const results = await Promise.allSettled([worker?.stop(), closingServer]);
    db.close();
    for (const result of results) {
      if (result.status === 'rejected') console.error('Shutdown:', result.reason.message);
    }
  }

  try {
    worker = startWorker(db, config, createRuntime(config, provider));
    stopScheduler = startScheduler(db, config, worker.wake);
    stopDispatcher = startDispatcher(db, config);
    const http = await startServer(db, config, worker, () => ({
      worker: worker.status(), scheduler: 'online', dispatcher: 'online', provider,
    }));
    server = http.server;
    console.log(`Always On Agent: http://127.0.0.1:${config.port} (${provider})`);
    console.log(`Local script token (X-Local-Token): ${http.token}`);
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
