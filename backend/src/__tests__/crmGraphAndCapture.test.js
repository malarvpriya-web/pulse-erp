/**
 * crmGraphAndCapture.test.js — cover for the three CRM capabilities added
 * 2026-09-04: account hierarchy, account/opportunity teams, and web-to-lead
 * capture.
 *
 * These run against the REAL database. Every fixture is tagged and removed in
 * afterAll, and the cases assert INVARIANTS rather than fixed counts so seeding
 * new rows does not turn them red.
 *
 * The cases that matter most are the ones where a wrong answer is silent or
 * destructive:
 *   - a hierarchy CYCLE. The recursive roll-up query does not terminate if one
 *     exists, so the guard is the only thing between a bad PATCH and a hung
 *     connection.
 *   - a team member belonging to BOTH an account and an opportunity, or to
 *     neither — the row is then unattributable and the constraint is the only
 *     place that can say so.
 *   - the web-to-lead honeypot and duplicate paths, which both answer 200. A
 *     regression there is invisible from the response; only the absence of a
 *     lead row proves it worked.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// setup.js sets a dummy DB_PASSWORD because most suites mock the pool; this one
// does not, so the real password is restored BEFORE config/db.js is imported.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');

const COMPANY = 1;
const TAG = 'ZZTEST_GRAPH';
const ids = { accounts: [], parties: [], employees: [], forms: [] };

// parties.party_code is varchar(20), so the fixture code has to be short — the
// readable TAG goes in `name`, which is not length-constrained.
let seq = 0;
const shortCode = () => `ZZG${Date.now() % 100000}${(seq += 1)}`;

async function makeAccount(name) {
  const { rows: [party] } = await pool.query(
    `INSERT INTO parties (party_code, party_type, name, company_id)
     VALUES ($1, 'Customer', $2, $3) RETURNING id`,
    [shortCode(), `${TAG} ${name}`, COMPANY]
  );
  ids.parties.push(party.id);
  const { rows: [acct] } = await pool.query(
    `INSERT INTO accounts (name, account_type, company_id, party_id)
     VALUES ($1, 'Customer', $2, $3) RETURNING id`,
    [`${TAG} ${name}`, COMPANY, party.id]
  );
  ids.accounts.push(acct.id);
  return acct.id;
}

let A, B, C, employeeId;

beforeAll(async () => {
  A = await makeAccount('Parent');
  B = await makeAccount('Child');
  C = await makeAccount('Grandchild');
  const { rows: [e] } = await pool.query(
    `SELECT id FROM employees WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
  );
  employeeId = e.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM web_lead_submissions WHERE form_id = ANY($1::int[])`, [ids.forms]).catch(() => {});
  await pool.query(`DELETE FROM web_lead_forms WHERE id = ANY($1::int[])`, [ids.forms]).catch(() => {});
  await pool.query(`DELETE FROM crm_team_members WHERE account_id = ANY($1::int[])`, [ids.accounts]).catch(() => {});
  await pool.query(`UPDATE accounts SET parent_account_id = NULL WHERE id = ANY($1::int[])`, [ids.accounts]).catch(() => {});
  await pool.query(`DELETE FROM accounts WHERE id = ANY($1::int[])`, [ids.accounts]).catch(() => {});
  await pool.query(`DELETE FROM parties WHERE id = ANY($1::uuid[])`, [ids.parties]).catch(() => {});
  await pool.end().catch(() => {});
});

/* ══════════════════════════════════════════════════════════════════════════
   Account hierarchy
   ══════════════════════════════════════════════════════════════════════════ */
