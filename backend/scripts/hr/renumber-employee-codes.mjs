/**
 * renumber-employee-codes.mjs — put every Employee ID into the company's own
 * convention, `EMP001`.
 *
 *   node scripts/hr/renumber-employee-codes.mjs            # dry run (default)
 *   node scripts/hr/renumber-employee-codes.mjs --apply    # writes, one transaction
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `backfill-employee-codes.mjs` assigned 35 codes in the DASHED form
 * `EMP-0013`…`EMP-0036`. That was wrong: the business convention is `EMP001`,
 * evidenced by `EMP001`…`EMP012` which predate all of this work. This reverts
 * that mistake and finishes the job in the right format.
 *
 * ── What it does and does not touch ─────────────────────────────────────────
 * ONLY rows whose code does not already match `^EMP[0-9]{3,}$`. A code already in
 * the convention is never rewritten — so `EMP001`…`EMP012` are untouched, which
 * is the whole point: those are the numbers on people's ID cards.
 *
 * Two distinct cases, reported separately because they carry different weight:
 *
 *   A. DE-HYPHENATE — the code's own number is free in the company, so it keeps
 *      its number and only loses the hyphen. `EMP-0013` → `EMP013`. These are the
 *      24 rows the bad backfill created; nobody has ever used these codes for
 *      anything, and the number is preserved exactly.
 *
 *   B. REASSIGN — the code's number is already taken by a DIFFERENT employee, so
 *      it cannot simply lose its hyphen. `EMP-0001` cannot become `EMP001`
 *      because employee id=1 has held `EMP001` since February. These rows get the
 *      next free numbers instead. This CHANGES an identifier, so every one is
 *      listed by name and reported in the summary — it is not done quietly.
 *
 * Ordering is by company, then by the code's existing number, then by employee
 * id, so the resulting sequence is stable and reproducible rather than dependent
 * on row order.
 */
import 'dotenv/config';
import pool from '../../src/config/db.js';
import {
  isValidEmployeeCode, codeSeq, formatEmployeeCode, FIXTURE_FLOOR,
} from '../../src/shared/employeeCode.js';

const APPLY = process.argv.includes('--apply');

const client = await pool.connect();
const summary = { dehyphenate: 0, reassign: 0, untouched: 0, companies: 0 };

