/**
 * workflowEngine.test.js — cover for the automation engine added 2026-09-03.
 *
 * WHAT THIS REPLACED
 * ------------------
 * `POST /api/workflows/:id/trigger` used to increment a counter, write a run log
 * with a HARDCODED status of 'completed', and return the rule's actions under
 * the key `simulated_actions`. It read no conditions and executed no actions, so
 * every rule accumulated a spotless run history for work that never happened —
 * including rules whose conditions did not hold and rules naming actions that do
 * not exist.
 *
 * The condition evaluator is pure by design, which is what lets the bulk of this
 * suite run with no database and no fixtures. The cases that cost the most if
 * they regress are the ones where a wrong answer is INVISIBLE:
 *   - an unknown operator silently evaluating to false (rule never fires, looks fine)
 *   - an unknown action silently counted as success (the old behaviour exactly)
 *   - a rule with no actions reported as 'completed'
 *   - `matched:false` collapsed into a failure status, so "why didn't my
 *     automation run" becomes unanswerable
 *
 * Runner: npx vitest run src/__tests__/workflowEngine.test.js
 */
import { describe, test, expect } from 'vitest';

const { readPath, evaluateConditions, renderTemplate, OPERATORS } =
  await import('../services/workflowEngine.js');

/* ══════════════════════════════════════════════════════════════════════════
   readPath
   ══════════════════════════════════════════════════════════════════════════ */
