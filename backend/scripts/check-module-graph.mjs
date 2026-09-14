#!/usr/bin/env node
/**
 * check-module-graph.mjs
 *
 * Every relative import in this codebase must resolve to a file that exists AND
 * to an export that file actually provides.
 *
 * WHY
 * ---
 * The 2026-09-08 procurement commit was verified before it was made, with a
 * check that asked "does the imported FILE exist in this commit?". It passed.
 * The commit still would not boot:
 *
 *     grn.service.js:7
 *     import { nextRtvNumber } from '../../../shared/docNumber.js';
 *     SyntaxError: ... does not provide an export named 'nextRtvNumber'
 *
 * `docNumber.js` exists at HEAD. The EXPORT was added in a change that was not
 * part of the commit. A file-level check cannot see that, and three more gaps of
 * the same shape were behind it — missing exports in `statusSets.js` and
 * `auth.middleware.js`, then `bill.repository.js` (which had gained the `po_id`
 * the three-way match writes), then the SQL-reference checker's own fix.
 *
 * Each was found by checking the commit out and RUNNING it, one at a time. This
 * script is that discovery, made repeatable — and made available BEFORE the
 * commit rather than after it.
 *
 * TWO MODES
 * ---------
 *   node scripts/check-module-graph.mjs
 *       The working tree. Catches an import broken by an edit.
 *
 *   node scripts/check-module-graph.mjs --ref HEAD
 *       A committed tree, read straight out of git. Catches the defect this
 *       script exists for: a commit that is internally inconsistent because a
 *       file it depends on was left behind in the working tree. Run it before
 *       pushing a partial commit and it answers "does this stand alone?".
 *
 * FALSE POSITIVES ARE WORSE THAN MISSES
 * -------------------------------------
 * Same principle the SQL-reference checker states, and the same trap: this
 * codebase's doc comments are full of import syntax, because that is how a
 * module's usage gets documented. Comments are blanked before anything is
 * parsed — the first draft of this check reported three phantom findings, all of
 * them lines like `*   import { auditLogger } from './src/middlewares/...'`
 * inside a JSDoc block.
 *
 * A file whose exports cannot be parsed with confidence (a `export * from`
 * chain that leaves the tree, a destructured export, a re-export of a computed
 * name) is treated as OPAQUE: its named imports are not checked at all, rather
 * than guessed at.
 *
 * Usage:
 *   node backend/scripts/check-module-graph.mjs [--ref <git-ref>] [--json]
 *   CHECK_SRC_ROOT=/some/tree node backend/scripts/check-module-graph.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const refIdx = argv.indexOf('--ref');
const REF = refIdx >= 0 ? argv[refIdx + 1] : null;

const BACKEND = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(BACKEND, '..');

/**
 * What gets scanned, as repo-relative prefixes. Tests are included on purpose:
 * a test that imports a module which no longer exports what it names is exactly
 * as broken as production code, and fails later and more confusingly.
 */
const SCAN = ['backend/src/', 'backend/scripts/', 'backend/server.js'];
const SKIP = ['node_modules/', 'backend/node_modules/', '/uploads/', '/backups/'];
const CODE = /\.(js|mjs)$/;
/**
 * Resolution universe vs scan set — two different things.
 *
 * What gets CHECKED is SCAN. What an import may legitimately RESOLVE to is
 * wider: `src/config/knex.js` imported `../../knexfile.js`, which sits beside
 * backend/ rather than inside src/. Collecting only the scan set made that a
 * phantom "missing file" — the file would have been there, just not in the set.
 * (It genuinely was not, so the finding stood; but the next one might not.)
 */
const RESOLVABLE = /\.(js|mjs|json|cjs)$/;

// ── source access: working tree or a git ref ─────────────────────────────────

/** @returns {Map<string,string>} repo-relative path -> contents */
function readWorkingTree() {
  const root = process.env.CHECK_SRC_ROOT
    ? path.resolve(process.env.CHECK_SRC_ROOT)
    : REPO;
  const files = new Map();
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.some((s) => (`/${childRel}/`).includes(s) || childRel.startsWith(s))) continue;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) walk(childAbs, childRel);
      else if (RESOLVABLE.test(e.name)) {
        // .json is collected so an import of one resolves; only CODE is parsed.
        try { files.set(childRel, CODE.test(e.name) ? fs.readFileSync(childAbs, 'utf8') : ''); } catch { /* unreadable */ }
      }
    }
  };
  // CHECK_SRC_ROOT points at a bare copy of backend/, not the repo, so accept both.
  const looksLikeRepo = fs.existsSync(path.join(root, 'backend'));
  if (looksLikeRepo) walk(root, '');
  else { walk(root, 'backend'); }
  return files;
}

/**
 * The tree as git holds it at `ref` — never the working tree.
 *
 * `git cat-file --batch` streams every blob through ONE child process; the
 * obvious `git show ref:path` per file is ~2,300 processes and takes minutes.
 */
