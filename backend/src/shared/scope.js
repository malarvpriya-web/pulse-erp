/**
 * Tenant scoping helper.
 *
 * Always resolve the caller's company through `req.scope` first. The auth
 * middleware builds req.scope from the JWT claim, falling back to the user's DB
 * row for tokens minted before company_id was a claim, and to a global
 * (company_id: null) scope for super admins with no company assignment.
 *
 * Reading `req.user.company_id` directly skips that DB fallback: an older token
 * without the claim yields null, and null means "no company filter" in the
 * standard `($1::int IS NULL OR company_id = $1)` predicate — i.e. the query
 * fails OPEN across every tenant. Route everything through companyOf().
 *
 * Returns an integer company id, or null for a genuinely global scope.
 */
export function companyOf(req) {
  const raw = req?.scope?.company_id ?? req?.user?.company_id;
  if (raw == null || raw === '') return null;
  const v = parseInt(String(raw), 10);
  return isNaN(v) ? null : v;
}
