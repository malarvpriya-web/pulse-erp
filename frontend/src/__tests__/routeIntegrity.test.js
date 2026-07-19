/**
 * Route integrity: every page key in MODULE_REGISTRY must be declared in ROUTES.
 * Keys are extracted from routes.jsx as source text to avoid executing JSX / lazy imports.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MODULE_REGISTRY } from '@/config/moduleRegistry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Parse ROUTES keys from routes.jsx without executing it. */
function getRouteKeys() {
  const src = readFileSync(resolve(__dirname, '../config/routes.jsx'), 'utf-8');
  // Every top-level ROUTES entry looks like:  KeyName:   { component: ...
  const keys = new Set();
  for (const m of src.matchAll(/^ {2}([A-Z][A-Za-z0-9]*):\s*\{/gm)) {
    keys.add(m[1]);
  }
  return keys;
}

/** Collect every `page` value referenced in a MODULE_REGISTRY node tree. */
function collectPageKeys(nodes) {
  const keys = new Set();
  for (const node of nodes) {
    if (node.page) keys.add(node.page);
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child.page) keys.add(child.page);
      }
    }
  }
  return keys;
}

describe('Route integrity', () => {
  const routeKeys = getRouteKeys();
  const registryPageKeys = collectPageKeys(MODULE_REGISTRY);

  it('ROUTES file exports a non-empty key set', () => {
    expect(routeKeys.size).toBeGreaterThan(0);
  });

  it('MODULE_REGISTRY references at least one page key', () => {
    expect(registryPageKeys.size).toBeGreaterThan(0);
  });

  it('every MODULE_REGISTRY page key exists in ROUTES', () => {
    const missing = [...registryPageKeys].filter((k) => !routeKeys.has(k));
    expect(
      missing,
      `Page keys in MODULE_REGISTRY but missing from ROUTES:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });
});
