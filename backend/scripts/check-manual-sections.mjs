#!/usr/bin/env node
/**
 * check-manual-sections.mjs
 *
 * Every `## §N` section in MODULE_FEATURE_CONNECTION_MANUAL.md must have a
 * number no other section uses, and the manual must report the next free one.
 *
 * WHY
 * ---
 * The manual is appended by several agent sessions at once. The standing rule
 * says to pick the next free number — but the file is NOT in numeric order, so
 * `grep "^## §" | tail` returns the last-WRITTEN section, not the highest
 * numbered one, and hands you a number that is already taken. On 2026-09-09
 * four sections collided that way in a single day (§156, §157, §158, and this
 * script's own author's first attempt).
 *
 * A duplicate is not cosmetic. §112 was assigned to both "Executive Dashboard
 * rebuilt" and "Analytics & AI final hardening", and nine cross-references
 * accumulated pointing at "§112" — some meaning the CSS fit contract, some
 * meaning the tenant-scoping fix. Untangling them afterwards meant reading each
 * reference in context. Catching the collision at write time costs nothing.
 *
 * USAGE
 *   node scripts/check-manual-sections.mjs          # verify, exit 1 on duplicates
 *   node scripts/check-manual-sections.mjs --next   # print the next free number
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANUAL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'MODULE_FEATURE_CONNECTION_MANUAL.md');
const wantNext = process.argv.includes('--next');

let text;
try {
  text = readFileSync(MANUAL, 'utf8');
} catch (e) {
  console.error(`Cannot read ${MANUAL}: ${e.message}`);
  process.exit(2);
}

// Top-level sections only. `## §146.2` is a sub-section of §146 and is allowed
// to sit beside it; it is keyed on its full number so it cannot mask a real
// collision either.
const sections = [];
text.split(/\r?\n/).forEach((line, i) => {
  const m = line.match(/^## §(\d+)(?:\.(\d+))? (?:—|-) ?(.*)$/);
  if (m) sections.push({
    key: m[2] ? `${m[1]}.${m[2]}` : m[1],
    major: Number(m[1]),
    line: i + 1,
    title: (m[3] || '').slice(0, 72),
  });
});

if (sections.length === 0) {
  console.error('No `## §N — Title` sections found. Has the heading format changed?');
  process.exit(2);
}

const byKey = new Map();
for (const s of sections) {
  if (!byKey.has(s.key)) byKey.set(s.key, []);
  byKey.get(s.key).push(s);
}

const nextFree = Math.max(...sections.map(s => s.major)) + 1;
if (wantNext) { console.log(nextFree); process.exit(0); }

const dupes = [...byKey.entries()].filter(([, v]) => v.length > 1)
  .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

console.log('Manual section check');
console.log('='.repeat(60));
console.log(`${sections.length} section(s); highest §${Math.max(...sections.map(s => s.major))}; next free is §${nextFree}.`);

if (dupes.length === 0) {
  console.log('\nPASS — every section number is used exactly once.');
  process.exit(0);
}

console.log(`\nFAIL — ${dupes.length} section number(s) used more than once:\n`);
for (const [key, group] of dupes) {
  console.log(`  §${key}`);
  for (const s of group) console.log(`    line ${String(s.line).padStart(6)}  ${s.title}`);
  console.log('');
}
console.log('Renumber YOUR section to the next free number above — never someone');
console.log("else's — then repoint any cross-reference that meant it.");
process.exit(1);
