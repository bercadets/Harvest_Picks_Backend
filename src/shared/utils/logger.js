// Minimal JSON logger. Set LOG_LEVEL=debug|info|warn|error in .env (default: info).
// Never pass passwords, tokens or full request bodies as meta.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function serialize(meta) {
  if (!meta) return {};
  const out = { ...meta };
  if (out.err instanceof Error) {
    out.err = {
      name: out.err.name,
      message: out.err.message,
      code: out.err.code,
      stack: out.err.stack,
    };
  }
  return out;
}

function log(level, message, meta) {
  const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
  if (LEVELS[level] > threshold) return;

  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...serialize(meta),
  });

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  error: (message, meta) => log('error', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  info: (message, meta) => log('info', message, meta),
  debug: (message, meta) => log('debug', message, meta),
};