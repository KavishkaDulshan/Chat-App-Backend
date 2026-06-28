const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const SERVICE_NAME = process.env.SERVICE_NAME || 'chat-server';

function log(level, msg, meta = {}) {
  if (LEVELS[level] === undefined || LEVELS[level] > CURRENT_LEVEL) return;
  const entry = JSON.stringify({
    level,
    time: new Date().toISOString(),
    service: SERVICE_NAME,
    requestId: meta.requestId || '',
    msg,
    ...meta,
  });
  (level === 'error' ? process.stderr : process.stdout).write(entry + '\n');
}

module.exports = {
  error: (msg, meta) => log('error', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  debug: (msg, meta) => log('debug', msg, meta),
};
