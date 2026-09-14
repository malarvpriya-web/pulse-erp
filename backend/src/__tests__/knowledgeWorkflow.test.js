/**
 * knowledgeWorkflow.test.js
 *
 * The lifecycle rules, asserted where they are decided. These are the tests that
 * fail loudly if someone "simplifies" the state machine back into a free status
 * column — including tests that assert the OLD behaviour was wrong, so a revert
 * is noisy rather than silent.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  TRANSITIONS, TRANSITION_ROLES, canTransition, isSelfApproval,
  transition, editArticle, recordFeedback, effectiveness, readScope,
} from '../modules/servicedesk/services/knowledgeWorkflow.service.js';

/** A pool whose client returns queued results, so a transaction can be driven. */
function fakePool(results) {
  const queue = [...results];
  const query = vi.fn(async () => queue.shift() ?? { rows: [] });
  const client = { query, release: vi.fn() };
  return { pool: { connect: async () => client, query }, client, query };
}

const article = (over = {}) => ({
  id: 7, company_id: 1, version: 3, status: 'draft', visibility: 'internal',
  title: 'Resetting a device', summary: null, content: 'Hold the button.',
  category: 'Hardware', tags: ['device'], author_id: 42, submitted_by: null,
  ...over,
});

describe('transition table', () => {
  test('every target of every transition is itself a known state', () => {
    const states = Object.keys(TRANSITIONS);
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        expect(states, `${from} → ${to} names an unknown state`).toContain(to);
      }
    }
  });

  test('published is reachable ONLY from approved', () => {
    const sources = Object.entries(TRANSITIONS)
      .filter(([, targets]) => targets.includes('published'))
      .map(([from]) => from);
    expect(sources).toEqual(['approved']);
  });

  test('nothing is a dead end — every state can be left', () => {
    for (const [state, targets] of Object.entries(TRANSITIONS)) {
      expect(targets.length, `${state} is a dead end`).toBeGreaterThan(0);
    }
  });

  test('draft cannot jump straight to published', () => {
    expect(canTransition('draft', 'published')).toBe(false);
    expect(canTransition('draft', 'in_review')).toBe(true);
    expect(canTransition('approved', 'published')).toBe(true);
  });

  test('approve, reject and publish are role-gated; submitting is not', () => {
    expect(TRANSITION_ROLES.approved).toBeDefined();
    expect(TRANSITION_ROLES.published).toBeDefined();
    expect(TRANSITION_ROLES.in_review).toBeUndefined();
  });
});

describe('self-approval', () => {
  test('the submitter cannot approve their own article', () => {
    expect(isSelfApproval(article({ submitted_by: 42 }), 42)).toBe(true);
  });

  test('falls back to the AUTHOR when nobody submitted it', () => {
    // An article approved without ever passing through in_review has no
    // submitted_by; the author is still the person who must not wave it through.
    expect(isSelfApproval(article({ submitted_by: null, author_id: 42 }), 42)).toBe(true);
  });

  test('a different person may approve', () => {
    expect(isSelfApproval(article({ submitted_by: 42 }), 43)).toBe(false);
  });

  test('an unresolved actor is not treated as a match', () => {
    // employeeOf() returns null for a login with no employee record. Comparing
    // null to a null submitted_by must not read as "same person".
    expect(isSelfApproval(article({ submitted_by: null, author_id: null }), null)).toBe(false);
  });
});

