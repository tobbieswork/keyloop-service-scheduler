import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createMetrics } from './observability/metrics.js';
import { startTracing } from './observability/tracing.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const stopTracing = startTracing(config);
  const db = createDb(config.databaseUrl);
  const app = await buildApp({ config, db, metrics: createMetrics({ processMetrics: true }) });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    try {
      await app.close(); // stops accepting connections and lets in-flight requests finish
      await db.destroy();
      await stopTracing();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  // Logging is not available if startup failed before the app existed (for example bad config).
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