describe('account hierarchy', () => {
  test('a parent can be set and read back', async () => {
    await pool.query(`UPDATE accounts SET parent_account_id = $1 WHERE id = $2`, [A, B]);
    const { rows: [row] } = await pool.query(`SELECT parent_account_id FROM accounts WHERE id = $1`, [B]);
    expect(row.parent_account_id).toBe(A);
  });

  test('an account cannot be its own parent', async () => {
    await expect(
      pool.query(`UPDATE accounts SET parent_account_id = $1 WHERE id = $1`, [A])
    ).rejects.toThrow(/own parent/i);
  });

  test('a cycle is refused, however long the loop', async () => {
    // A <- B <- C is legal; C <- A would close the loop.
    await pool.query(`UPDATE accounts SET parent_account_id = $1 WHERE id = $2`, [B, C]);
    await expect(
      pool.query(`UPDATE accounts SET parent_account_id = $1 WHERE id = $2`, [C, A])
    ).rejects.toThrow(/cycle|own ancestor/i);
  });

  test('the guard leaves the legal chain intact after refusing', async () => {
    // A refusal must not roll back the rows it was protecting.
    const { rows } = await pool.query(
      `SELECT id, parent_account_id FROM accounts WHERE id = ANY($1::int[]) ORDER BY id`,
      [[A, B, C]]
    );
    const by = Object.fromEntries(rows.map(r => [r.id, r.parent_account_id]));
    expect(by[A]).toBeNull();
    expect(by[B]).toBe(A);
    expect(by[C]).toBe(B);
  });

  test('the recursive roll-up walks the whole tree from any member', async () => {
    // Asking about the grandchild must still return the whole group: the
    // question "who is this customer really" is about the group, not the branch.
    const { rows } = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_account_id, 0 AS depth FROM accounts WHERE id = $1
         UNION ALL
         SELECT a.id, a.parent_account_id, up.depth + 1
           FROM accounts a JOIN up ON a.id = up.parent_account_id
       )
       SELECT id FROM up ORDER BY depth DESC LIMIT 1`,
      [C]
    );
    expect(rows[0].id).toBe(A);
  });

  test('detaching sets the account back to a root', async () => {
    await pool.query(`UPDATE accounts SET parent_account_id = NULL WHERE id = $1`, [C]);
    const { rows: [row] } = await pool.query(`SELECT parent_account_id FROM accounts WHERE id = $1`, [C]);
    expect(row.parent_account_id).toBeNull();
    await pool.query(`UPDATE accounts SET parent_account_id = $1 WHERE id = $2`, [B, C]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Teams
   ══════════════════════════════════════════════════════════════════════════ */
describe('crm_team_members', () => {
  test('a member is attached to exactly one parent', async () => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO crm_team_members (company_id, account_id, employee_id, team_role, access_level)
       VALUES ($1,$2,$3,'sales_lead','edit') RETURNING *`,
      [COMPANY, A, employeeId]
    );
    expect(row.account_id).toBe(A);
    expect(row.opportunity_id).toBeNull();
  });

  test('naming BOTH parents is refused', async () => {
    // A row on both an account and an opportunity cannot be attributed to either.
    const { rows: [opp] } = await pool.query(
      `SELECT id FROM opportunities WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
    );
    await expect(
      pool.query(
        `INSERT INTO crm_team_members (company_id, account_id, opportunity_id, employee_id)
         VALUES ($1,$2,$3,$4)`,
        [COMPANY, A, opp.id, employeeId]
      )
    ).rejects.toThrow(/one_parent|check constraint/i);
  });

  test('naming NEITHER parent is refused', async () => {
    await expect(
      pool.query(
        `INSERT INTO crm_team_members (company_id, employee_id) VALUES ($1,$2)`,
        [COMPANY, employeeId]
      )
    ).rejects.toThrow(/one_parent|check constraint/i);
  });

  test('the same person cannot be added to one record twice', async () => {
    await expect(
      pool.query(
        `INSERT INTO crm_team_members (company_id, account_id, employee_id)
         VALUES ($1,$2,$3)`,
        [COMPANY, A, employeeId]
      )
    ).rejects.toThrow(/duplicate key|uq_crm_team_member/i);
  });

  test('an unknown team_role is refused', async () => {
    await expect(
      pool.query(
        `INSERT INTO crm_team_members (company_id, account_id, employee_id, team_role)
         VALUES ($1,$2,$3,'chief_of_vibes')`,
        [COMPANY, B, employeeId]
      )
    ).rejects.toThrow(/role_check|check constraint/i);
  });

  test('deleting the account removes its team, not the employee', async () => {
    const tempAccount = await makeAccount('Temp');
    await pool.query(
      `INSERT INTO crm_team_members (company_id, account_id, employee_id) VALUES ($1,$2,$3)`,
      [COMPANY, tempAccount, employeeId]
    );
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [tempAccount]);
    const { rows } = await pool.query(`SELECT id FROM crm_team_members WHERE account_id = $1`, [tempAccount]);
    expect(rows).toHaveLength(0);
    const { rows: emp } = await pool.query(`SELECT id FROM employees WHERE id = $1`, [employeeId]);
    expect(emp).toHaveLength(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Web-to-lead
   ══════════════════════════════════════════════════════════════════════════ */
describe('web_lead_forms', () => {
  test('a form key is unique across the table', async () => {
    const { rows: [f] } = await pool.query(
      `INSERT INTO web_lead_forms (company_id, name, form_key) VALUES ($1,$2,$3) RETURNING id, form_key`,
      [COMPANY, `${TAG} Form A`, `${TAG}_key_a`]
    );
    ids.forms.push(f.id);
    await expect(
      pool.query(
        `INSERT INTO web_lead_forms (company_id, name, form_key) VALUES ($1,$2,$3)`,
        [COMPANY, `${TAG} Form B`, `${TAG}_key_a`]
      )
    ).rejects.toThrow(/duplicate key|form_key/i);
  });

  test('every submission outcome is recordable, including the refusals', async () => {
    // A rejected submission is the only evidence that a form is being abused or
    // that a real enquiry was lost, so the status vocabulary has to carry them.
    const formId = ids.forms[0];
    for (const status of ['accepted', 'duplicate', 'rejected', 'rate_limited', 'spam']) {
      await pool.query(
        `INSERT INTO web_lead_submissions (form_id, company_id, status, reason)
         VALUES ($1,$2,$3,$4)`,
        [formId, COMPANY, status, `${TAG} probe`]
      );
    }
    const { rows } = await pool.query(
      `SELECT status FROM web_lead_submissions WHERE form_id = $1 AND reason = $2`,
      [formId, `${TAG} probe`]
    );
    expect(rows).toHaveLength(5);
  });

  test('an unknown submission status is refused', async () => {
    await expect(
      pool.query(
        `INSERT INTO web_lead_submissions (form_id, company_id, status) VALUES ($1,$2,'maybe')`,
        [ids.forms[0], COMPANY]
      )
    ).rejects.toThrow(/status_check|check constraint/i);
  });

  test('deleting a form takes its submissions with it', async () => {
    const { rows: [f] } = await pool.query(
      `INSERT INTO web_lead_forms (company_id, name, form_key) VALUES ($1,$2,$3) RETURNING id`,
      [COMPANY, `${TAG} Form C`, `${TAG}_key_c`]
    );
    await pool.query(
      `INSERT INTO web_lead_submissions (form_id, company_id, status) VALUES ($1,$2,'accepted')`,
      [f.id, COMPANY]
    );
    await pool.query(`DELETE FROM web_lead_forms WHERE id = $1`, [f.id]);
    const { rows } = await pool.query(`SELECT id FROM web_lead_submissions WHERE form_id = $1`, [f.id]);
    expect(rows).toHaveLength(0);
  });

  test('a lead deleted later leaves its submission record behind', async () => {
    // ON DELETE SET NULL, not CASCADE: the submission is the evidence the
    // enquiry arrived, and it must outlive the lead row it created.
    const { rows: [lead] } = await pool.query(
      `INSERT INTO leads (company_id, company_name, status) VALUES ($1,$2,'New') RETURNING id`,
      [COMPANY, `${TAG} Ephemeral`]
    );
    const { rows: [sub] } = await pool.query(
      `INSERT INTO web_lead_submissions (form_id, company_id, lead_id, status)
       VALUES ($1,$2,$3,'accepted') RETURNING id`,
      [ids.forms[0], COMPANY, lead.id]
    );
    await pool.query(`DELETE FROM leads WHERE id = $1`, [lead.id]);
    const { rows } = await pool.query(`SELECT lead_id FROM web_lead_submissions WHERE id = $1`, [sub.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].lead_id).toBeNull();
  });
});