describe('transition()', () => {
  const roles = ['super_admin'];

  test('refuses an illegal move and names what IS allowed', async () => {
    const { pool } = fakePool([{ rows: [] }, { rows: [article({ status: 'draft' })] }]);
    const out = await transition(pool, { id: 7, companyId: 1, to: 'published', employeeId: 9, roles });
    expect(out.error).toBe('illegal_transition');
    expect(out.from).toBe('draft');
    expect(out.allowed).toEqual(TRANSITIONS.draft);
  });

  test('refuses self-approval even for a super_admin', async () => {
    const { pool } = fakePool([{ rows: [] }, { rows: [article({ status: 'in_review', submitted_by: 9 })] }]);
    const out = await transition(pool, { id: 7, companyId: 1, to: 'approved', employeeId: 9, roles });
    expect(out.error).toBe('self_approval');
  });

  test('refuses approval by a role that may not approve', async () => {
    const { pool } = fakePool([{ rows: [] }, { rows: [article({ status: 'in_review', submitted_by: 42 })] }]);
    const out = await transition(pool, {
      id: 7, companyId: 1, to: 'approved', employeeId: 9, roles: ['employee', 'sales_exec'],
    });
    expect(out.error).toBe('role_required');
    expect(out.roles).toEqual(TRANSITION_ROLES.approved);
  });

  test('a missing article is not found rather than a crash', async () => {
    const { pool } = fakePool([{ rows: [] }, { rows: [] }]);
    const out = await transition(pool, { id: 999, companyId: 1, to: 'in_review', employeeId: 9, roles });
    expect(out.error).toBe('not_found');
  });

  test('a legal move snapshots the version and commits', async () => {
    const before = article({ status: 'in_review', submitted_by: 42 });
    const { pool, query } = fakePool([
      { rows: [] },                                        // BEGIN
      { rows: [before] },                                  // SELECT … FOR UPDATE
      { rows: [] },                                        // INSERT version
      { rows: [{ ...before, status: 'approved' }] },       // UPDATE
      { rows: [] },                                        // COMMIT
    ]);
    const out = await transition(pool, { id: 7, companyId: 1, to: 'approved', employeeId: 9, roles });

    expect(out.error).toBeUndefined();
    expect(out.article.status).toBe('approved');
    const sql = query.mock.calls.map(c => String(c[0]));
    expect(sql.some(s => s.includes('knowledge_article_versions'))).toBe(true);
    expect(sql.some(s => s.includes('FOR UPDATE'))).toBe(true);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  test('a failure rolls back rather than half-applying', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [article({ status: 'in_review', submitted_by: 42 })] })
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValue({ rows: [] });
    const pool = { connect: async () => client };

    await expect(transition(pool, { id: 7, companyId: 1, to: 'approved', employeeId: 9, roles }))
      .rejects.toThrow('deadlock');
    expect(client.query.mock.calls.map(c => String(c[0]))).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('editArticle()', () => {
  test('editing a PUBLISHED article returns it to draft and says so', async () => {
    const before = article({ status: 'published' });
    const { pool } = fakePool([
      { rows: [] }, { rows: [before] }, { rows: [] },
      { rows: [{ ...before, status: 'draft', version: 4 }] }, { rows: [] },
    ]);
    const out = await editArticle(pool, {
      id: 7, companyId: 1, employeeId: 9, patch: { content: 'New text.' },
    });
    expect(out.unpublishedOnEdit).toBe(true);
    expect(out.article.status).toBe('draft');
    expect(out.previousVersion).toBe(3);
  });

  test('editing a draft leaves it a draft', async () => {
    const before = article({ status: 'draft' });
    const { pool } = fakePool([
      { rows: [] }, { rows: [before] }, { rows: [] },
      { rows: [{ ...before, version: 4 }] }, { rows: [] },
    ]);
    const out = await editArticle(pool, { id: 7, companyId: 1, employeeId: 9, patch: { title: 'X' } });
    expect(out.unpublishedOnEdit).toBe(false);
  });

  test('an absent field is left alone rather than nulled', async () => {
    // A PATCH-shaped body must not erase the fields it does not mention — the
    // partial-update failure the validation engine hit in §154.
    const before = article({ status: 'draft', content: 'Hold the button.' });
    const { pool, query } = fakePool([
      { rows: [] }, { rows: [before] }, { rows: [] }, { rows: [before] }, { rows: [] },
    ]);
    await editArticle(pool, { id: 7, companyId: 1, employeeId: 9, patch: { title: 'Renamed' } });
    const update = query.mock.calls.find(c => String(c[0]).includes('UPDATE service_knowledge_base'));
    expect(update[1][0]).toBe('Renamed');
    expect(update[1][2]).toBe('Hold the button.'); // content survived
  });
});

describe('recordFeedback()', () => {
  test('rejects an event outside the known set', async () => {
    const { pool } = fakePool([]);
    expect((await recordFeedback(pool, { articleId: 7, companyId: 1, event: 'love' })).error)
      .toBe('bad_event');
  });

  test('writes BOTH an event row and the counter', async () => {
    const { pool, query } = fakePool([
      { rows: [{ id: 7, company_id: 1 }] },
      { rows: [] },
      { rows: [{ id: 7, views: 1, helpful_yes: 0, helpful_no: 0 }] },
    ]);
    await recordFeedback(pool, { articleId: 7, companyId: 1, event: 'view' });
    const sql = query.mock.calls.map(c => String(c[0]));
    expect(sql.some(s => s.includes('INSERT INTO knowledge_article_feedback'))).toBe(true);
    expect(sql.some(s => s.includes('SET views ='))).toBe(true);
  });

  test('an article in another company is not found', async () => {
    const { pool } = fakePool([{ rows: [] }]);
    expect((await recordFeedback(pool, { articleId: 7, companyId: 2, event: 'view' })).error)
      .toBe('not_found');
  });
});

describe('effectiveness()', () => {
  beforeEach(() => vi.clearAllMocks());

  test('an unrated article is UNMEASURED, never 0% helpful', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [
      { id: 1, helpful_pct: null, ratings_total: 0 },
      { id: 2, helpful_pct: '66.7', ratings_total: 3 },
    ] }) };
    const [unrated, rated] = await effectiveness(pool, { companyId: 1 });

    expect(unrated.helpful_pct).toBeNull();
    expect(unrated.measured).toBe(false);
    // The trap: 0 renders as "0% helpful", which reads as a bad article rather
    // than an unread one. Same mistake as supplier on_time_pct.
    expect(unrated.helpful_pct).not.toBe(0);

    expect(rated.measured).toBe(true);
    expect(rated.helpful_pct).toBe(66.7);
    // pg returns numeric as a string; leaving it would turn any arithmetic
    // upstream into string concatenation.
    expect(typeof rated.helpful_pct).toBe('number');
  });
});

describe('readScope()', () => {
  test('a non-staff reader sees only published PUBLIC articles', () => {
    const { clause } = readScope({ isStaff: false });
    expect(clause).toContain("status = 'published'");
    expect(clause).toContain("visibility = 'public'");
  });

  test('staff see drafts too — that is what stops duplicate articles', () => {
    expect(readScope({ isStaff: true }).clause).toBe('TRUE');
  });
});
