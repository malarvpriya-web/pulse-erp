/**
 * The message to show for a failed submit. A 4xx carries a message the server
 * wrote for the user (e.g. NO_LINKED_EMPLOYEE, INVALID_RATING). A 5xx or a
 * network failure can carry raw internals, so it gets the fallback.
 */
export function submitErrorMessage(err, fallback) {
  const status = err?.status ?? err?.response?.status;
  if (!status || status >= 500) return fallback;
  if (status === 403) return err.message || fallback;
  const data = err.response?.data || {};
  if (typeof data.error === 'string' && data.error) return data.error;
  if (typeof data.message === 'string' && data.message) return data.message;
  return fallback;
}
