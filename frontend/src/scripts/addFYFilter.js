#!/usr/bin/env node
// PATH: frontend/src/scripts/addFYFilter.js
/**
 * addFYFilter — Scans feature JSX pages and injects useFY() into files that
 * make API calls but don't yet use financial-year filtering.
 *
 * What it does:
 *  1. Scans .jsx files in the target feature folders
 *  2. Skips files that already import useFY
 *  3. Skips files with no api.get / api.post calls
 *  4. For each qualifying file:
 *     a. Adds `import { useFY } from '@/context/FYContext';` after the last existing import
 *     b. Adds `const { fyParams } = useFY();` as the first line inside the default export function
 *     c. Appends `&fyStart=${fyParams.fyStart}&fyEnd=${fyParams.fyEnd}` to api.get/post URL strings
 *  5. Writes modified files and prints a summary report
 *
 * Usage:
 *   node src/scripts/addFYFilter.js [--dry-run]
 *
 * --dry-run: preview changes without writing any files.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN   = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Config — which feature folders to scan
// ---------------------------------------------------------------------------
const FEATURE_ROOT = path.resolve(__dirname, '../features');
const TARGET_FOLDERS = [
  'finance', 'hr', 'sales', 'crm', 'procurement',
  'inventory', 'projects', 'timesheets', 'performance', 'leaves', 'attendance',
];

// ---------------------------------------------------------------------------
// Collect all .jsx files in pages/ sub-directories
// ---------------------------------------------------------------------------
function collectPageFiles() {
  const files = [];
  for (const folder of TARGET_FOLDERS) {
    const pagesDir = path.join(FEATURE_ROOT, folder, 'pages');
    if (!fs.existsSync(pagesDir)) continue;
    for (const file of fs.readdirSync(pagesDir)) {
      if (file.endsWith('.jsx')) {
        files.push(path.join(pagesDir, file));
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Check conditions
// ---------------------------------------------------------------------------
function hasApiCall(src)    { return /api\.(get|post|put|delete|patch)\s*\(/.test(src); }
function hasFYImport(src)   { return /useFY/.test(src); }
function hasDefaultExport(src) { return /export\s+default\s+function\s+\w+/.test(src); }

// ---------------------------------------------------------------------------
// Transformations
// ---------------------------------------------------------------------------
function addFYImport(src) {
  // Find the position after the last import statement
  const importRegex = /^import .+$/gm;
  let lastMatch = null;
  let m;
  while ((m = importRegex.exec(src)) !== null) lastMatch = m;

  if (!lastMatch) return src; // no imports found, skip
  const insertAt = lastMatch.index + lastMatch[0].length;
  return src.slice(0, insertAt) + "\nimport { useFY } from '@/context/FYContext';" + src.slice(insertAt);
}

function addFYHook(src) {
  // Insert after the opening line of the default export function body
  // Matches: export default function SomeName(...) {
  const funcRegex = /export\s+default\s+function\s+\w+[^{]*\{/;
  const match = funcRegex.exec(src);
  if (!match) return src;
  const insertAt = match.index + match[0].length;
  return src.slice(0, insertAt) + "\n  const { fyParams } = useFY();" + src.slice(insertAt);
}

function appendFYParams(src) {
  // Append fyStart/fyEnd query params to every api.get/post/put/patch/delete call.
  // Handles both template-literal URLs (backtick) and regular string-literal URLs.

  // Template literal: api.get(`/endpoint`) → api.get(`/endpoint?fyStart=...`)
  // We append before the closing backtick of the first argument
  let result = src;

  // Template literals: `...` first arg
  result = result.replace(
    /api\.(get|post|put|patch|delete)\s*\(\s*`([^`]+)`/g,
    (match, method, url) => {
      if (url.includes('fyStart') || url.includes('fyEnd')) return match;
      const sep = url.includes('?') ? '&' : '?';
      return `api.${method}(\`${url}${sep}fyStart=\${fyParams.fyStart}&fyEnd=\${fyParams.fyEnd}\``;
    }
  );

  // Regular string literals: '/endpoint' or "/endpoint"
  result = result.replace(
    /api\.(get|post|put|patch|delete)\s*\(\s*(['"])([^'"]+)\2/g,
    (match, method, quote, url) => {
      if (url.includes('fyStart') || url.includes('fyEnd')) return match;
      const sep = url.includes('?') ? '&' : '?';
      return `api.${method}(\`${url}${sep}fyStart=\${fyParams.fyStart}&fyEnd=\${fyParams.fyEnd}\``;
    }
  );

  return result;
}

// ---------------------------------------------------------------------------
// Process a single file
// ---------------------------------------------------------------------------
function processFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');

  if (hasFYImport(original)) return { file: filePath, status: 'skipped', reason: 'already has useFY' };
  if (!hasApiCall(original))  return { file: filePath, status: 'skipped', reason: 'no api calls found' };
  if (!hasDefaultExport(original)) return { file: filePath, status: 'skipped', reason: 'no default export function' };

  let modified = original;
  modified = addFYImport(modified);
  modified = addFYHook(modified);
  modified = appendFYParams(modified);

  if (modified === original) return { file: filePath, status: 'skipped', reason: 'no changes detected' };

  if (!DRY_RUN) {
    fs.writeFileSync(filePath, modified, 'utf8');
  }

  return { file: filePath, status: DRY_RUN ? 'dry-run' : 'modified' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log(`\n🗓  addFYFilter — ${DRY_RUN ? 'DRY RUN (no files written)' : 'LIVE RUN'}\n`);

  const files   = collectPageFiles();
  const results = files.map(processFile);

  const modified = results.filter(r => r.status === 'modified' || r.status === 'dry-run');
  const skipped  = results.filter(r => r.status === 'skipped');

  console.log(`📁 Scanned : ${files.length} files`);
  console.log(`✏️  Modified: ${modified.length} files`);
  console.log(`⏭️  Skipped : ${skipped.length} files\n`);

  if (modified.length) {
    console.log('--- Modified ---');
    modified.forEach(r => console.log(`  ✓ ${path.relative(FEATURE_ROOT, r.file)}`));
    console.log('');
  }

  if (skipped.length) {
    console.log('--- Skipped ---');
    skipped.forEach(r => console.log(`  - ${path.relative(FEATURE_ROOT, r.file)}  (${r.reason})`));
    console.log('');
  }

  console.log(DRY_RUN ? '✅ Dry run complete. No files were written.\n' : '✅ Done.\n');
}

main();
