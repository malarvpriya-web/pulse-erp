/**
 * routeShadowing.test.js — a literal route defined AFTER a matching /:param
 * sibling is unreachable.
 *
 * Express matches in definition order, so `router.get('/:module')` followed by
 * `router.get('/tally')` means /tally never runs — the param handler answers
 * first with `module = 'tally'`. Nothing errors and the endpoint still returns
 * 200, so this is invisible to any test that only asserts a status code.
 *
 * Real instance (2026-09-10): settings-status.routes.js defined /:module before
 * /tally for both GET and POST. GET /api/settings/tally returned `{}` from
 * company_settings instead of the tally_config row, and POST wrote the Tally
 * form into company_settings — so the integration, which reads tally_config,
 * never saw a saved configuration.
 *
 * This test parses every mounted route file and fails on any such pair.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.resolve(HERE, '..', 'modules');

/** Recursively collect *.routes.js under src/modules. */
function routeFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (/\.routes\.js$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every router.METHOD('path') in definition order. */
function declaredRoutes(src) {
  const routes = [];
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]*)[`'"]/g)) {
    routes.push({
      method: m[1].toUpperCase(),
      route: m[2],
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return routes;
}

/** Would `pattern` (an earlier route, possibly with :params) capture `literal`? */
function captures(pattern, literal) {
  const p = pattern.split('/').filter(Boolean);
  const l = literal.split('/').filter(Boolean);
  if (p.length !== l.length) return false;
  return p.every((seg, i) => seg.startsWith(':') || seg === l[i]);
}

describe('route ordering', () => {
  const files = routeFiles(MODULES_DIR);

  it('finds route files to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no literal route is shadowed by an earlier /:param sibling', () => {
    const shadowed = [];

    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const routes = declaredRoutes(src);

      for (let i = 0; i < routes.length; i++) {
        const later = routes[i];
        if (later.route.includes(':')) continue; // only literals get shadowed

        for (let j = 0; j < i; j++) {
          const earlier = routes[j];
          if (earlier.method !== later.method) continue;
          if (!earlier.route.includes(':')) continue;
          if (!captures(earlier.route, later.route)) continue;

          shadowed.push(
            `${path.relative(MODULES_DIR, file).replace(/\\/g, '/')}: ` +
            `${later.method} '${later.route}' (line ${later.line}) is unreachable — ` +
            `'${earlier.route}' (line ${earlier.line}) matches it first. ` +
            `Move the literal route above the param route.`
          );
        }
      }
    }

    expect(shadowed).toEqual([]);
  });
});