describe('readPath', () => {
  const ctx = { record: { stage: 'Won', amount: 500, owner: { name: 'Asha' } }, stage: 'Won' };

  test('reads nested paths', () => {
    expect(readPath(ctx, 'record.owner.name')).toBe('Asha');
    expect(readPath(ctx, 'record.amount')).toBe(500);
    expect(readPath(ctx, 'stage')).toBe('Won');
  });

  test('returns undefined for a missing hop rather than throwing', () => {
    // A condition on a field the record does not carry is normal, not an error.
    expect(readPath(ctx, 'record.nope.deeper')).toBeUndefined();
    expect(readPath(ctx, 'absent')).toBeUndefined();
    expect(readPath(ctx, '')).toBeUndefined();
    expect(readPath(null, 'a.b')).toBeUndefined();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Operators
   ══════════════════════════════════════════════════════════════════════════ */
describe('operators', () => {
  test('equals is case- and whitespace-insensitive', () => {
    // The live stage vocabulary holds both 'Won' and 'won'; a case-sensitive
    // comparison would make a rule fire for half the records that should match.
    expect(OPERATORS.equals('Won', 'won')).toBe(true);
    expect(OPERATORS.equals('  Won ', 'WON')).toBe(true);
    expect(OPERATORS.equals('Won', 'Lost')).toBe(false);
  });

  test('numeric operators refuse non-numbers instead of coercing to 0', () => {
    // Number('') is 0 in JavaScript, so a naive `>` would make an EMPTY amount
    // satisfy "amount greater than -1" and quietly fire a rule on a blank field.
    expect(OPERATORS.greater_than(500, 100)).toBe(true);
    expect(OPERATORS.greater_than('500', '100')).toBe(true);
    expect(OPERATORS.greater_than(null, 100)).toBe(false);
    expect(OPERATORS.greater_than('', -1)).toBe(false);
    expect(OPERATORS.greater_than('abc', 1)).toBe(false);
  });

  test('is_empty treats null, blank string and empty array alike', () => {
    expect(OPERATORS.is_empty(null)).toBe(true);
    expect(OPERATORS.is_empty('   ')).toBe(true);
    expect(OPERATORS.is_empty([])).toBe(true);
    expect(OPERATORS.is_empty(0)).toBe(false);       // 0 is a value, not an absence
    expect(OPERATORS.is_empty('x')).toBe(false);
  });

  test('in accepts an array or a comma string', () => {
    expect(OPERATORS.in('Won', ['won', 'lost'])).toBe(true);
    expect(OPERATORS.in('Won', 'won,lost')).toBe(true);
    expect(OPERATORS.in('Proposal', 'won,lost')).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   evaluateConditions
   ══════════════════════════════════════════════════════════════════════════ */
describe('evaluateConditions', () => {
  const ctx = { stage: 'Won', expected_value: 500000, next_step: '', record: { stage: 'Won' } };

  test('no conditions means unconditional, not never', () => {
    // A user who wrote no conditions meant "always". Returning false here would
    // make every such rule silently inert.
    expect(evaluateConditions([], ctx)).toBe(true);
    expect(evaluateConditions(null, ctx)).toBe(true);
    expect(evaluateConditions(undefined, ctx)).toBe(true);
  });

  test('flat AND list', () => {
    expect(evaluateConditions([
      { field: 'stage', operator: 'equals', value: 'Won', logic: 'AND' },
      { field: 'expected_value', operator: 'greater_than', value: '200000' },
    ], ctx)).toBe(true);

    expect(evaluateConditions([
      { field: 'stage', operator: 'equals', value: 'Won', logic: 'AND' },
      { field: 'expected_value', operator: 'greater_than', value: '900000' },
    ], ctx)).toBe(false);
  });

  test('flat OR list', () => {
    expect(evaluateConditions([
      { field: 'stage', operator: 'equals', value: 'Lost', logic: 'OR' },
      { field: 'expected_value', operator: 'greater_than', value: '200000' },
    ], ctx)).toBe(true);
  });

  test('nested all/any groups', () => {
    expect(evaluateConditions({
      all: [
        { field: 'stage', operator: 'equals', value: 'Won' },
        { any: [
          { field: 'expected_value', operator: 'greater_than', value: '900000' },
          { field: 'next_step', operator: 'is_empty' },
        ] },
      ],
    }, ctx)).toBe(true);
  });

  test("the seeder's single-object {op, field, value} form still evaluates", () => {
    // Five rules in this shape already exist in workflow_rules.
    expect(evaluateConditions({ op: 'eq', field: 'stage', value: 'Won' }, ctx)).toBe(true);
    expect(evaluateConditions({ op: 'eq', field: 'stage', value: 'Lost' }, ctx)).toBe(false);
  });

  test('operator aliases from the older builder vocabulary resolve', () => {
    expect(evaluateConditions([{ field: 'expected_value', operator: 'gte', value: 500000 }], ctx)).toBe(true);
    expect(evaluateConditions([{ field: 'stage', operator: '!=', value: 'Lost' }], ctx)).toBe(true);
  });

  test('an unknown operator THROWS rather than evaluating to false', () => {
    // This is the important one. A rule that silently never matches looks
    // healthy in the builder and produces no run log to investigate; the throw
    // is what lets the save-time check reject it and the dispatcher record it.
    expect(() => evaluateConditions([{ field: 'stage', operator: 'sorta_equals', value: 'Won' }], ctx))
      .toThrow(/Unknown workflow operator/);
  });

  test('a condition on an absent field is false, not an error', () => {
    expect(evaluateConditions([{ field: 'nonexistent', operator: 'equals', value: 'x' }], ctx)).toBe(false);
    expect(evaluateConditions([{ field: 'nonexistent', operator: 'is_empty' }], ctx)).toBe(true);
  });

  test('changed compares against the before-image', () => {
    const withPrev = { stage: 'Won', previous: { stage: 'negotiation' } };
    expect(evaluateConditions([{ field: 'stage', operator: 'changed' }], withPrev)).toBe(true);
    const unchanged = { stage: 'Won', previous: { stage: 'Won' } };
    expect(evaluateConditions([{ field: 'stage', operator: 'changed' }], unchanged)).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Template rendering
   ══════════════════════════════════════════════════════════════════════════ */
describe('renderTemplate', () => {
  const ctx = { opportunity_name: 'Cloud Migration', expected_value: 500000, record: { owner: { name: 'Asha' } } };

  test('interpolates flat and nested paths', () => {
    expect(renderTemplate('{{opportunity_name}} at {{expected_value}}', ctx))
      .toBe('Cloud Migration at 500000');
    expect(renderTemplate('Owner: {{record.owner.name}}', ctx)).toBe('Owner: Asha');
  });

  test('an unresolved placeholder becomes empty, never the literal braces', () => {
    // A notification reading "Deal {{deal_name}} closed" is worse than one
    // reading "Deal  closed" — it advertises a broken template to the customer.
    expect(renderTemplate('Deal {{missing}} closed', ctx)).toBe('Deal  closed');
  });

  test('tolerates whitespace inside the braces and leaves non-strings alone', () => {
    expect(renderTemplate('{{ opportunity_name }}', ctx)).toBe('Cloud Migration');
    expect(renderTemplate(42, ctx)).toBe(42);
    expect(renderTemplate(null, ctx)).toBe(null);
  });
});