try {
  await client.query('BEGIN');

  const { rows: all } = await client.query(
    `SELECT id, COALESCE(company_id, 0) AS co, company_id, office_id,
            TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name,
            company_email
       FROM employees
      ORDER BY COALESCE(company_id, 0), id`);

  const byCompany = new Map();
  for (const r of all) {
    if (!byCompany.has(r.co)) byCompany.set(r.co, []);
    byCompany.get(r.co).push(r);
  }

  const plan = [];

  for (const [co, rows] of byCompany) {
    const canonical = rows.filter(r => isValidEmployeeCode(r.office_id));
    const offenders = rows.filter(r => !isValidEmployeeCode(r.office_id));
    summary.untouched += canonical.length;
    if (!offenders.length) continue;
    summary.companies++;

    // Numbers already in use in this company, INCLUDING the ones we are about to
    // assign — so case A and case B cannot collide with each other either.
    // Fixture-range numbers are ignored: they are not part of anyone's series.
    const taken = new Set(
      canonical.map(r => codeSeq(r.office_id)).filter(n => n != null && n < FIXTURE_FLOOR));
    let highest = taken.size ? Math.max(...taken) : 0;

    const nextFree = () => {
      do { highest += 1; } while (taken.has(highest));
      taken.add(highest);
      return highest;
    };

    // Deterministic order: by the code's own number, then by employee id.
    offenders.sort((a, b) =>
      (codeSeq(a.office_id) ?? 0) - (codeSeq(b.office_id) ?? 0) || a.id - b.id);

    // Pass 1 — keep the number where it is free. Pass 2 — reassign the rest.
    // Two passes so a row that COULD keep its number never loses it to a row
    // that has to be reassigned anyway.
    const deferred = [];
    for (const r of offenders) {
      const n = codeSeq(r.office_id);
      if (n != null && n > 0 && n < FIXTURE_FLOOR && !taken.has(n)) {
        taken.add(n);
        if (n > highest) highest = n;
        plan.push({ ...r, kind: 'dehyphenate', to: formatEmployeeCode(n) });
      } else {
        deferred.push(r);
      }
    }
    for (const r of deferred) {
      plan.push({ ...r, kind: 'reassign', to: formatEmployeeCode(nextFree()) });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const deh = plan.filter(p => p.kind === 'dehyphenate');
  const rea = plan.filter(p => p.kind === 'reassign');
  summary.dehyphenate = deh.length;
  summary.reassign = rea.length;

  console.log(`\n== Renumber to the EMP001 convention ==`);
  console.log(`   already canonical, untouched : ${summary.untouched}`);
  console.log(`   to renumber                  : ${plan.length}  ` +
              `(${deh.length} keep their number, ${rea.length} reassigned)`);

  if (deh.length) {
    console.log(`\n-- A. Hyphen removed, NUMBER PRESERVED (${deh.length}) --`);
    for (const p of deh) {
      console.log(`   co=${String(p.co).padEnd(5)} id=${String(p.id).padEnd(5)} ` +
        `${String(p.office_id).padEnd(11)} -> ${String(p.to).padEnd(9)} ${p.name}`);
    }
  }

  if (rea.length) {
    console.log(`\n-- B. NUMBER CHANGED: the old number belongs to someone else (${rea.length}) --`);
    for (const p of rea) {
      const holderQ = await client.query(
        `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
           FROM employees
          WHERE office_id = $1 AND COALESCE(company_id,0) = $2`,
        [formatEmployeeCode(codeSeq(p.office_id) ?? 0), p.co]);
      const holder = holderQ.rows[0];
      console.log(`   co=${String(p.co).padEnd(5)} id=${String(p.id).padEnd(5)} ` +
        `${String(p.office_id).padEnd(11)} -> ${String(p.to).padEnd(9)} ${p.name}`);
      console.log(`         reason: ${formatEmployeeCode(codeSeq(p.office_id) ?? 0)} is held by ` +
        (holder ? `employee #${holder.id} (${holder.name})` : 'another row'));
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────
  if (plan.length) {
    for (const p of plan) {
      // `AND office_id = $2` makes each write a compare-and-set: if anything
      // changed the code since the plan was built, the row is skipped rather than
      // overwritten.
      const res = await client.query(
        `UPDATE employees SET office_id = $1, updated_at = NOW()
          WHERE id = $2 AND office_id = $3 RETURNING id`,
        [p.to, p.id, p.office_id]);
      if (!res.rowCount) console.log(`   ! id=${p.id} changed underneath the plan — skipped`);
    }
  }

  // ── Post-check, inside the same transaction ───────────────────────────────
  const { rows: bad } = await client.query(
    `SELECT office_id FROM employees WHERE office_id !~ '^EMP[0-9]{3,}$'`);
  const { rows: dupes } = await client.query(
    `SELECT COALESCE(company_id,0) co, LOWER(office_id) c, COUNT(*)::int n
       FROM employees GROUP BY 1,2 HAVING COUNT(*) > 1`);
  console.log(`\n-- After --`);
  console.log(`   non-canonical codes remaining : ${bad.length}${bad.length ? ' ' + JSON.stringify(bad.map(b => b.office_id)) : ''}`);
  console.log(`   duplicates                    : ${dupes.length}${dupes.length ? ' ' + JSON.stringify(dupes) : ''}`);

  if (bad.length || dupes.length) {
    throw new Error('post-check failed — refusing to commit');
  }

  if (APPLY) {
    await client.query('COMMIT');
    console.log(`\nCOMMITTED — ${plan.length} Employee ID(s) renumbered.`);
  } else {
    await client.query('ROLLBACK');
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to commit.`);
  }
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\nFAILED (rolled back):', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
