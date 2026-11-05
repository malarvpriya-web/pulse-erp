/**
 * integration.ticketCategories.test.js
 *
 * The ticket-category master, driven through the REAL finance router against
 * the REAL database.
 *
 * WHY THIS EXISTS
 *
 * §172 reported "ticket categories are read-only — manageable nowhere, not even
 * Master Settings" and left it. Looking properly found something worse than a
 * missing form:
 *
 *   `support_tickets` carries BOTH `category` (varchar) and `category_id`
 *   (FK → ticket_categories). `ticket.repository.js` bound `category_id` into
 *   the `category` COLUMN — an integer into a varchar — so a ticket raised from
 *   the finance Tickets page stored "3" where every reader expects "Network",
 *   and `category_id` was left NULL on every row ever created. `findById` joins
 *   on `category_id`, so its `category_name` was always null; `findAll` reads
 *   the text column, so the grid showed a bare number.
 *
 * That is why the first group here drives the real create path and reads BOTH
 * columns back. A test that only asserted "the POST returns 201" passed
 * throughout the entire life of the bug.
 *
 * The two vocabularies also disagreed completely — eight IT-helpdesk categories
 * nothing used, against eleven business-function ones in live data — so the
 * migration seeds the union. The last group checks no existing ticket was
 * orphaned by making `ticket_categories` the single master.
 *
 * Self-cleaning: everything is prefixed ZZTIX and removed by sweep(), which runs
 * on the way IN as well as OUT.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

const { default: pool }     = await import('../config/db.js');
const { default: extended } = await import('../modules/finance/routes/extended.routes.js');

const TAG = 'ZZTIX';

/**
 * An app whose caller holds these roles. The finance routes gate on permission,
 * not on role, so the USER ID matters as much as the role list.
 *
 * ⚠ permissionFor() checks the `permissions` table by user_id FIRST and only
 * falls back to role_permissions when that finds nothing. User 1 carries a
 * user-level row granting finance.can_add, so an "employee" built on user 1
 * gets 201 on every finance write and an RBAC assertion against it passes for
 * entirely the wrong reason. The negative case below therefore runs as a real
 * employee account with no user-level override, looked up in beforeAll rather
 * than hardcoded — a fixed id could quietly acquire one later and the test
 * would go green while the gate went open.
 */
function appAs(roles, userId, companyId = 1) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user  = { userId, roles, company_id: companyId };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/finance', extended);
  return app;
}

let admin, employee;
let slaId;

async function sweep() {
  await pool.query(`DELETE FROM support_tickets WHERE title LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM ticket_categories WHERE name LIKE $1`, [`${TAG}%`]);
}

beforeAll(async () => {
  await sweep();
  admin = appAs(['admin'], 1);

  const { rows: emp } = await pool.query(`
    SELECT u.id FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r       ON r.id = ur.role_id
     WHERE r.code = 'employee' AND u.is_active = true
       AND NOT EXISTS (SELECT 1 FROM permissions p WHERE p.user_id = u.id)
     ORDER BY u.id LIMIT 1`);
  if (!emp.length) throw new Error('no unprivileged employee account — the RBAC case below would pass for the wrong reason');
  employee = appAs(['employee'], emp[0].id);

  const { rows } = await pool.query(`SELECT id FROM sla_policies WHERE is_active = true ORDER BY id LIMIT 1`);
  slaId = rows[0]?.id ?? null;
});

afterAll(async () => { await sweep(); });

// ── The bug ──────────────────────────────────────────────────────────────────
describe('creating a ticket writes the category to the right column', () => {
  it('stores the NAME in category and the id in category_id', async () => {
    if (!slaId) return expect(slaId, 'no active SLA policy to create a ticket against').toBeTruthy();

    const { rows: [cat] } = await pool.query(
      `SELECT id, name FROM ticket_categories WHERE is_active = true ORDER BY id LIMIT 1`
    );

    const res = await request(admin).post('/finance/tickets').send({
      subject: `${TAG} binding probe`,
      description: 'drives the real create path',
      category_id: cat.id,
      priority: 'Medium',
      requester_name: 'Probe',
      requester_email: 'probe@manifest.in',
      sla_policy_id: slaId,
    });
    expect(res.status).toBe(201);

    // Read the COLUMNS, not the response: the response would have looked fine
    // for the whole life of the bug, because it echoes whatever was inserted.
    const { rows: [row] } = await pool.query(
      `SELECT category, category_id FROM support_tickets WHERE id = $1`, [res.body.id]
    );
    expect(row.category).toBe(cat.name);      // was the id, as text
    expect(row.category_id).toBe(cat.id);     // was NULL on every row ever made
  });

  it('reports the category name on the detail view, which joins on the FK', async () => {
    // findById() has always joined ticket_categories on category_id. With the
    // FK never set, category_name came back null every single time.
    const { rows: [t] } = await pool.query(
      `SELECT id FROM support_tickets WHERE title LIKE $1 ORDER BY id DESC LIMIT 1`, [`${TAG}%`]
    );
    const res = await request(admin).get(`/finance/tickets/${t.id}`);
    expect(res.status).toBe(200);
    expect(res.body.category_name).toBeTruthy();
  });

  it('refuses an unknown category as a 400, not a 500', async () => {
    if (!slaId) return;
    const res = await request(admin).post('/finance/tickets').send({
      subject: `${TAG} bad category`, description: 'x', category_id: 99999999,
      priority: 'Low', requester_name: 'P', requester_email: 'p@x.in', sla_policy_id: slaId,
    });
    // A blanket 500 reported the caller's bad input as a server fault — the
    // difference between "pick a real category" and "the helpdesk is down".
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/category/i);
  });
});

