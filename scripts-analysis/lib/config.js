/**
 * Manifest Analyzer — central configuration.
 *
 * Single source of truth for paths, tool locations and module detection.
 * READ-ONLY toolkit: nothing here may point at a write target outside analysis/.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..', '..');
export const PULSE = path.join(ROOT, 'Pulse');
export const FRONTEND = path.join(PULSE, 'frontend');
export const BACKEND = path.join(PULSE, 'backend');
export const FRONTEND_SRC = path.join(FRONTEND, 'src');
export const BACKEND_SRC = path.join(BACKEND, 'src');

export const ANALYSIS = path.join(ROOT, 'analysis');
export const DIRS = {
  root: ANALYSIS,
  graphs: path.join(ANALYSIS, 'graphs'),
  reports: path.join(ANALYSIS, 'reports'),
  documentation: path.join(ANALYSIS, 'documentation'),
  statistics: path.join(ANALYSIS, 'statistics'),
  summary: path.join(ANALYSIS, 'summary'),
  logs: path.join(ANALYSIS, 'logs'),
};

/** Tool entry points, invoked via `node <file>` so Windows .cmd shims never enter the picture. */
export const TOOLS = {
  madge: path.join(ROOT, 'node_modules', 'madge', 'bin', 'cli.js'),
  depcruise: path.join(FRONTEND, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs'),
  knip: path.join(FRONTEND, 'node_modules', 'knip', 'bin', 'knip.js'),
  eslint: path.join(FRONTEND, 'node_modules', 'eslint', 'bin', 'eslint.js'),
};

export const toolAvailable = (name) => Boolean(TOOLS[name]) && fs.existsSync(TOOLS[name]);

/** Directories we never walk when collecting source files. */
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.vite', '.cache',
  'analysis', 'test-results', 'playwright-report', 'uploads', 'backups', '.bytecoder',
]);

export const EXT = {
  js: ['.js', '.mjs', '.cjs'],
  jsx: ['.jsx'],
  ts: ['.ts', '.mts', '.cts'],
  tsx: ['.tsx'],
  css: ['.css', '.scss', '.sass', '.less'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif'],
};

/**
 * Human labels for auto-detected module slugs. A slug missing from this map is
 * still reported — it just gets a title-cased fallback name.
 */
export const MODULE_LABELS = {
  ai: 'AI',
  crm: 'CRM',
  hr: 'HR',
  'hr-analytics': 'HR Analytics',
  servicedesk: 'Service Desk',
  orgchart: 'Org Chart',
  qrshare: 'QR Share',
  _shared: 'Shared',
};

export const labelFor = (slug) =>
  MODULE_LABELS[slug] ??
  slug.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Auto-detect modules as the union of frontend features and backend modules. */
export function detectModules() {
  const listDirs = (base) => {
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
      .map((e) => e.name);
  };
  const fe = listDirs(path.join(FRONTEND_SRC, 'features'));
  const be = listDirs(path.join(BACKEND_SRC, 'modules'));
  const slugs = [...new Set([...fe, ...be])].sort();
  return slugs.map((slug) => ({
    slug,
    label: labelFor(slug),
    frontend: fe.includes(slug),
    backend: be.includes(slug),
  }));
}

export const REPORT_HEADER = (title) =>
  `${'='.repeat(78)}\n${title}\nManifest Analyzer — generated ${new Date().toISOString()}\nREAD-ONLY report. No application source was modified.\n${'='.repeat(78)}\n`;
