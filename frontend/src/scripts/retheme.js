/**
 * Pulse ERP — Mass Color Retheme Script
 * Replaces all old indigo/violet colors with the new #4B2DCE→#7B3FE4 gradient palette
 * Run: node src/scripts/retheme.js
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// ── Exact hex replacements (longest first to avoid partial matches) ──
const HEX_MAP = [
  // Near-black headings
  ['#312e81', '#150F3D'],
  ['#1e1b4b', '#150F3D'],
  ['#4c1d95', '#150F3D'],

  // Brand dark
  ['#5b21b6', '#4B2DCE'],
  ['#4338ca', '#4B2DCE'],

  // Brand core (was Tailwind violet-700 / indigo-600)
  ['#6d28d9', '#5B35D5'],
  ['#4f46e5', '#5B35D5'],

  // Brand mid (was Tailwind indigo-500 — the most common color: 427 uses)
  ['#6366f1', '#6B3FDB'],

  // Brand bright (was Tailwind violet-600)
  ['#7c3aed', '#7B3FE4'],
  ['#8b5cf6', '#7B3FE4'],

  // Brand tint-400
  ['#a78bfa', '#9B74F0'],

  // Brand tint-300 (scrollbars, disabled)
  ['#c4b5fd', '#BAA8F8'],

  // Brand tint-200 (hover bg, borders)
  ['#ddd6fe', '#D4CAFE'],

  // Brand tint-100 (card borders, light bg)
  ['#ede9fe', '#E8E1FC'],
  ['#eef2ff', '#E8E1FC'],
  ['#e0e7ff', '#E8E1FC'],
  ['#c7d2fe', '#D4CAFE'],

  // Brand tint-50 (page backgrounds)
  ['#f5f3ff', '#F2EFFE'],
  ['#faf8ff', '#F2EFFE'],
  ['#f3f0ff', '#F2EFFE'],
  ['#f0ebff', '#F2EFFE'],
  ['#fafafe', '#F2EFFE'],
];

// ── rgba replacements ──
const RGBA_MAP = [
  // rgba(99,102,241,  → indigo-500
  [/rgba\(\s*99\s*,\s*102\s*,\s*241\s*,/g, 'rgba(107,63,219,'],
  // rgba(99,60,241,   → old violet
  [/rgba\(\s*99\s*,\s*60\s*,\s*241\s*,/g,  'rgba(75,45,206,'],
  // rgba(109,40,217,  → violet-700
  [/rgba\(\s*109\s*,\s*40\s*,\s*217\s*,/g, 'rgba(75,45,206,'],
  // rgba(124,58,237,  → violet-600
  [/rgba\(\s*124\s*,\s*58\s*,\s*237\s*,/g, 'rgba(123,63,228,'],
  // rgba(79,70,229,   → indigo-600
  [/rgba\(\s*79\s*,\s*70\s*,\s*229\s*,/g,  'rgba(91,53,213,'],
  // rgba(99,102,241,  (with spaces already handled above but catch variants)
  [/rgba\(\s*76\s*,\s*29\s*,\s*149\s*,/g,  'rgba(21,15,61,'],
];

// ── gradient replacements ──
const GRADIENT_MAP = [
  // sidebar brand button gradient
  [
    /linear-gradient\(\s*135deg\s*,\s*#6d28d9[^,]*,\s*#4f46e5[^,)]*(?:,\s*#4338ca[^)]*)?(?:,\s*#[0-9a-f]+[^)]*)?\)/gi,
    'linear-gradient(135deg, #4B2DCE 0%, #7B3FE4 100%)'
  ],
  // save/submit button gradient
  [
    /linear-gradient\(\s*135deg\s*,\s*#6d28d9\s*,\s*#4f46e5\s*\)/gi,
    'linear-gradient(135deg, #4B2DCE, #7B3FE4)'
  ],
  // accordion header gradient
  [
    /linear-gradient\(\s*135deg\s*,\s*#1e1b4b\s*,\s*#4f46e5\s*\)/gi,
    'linear-gradient(135deg, #150F3D, #6B3FDB)'
  ],
];

// ── Walk all .css files ──
function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory() && name !== 'node_modules') walk(full, files);
    else if (extname(name) === '.css') files.push(full);
  }
  return files;
}

const cssFiles = walk(ROOT);
let totalFiles = 0, totalChanges = 0;

for (const file of cssFiles) {
  let src = readFileSync(file, 'utf8');
  let changed = src;

  // Apply gradient replacements first (most specific)
  for (const [from, to] of GRADIENT_MAP) {
    changed = changed.replace(from, to);
  }

  // Apply rgba replacements
  for (const [pattern, to] of RGBA_MAP) {
    changed = changed.replace(pattern, to);
  }

  // Apply hex replacements (case-insensitive)
  for (const [from, to] of HEX_MAP) {
    const re = new RegExp(from.replace('#', '#'), 'gi');
    changed = changed.replace(re, to);
  }

  if (changed !== src) {
    writeFileSync(file, changed, 'utf8');
    const count = (changed.match(/F2EFFE|E8E1FC|D4CAFE|BAA8F8|9B74F0|7B3FE4|6B3FDB|5B35D5|4B2DCE|150F3D/gi) || []).length;
    console.log(`✓ ${file.replace(ROOT, '').slice(1)} (${count} brand colors)`);
    totalFiles++;
    totalChanges += count;
  }
}

console.log(`\n✅ Retheming complete — ${totalFiles} files updated, ~${totalChanges} color instances replaced.`);
