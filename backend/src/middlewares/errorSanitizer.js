// errorSanitizer.js
//
// Many route handlers catch errors inline and return the raw DB/exception message
// to the client, e.g. `res.status(500).json({ error: err.message })`. In production
// that leaks Postgres internals (column/constraint/relation names, stack hints).
//
// Rather than rewrite ~1000 call sites, this middleware wraps res.json once per
// request and, in production only, replaces the body of any 5xx response that
// carries a raw `error` string with a generic message. Non-production keeps the
// real message so developers still get useful diagnostics.
//
// The full error is still logged server-side by the individual handlers and/or the
// global errorHandler, so nothing is lost operationally.

export const sanitizeErrorResponse = (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();

  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (
      res.statusCode >= 500 &&
      body && typeof body === 'object' && !Array.isArray(body) &&
      Object.prototype.hasOwnProperty.call(body, 'error')
    ) {
      return origJson({ error: 'Internal server error', requestId: req.id });
    }
    return origJson(body);
  };

  next();
};
