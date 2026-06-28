const crypto = require('crypto');

function correlationId(req, res, next) {
  if (!req.requestId) {
    req.requestId = req.headers['x-request-id']
      || req.headers['x-correlation-id']
      || crypto.randomUUID();
  }

  res.setHeader('X-Request-ID', req.requestId);

  const start = Date.now();
  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - start;
    req.durationMs = duration;
    res.setHeader('X-Response-Time-Ms', duration);
    originalEnd.apply(this, args);
  };

  next();
}

module.exports = correlationId;