function readRef(ref) {
  const list = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\n').map((s) => s.trim()).filter(Boolean);

  // Everything under backend/ that an import could resolve to — not just the
  // scan set, for the reason RESOLVABLE documents.
  const wanted = list.filter((p) =>
    RESOLVABLE.test(p) &&
    p.startsWith('backend/') &&
    !SKIP.some((s) => (`/${p}/`).includes(s) || p.startsWith(s)));

  const files = new Map();
  if (!wanted.length) return files;

  const stdin = wanted.map((p) => `${ref}:${p}`).join('\n') + '\n';
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: REPO, input: stdin, maxBuffer: 512 * 1024 * 1024,
  });

  // Each record: "<sha> <type> <size>\n<size bytes>\n"
  let off = 0, i = 0;
  while (off < out.length && i < wanted.length) {
    const nl = out.indexOf(0x0a, off);
    if (nl < 0) break;
    const header = out.slice(off, nl).toString('utf8');
    if (header.endsWith('missing')) { off = nl + 1; i++; continue; }
    const size = Number(header.split(' ').pop());
    const start = nl + 1;
    files.set(wanted[i], out.slice(start, start + size).toString('utf8'));
    off = start + size + 1;
    i++;
  }
  return files;
}

// ── parsing ──────────────────────────────────────────────────────────────────

/**
 * Blank every comment, and record which offsets sit inside a string literal.
 *
 * Two false-positive sources, both real and both found by this checker
 * reporting nonsense about files whose imports were perfect:
 *
 *  1. COMMENTS. This codebase documents a module by writing its import line
 *     into a JSDoc block — `*   import { auditLogger } from './src/...'`. The
 *     first draft scanned three of those as code. Comments are blanked here,
 *     preserving line structure so reported line numbers stay true.
 *
 *  2. STRING LITERALS. A test that injects a broken import as a FIXTURE holds
 *     the text `import { x } from './nowhere.js'` in a JS string. Blanking the
 *     string's contents is not an option — a real import's specifier lives in
 *     one. So string extents are recorded instead, and a match is discarded
 *     when the `import` keyword itself falls inside one. The keyword is code;
 *     the specifier is a string; only the first decides.
 *
 * @returns {{code: string, inString: Uint8Array}}
 */
function blankComments(src) {
  let out = '';
  const inString = new Uint8Array(src.length);
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | squote | dquote | tick
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'squote'; }
      else if (c === '"') { state = 'dquote'; }
      else if (c === '`') { state = 'tick'; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i++; continue; }
      out += ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++; continue;
    }
    // inside a string: copy verbatim, honour escapes
    if (c === '\\') { inString[i] = 1; inString[i + 1] = 1; out += c + (d ?? ''); i += 2; continue; }
    if ((state === 'squote' && c === "'") || (state === 'dquote' && c === '"') || (state === 'tick' && c === '`')) {
      state = 'code';
    } else {
      inString[i] = 1;
    }
    out += c; i++;
  }
  return { code: out, inString };
}

const IMPORT_RE = new RegExp(
  // import <clause> from '<rel>'   |   export <clause> from '<rel>'
  String.raw`(?:^|[\s;}])(?:import|export)\s+([^'"();]*?)\s+from\s*['"](\.[^'"]+)['"]` +
  // bare side-effect import, and dynamic import()
  String.raw`|(?:^|[\s;}])import\s*['"](\.[^'"]+)['"]` +
  String.raw`|\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)`,
  'g');

/** Named bindings a clause asks for. `default`/`*` are reported as such. */
function bindingsOf(clause) {
  if (clause == null) return [];
  const names = [];
  const braced = clause.match(/\{([^}]*)\}/);
  if (braced) {
    for (let part of braced[1].split(',')) {
      part = part.trim();
      if (!part) continue;
      names.push(part.split(/\s+as\s+/)[0].trim());
    }
  }
  const outsideBraces = clause.replace(/\{[^}]*\}/g, '').trim();
  if (/\*\s*as\s+/.test(outsideBraces)) names.push('*');
  else {
    const dflt = outsideBraces.replace(/,+/g, ' ').trim();
    if (dflt && /^[A-Za-z_$][\w$]*$/.test(dflt)) names.push('default');
  }
  return names;
}