// ── The writes it never had ──────────────────────────────────────────────────
describe('ticket categories are manageable', () => {
  let created;

  it('creates one', async () => {
    const res = await request(admin).post('/finance/ticket-categories')
      .send({ name: `${TAG} Facilities`, description: 'Building and workspace issues' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: `${TAG} Facilities`, is_active: true });
    created = res.body;

    const list = await request(admin).get('/finance/ticket-categories');
    expect(list.body.map(c => c.name)).toContain(`${TAG} Facilities`);
  });

  it('refuses a duplicate regardless of case', async () => {
    const res = await request(admin).post('/finance/ticket-categories')
      .send({ name: `${TAG.toLowerCase()} facilities` });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already a ticket category/i);
  });

  it('refuses an empty name', async () => {
    const res = await request(admin).post('/finance/ticket-categories').send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('renames the category AND the tickets filed under it', async () => {
    // support_tickets stores the category as text as well as by id, so a rename
    // that touched only the master would leave every existing ticket showing
    // the old name and no longer matching its own category row.
    if (!slaId) return;
    const t = await request(admin).post('/finance/tickets').send({
      subject: `${TAG} rename probe`, description: 'x', category_id: created.id,
      priority: 'Low', requester_name: 'P', requester_email: 'p@x.in', sla_policy_id: slaId,
    });
    expect(t.status).toBe(201);

    const res = await request(admin).put(`/finance/ticket-categories/${created.id}`)
      .send({ name: `${TAG} Facilities & Admin` });
    expect(res.status).toBe(200);

    const { rows: [row] } = await pool.query(
      `SELECT category, category_id FROM support_tickets WHERE id = $1`, [t.body.id]
    );
    expect(row.category).toBe(`${TAG} Facilities & Admin`);
    expect(row.category_id).toBe(created.id);
  });

  it('retires it without rewriting the tickets that used it', async () => {
    const res = await request(admin).delete(`/finance/ticket-categories/${created.id}`);
    expect(res.status).toBe(200);

    const list = await request(admin).get('/finance/ticket-categories');
    expect(list.body.map(c => c.id)).not.toContain(created.id);

    // The ticket keeps its category text — retiring stops the value being
    // offered, it does not erase what was already filed under it.
    const { rows: [row] } = await pool.query(
      `SELECT category FROM support_tickets WHERE title = $1`, [`${TAG} rename probe`]
    );
    expect(row.category).toBe(`${TAG} Facilities & Admin`);
  });

  it('refuses a write from a role without finance permission', async () => {
    const res = await request(employee).post('/finance/ticket-categories').send({ name: `${TAG} Nope` });
    expect(res.status).toBe(403);
    // Paired positive: an admin can, so the 403 is the permission gate rather
    // than the route being broken for everyone.
    const ok = await request(admin).post('/finance/ticket-categories').send({ name: `${TAG} Allowed` });
    expect(ok.status).toBe(201);
  });
});

// ── The union the migration seeded ───────────────────────────────────────────
describe('making ticket_categories the single master orphaned nothing', () => {
  it('holds every category live tickets are already filed under', async () => {
    // Before the migration the master held Hardware/Software/Network/… while
    // the tickets held HR/Finance/IT/Attendance/… — two vocabularies for one
    // column. Every value in use must now be in the list, or the tickets
    // carrying it would show a category the picker cannot offer back.
    const { rows } = await pool.query(`
      SELECT DISTINCT BTRIM(s.category) AS category
        FROM support_tickets s
       WHERE s.category IS NOT NULL AND BTRIM(s.category) <> ''
         AND BTRIM(s.category) !~ '^[0-9]+$'
         AND s.title NOT LIKE $1
         AND NOT EXISTS (
           SELECT 1 FROM ticket_categories t
            WHERE LOWER(BTRIM(t.name)) = LOWER(BTRIM(s.category))
         )`, [`${TAG}%`]);
    expect(rows.map(r => r.category)).toEqual([]);
  });

  it('linked the tickets whose FK the create path never set', async () => {
    const { rows: [row] } = await pool.query(`
      SELECT COUNT(*)::int AS unlinked
        FROM support_tickets s
       WHERE s.category_id IS NULL
         AND s.category IS NOT NULL AND BTRIM(s.category) <> ''
         AND BTRIM(s.category) !~ '^[0-9]+$'
         AND s.title NOT LIKE $1
         AND EXISTS (
           SELECT 1 FROM ticket_categories t
            WHERE LOWER(BTRIM(t.name)) = LOWER(BTRIM(s.category))
         )`, [`${TAG}%`]);
    expect(row.unlinked).toBe(0);
  });

  it('keeps category names unique, which is what the backfill matches on', async () => {
    const { rows } = await pool.query(`
      SELECT LOWER(BTRIM(name)) AS n, COUNT(*)::int c
        FROM ticket_categories GROUP BY 1 HAVING COUNT(*) > 1`);
    expect(rows).toEqual([]);
  });
});
