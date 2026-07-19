// Canonical API response helpers for Phase 36 contract standardization.
// Use these in all new and updated routes.

export const ok = (res, data, message, meta) => {
  const body = { success: true, data };
  if (message) body.message = message;
  if (meta)    body.meta    = meta;
  return res.json(body);
};

export const paginated = (res, data, { page, limit, total }) =>
  res.json({
    success: true,
    data,
    pagination: {
      page:       Number(page),
      limit:      Number(limit),
      total:      Number(total),
      totalPages: Math.ceil(Number(total) / Number(limit)) || 0,
    },
  });

export const fail = (res, status, error, details) => {
  const body = { success: false, error };
  if (details) body.details = details;
  return res.status(status).json(body);
};

export const badRequest  = (res, error, details) => fail(res, 400, error, details);
export const notFound    = (res, error = 'Not found')  => fail(res, 404, error);
export const serverError = (res, err) =>
  fail(res, 500, err?.message || 'Internal server error');
