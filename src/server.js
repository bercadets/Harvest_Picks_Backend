require('dotenv').config();
const app = require('./app');
const { pool } = require('./config/database');
const { assertAuthConfig } = require('./shared/middleware/auth.middleware');
const logger = require('./shared/utils/logger');

async function start() {
  assertAuthConfig(); // fail fast if JWT_SECRET is missing or too short
  await pool.query('SELECT 1'); // fail fast on a wrong connection string or password

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    logger.info(`Harvest Picks API listening on port ${port}`);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref(); // do not hang forever
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
});

start().catch((err) => {
  logger.error('Failed to start the server', { err });
  process.exit(1);
});