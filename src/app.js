require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { pool } = require('./config/database');
const logger = require('./shared/utils/logger');
const { notFoundHandler, errorHandler } = require('./shared/middleware/error.middleware');

const app = express();

app.use(helmet());

// CORS_ORIGIN="http://localhost:5173,https://your-site.com". If unset, any origin is
// allowed, which is fine for local development but set it before you deploy.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));

app.use(express.json({ limit: '100kb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    logger.error('Health check failed', { err });
    res.status(503).json({ status: 'unavailable' });
  }
});

// Mounts a cohort's router if the file exports one. A route file that is still
// empty is skipped with a warning, so you can run the server while you build
// the cohorts one at a time. A syntax error in a route file still crashes loudly.
function mount(basePath, modulePath) {
  const router = require(modulePath);
  if (typeof router === 'function') {
    app.use(basePath, router);
  } else {
    logger.warn(`Skipping ${basePath}: ${modulePath} does not export a router yet`);
  }
}

mount('/api/users', './users/users.routes');
mount('/api/ledger', './ledger/ledger.routes');
mount('/api/products', './products/products.routes');
mount('/api/notifications', './notifications/notifications.routes');
mount('/api/barter', './barter/barter.routes');
// The AI Research Brief route is mounted inside prediction.routes.js by its owner.
mount('/api/prediction', './prediction/prediction.routes');

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;