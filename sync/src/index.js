const cron   = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const state  = require('./state');
const web    = require('./web');
const actual = require('./actual');
const { runSync } = require('./sync');

let cronTask = null;

function startSchedule(expression) {
  if (cronTask) cronTask.stop();
  cronTask = cron.schedule(expression, () => {
    runSync().catch(err => logger.error(err.message));
  });
  logger.info(`Cron schedule: "${expression}"`);
}

async function main() {
  logger.info('brosco-actual-sync starting');

  web.start(3000);

  const cfg = config.load();
  startSchedule(cfg.syncCron);

  // Run once immediately on startup
  await runSync().catch(err => logger.error(err.message));

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    if (cronTask) cronTask.stop();
    await actual.shutdown();
    process.exit(0);
  });
}

// Prevent crashes from @actual-app/api internal worker errors
process.on('uncaughtException',    err => logger.error(`Uncaught: ${err.message}`));
process.on('unhandledRejection',   err => logger.error(`Unhandled: ${err}`));

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