const EXPORT_DECL = /(?:^|\n)\s*export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /(?:^|\n)\s*export\s*\{([^}]*)\}(?!\s*from)/g;
const EXPORT_FROM = /(?:^|\n)\s*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const EXPORT_STAR = /(?:^|\n)\s*export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\s*['"]([^'"]+)['"]/g;
const EXPORT_DEFAULT = /(?:^|\n)\s*export\s+default\b/;
/** Shapes this parser will not guess at. */
const OPAQUE = /(?:^|\n)\s*export\s+(?:const|let|var)\s*[{[]/;

/**
 * The names a module provides, or null when it cannot be parsed with
 * confidence. Follows `export ... from` one level at a time, in-tree only.
 */
function exportsOf(relPath, files, seen = new Set()) {
  if (seen.has(relPath)) return new Set();      // cycle: contributes nothing
  seen.add(relPath);
  const src = files.get(relPath);
  if (src == null) return null;
  if (!CODE.test(relPath)) return null;
  const { code } = blankComments(src);
  if (OPAQUE.test(code)) return null;

  const names = new Set();
  let m;
  EXPORT_DECL.lastIndex = 0;
  while ((m = EXPORT_DECL.exec(code))) names.add(m[1]);
  EXPORT_LIST.lastIndex = 0;
  while ((m = EXPORT_LIST.exec(code))) {
    for (let part of m[1].split(',')) {
      part = part.trim();
      if (part) names.add(part.split(/\s+as\s+/).pop().trim());
    }
  }
  EXPORT_FROM.lastIndex = 0;
  while ((m = EXPORT_FROM.exec(code))) {
    for (let part of m[1].split(',')) {
      part = part.trim();
      if (part) names.add(part.split(/\s+as\s+/).pop().trim());
    }
  }
  if (EXPORT_DEFAULT.test(code)) names.add('default');

  EXPORT_STAR.lastIndex = 0;
  while ((m = EXPORT_STAR.exec(code))) {
    if (m[1]) { names.add(m[1]); continue; }            // export * as ns from
    const target = resolve(relPath, m[2], files);
    if (!target) return null;                            // leaves the tree: opaque
    const inherited = exportsOf(target, files, seen);
    if (inherited == null) return null;
    for (const n of inherited) if (n !== 'default') names.add(n);
  }
  return names;
}

/** Resolve a relative specifier to a repo-relative path present in `files`. */
function resolve(fromPath, spec, files) {
  const base = path.posix.dirname(fromPath.split(path.sep).join('/'));
  const joined = path.posix.normalize(path.posix.join(base, spec));
  for (const cand of [joined, `${joined}.js`, `${joined}.mjs`, `${joined}/index.js`]) {
    if (files.has(cand)) return cand;
  }
  return null;
}

// ── scan ─────────────────────────────────────────────────────────────────────

const files = REF ? readRef(REF) : readWorkingTree();
const scanned = [...files.keys()].filter((p) =>
  SCAN.some((s) => p.startsWith(s) || p === s));

const findings = [];
let importCount = 0;

for (const file of scanned) {
  const { code, inString } = blankComments(files.get(file));
  const lineOf = (idx) => code.slice(0, idx).split('\n').length;
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(code))) {
    const spec = m[2] ?? m[3] ?? m[4];
    if (!spec) continue;
    // The alternation may begin on the whitespace or brace before the keyword;
    // step past it, then reject the match if the KEYWORD itself sits inside a
    // string literal — that is a fixture or a doc example, not an import.
    const lead = m[0].match(/^[\s;}]*/)?.[0].length ?? 0;
    if (inString[m.index + lead]) continue;
    importCount++;
    const line = lineOf(m.index);
    const target = resolve(file, spec, files);
    if (!target) {
      // A .json or asset import is out of scope for an export check, but a
      // missing one is still a broken module graph.
      findings.push({ kind: 'file', file, line, spec, name: null });
      continue;
    }
    if (!CODE.test(target)) continue;
    const provided = exportsOf(target, files);
    if (provided == null) continue;                       // opaque: not guessed at
    for (const name of bindingsOf(m[1])) {
      if (name === '*') continue;
      if (!provided.has(name)) {
        findings.push({ kind: 'export', file, line, spec, name, target });
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────

const where = REF ? `git ref ${REF}` : (process.env.CHECK_SRC_ROOT || 'the working tree');

if (JSON_OUT) {
  console.log(JSON.stringify({ where, files: scanned.length, imports: importCount, findings }, null, 2));
} else {
  console.log('Module graph check');
  console.log('='.repeat(60));
  console.log(`Source: ${where}`);
  console.log(`Scanned ${scanned.length} file(s): ${importCount} relative import(s).\n`);
  for (const f of findings) {
    if (f.kind === 'file') {
      console.log(`MISSING FILE    ${f.file}:${f.line}  ${f.spec}`);
    } else {
      console.log(`MISSING EXPORT  ${f.file}:${f.line}  ${f.spec}  ->  ${f.name}`);
    }
  }
  if (findings.length) {
    console.log('\nFAIL — these imports do not resolve in this tree, so it will not boot.');
    if (REF) {
      console.log(`The tree at ${REF} is INCOMPLETE: something it imports was left behind in the`);
      console.log('working tree. Add the missing file(s) to the commit rather than assuming a');
      console.log('passing test suite covers it — the suite runs against the working tree, not this.');
    }
  } else {
    console.log('PASS — every relative import resolves to a real file and a real export.');
  }
}

process.exit(findings.length ? 1 : 0);
