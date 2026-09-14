/**
 * territoryAssignment.test.js — cover for territory-driven assignment,
 * added 2026-09-03.
 *
 * WHY THIS EXISTS
 * ---------------
 * The audit checked the brief's explicit requirement — "verify that territory
 * rules actually influence lead/account/opportunity assignment" — and found
 * `sales_territories` referenced in exactly five places, all inside
 * sales.routes.js: the CREATE TABLE, a SELECT for the grid, an INSERT, an UPDATE
 * and a DELETE. Nothing read the table when a record was assigned.
 * leadAssignment.service.js implemented rule, round-robin and load-balanced
 * assignment and never mentioned territories.
 *
 * The matcher is pure so these cases need no fixtures. The ones that matter most
 * are the two directions a matcher can be wrong in a way that looks fine:
 *   - a territory that constrains only ONE dimension must still match (otherwise
 *     the first rule anyone writes is inert)
 *   - a MORE SPECIFIC territory must beat a broader one deterministically, or
 *     the same lead lands in different territories on different days and
 *     commissions stop reconciling
 *
 * Runner: npx vitest run src/__tests__/territoryAssignment.test.js
 */
import { describe, test, expect } from 'vitest';

const { matchTerritory } = await import('../modules/crm/services/territoryAssignment.service.js');

const T = (over = {}) => ({
  id: 1, name: 'T', region: null,
  zones: [], cities: [], industries: [], states: [], priority: 100,
  ...over,
});

describe('matchTerritory', () => {
  test('a territory constraining only a zone matches on that zone alone', () => {
    // The opposite reading — "every dimension must be declared AND satisfied" —
    // would make a zone-only territory match nothing, which is the first rule a
    // sales-ops person writes.
    const t = T({ zones: ['South'] });
    expect(matchTerritory(t, { zone: 'South', location: 'Hyderabad' }).matched).toBe(true);
    expect(matchTerritory(t, { zone: 'North', location: 'Delhi' }).matched).toBe(false);
  });

  test('an undeclared dimension is "do not care", not "match nothing"', () => {
    const t = T({ zones: ['South'] });        // says nothing about industry
    expect(matchTerritory(t, { zone: 'South', industry: 'Anything At All' }).matched).toBe(true);
  });

  test('every declared dimension must be satisfied', () => {
    const t = T({ zones: ['South'], industries: ['Manufacturing'] });
    expect(matchTerritory(t, { zone: 'South', industry: 'Manufacturing' }).matched).toBe(true);
    expect(matchTerritory(t, { zone: 'South', industry: 'Retail' }).matched).toBe(false);
    expect(matchTerritory(t, { zone: 'North', industry: 'Manufacturing' }).matched).toBe(false);
  });

  test('a city rule outranks a zone rule on specificity', () => {
    // Whoever wrote the city rule meant it as the exception to the zone.
    const zoneT = T({ id: 1, zones: ['South'] });
    const cityT = T({ id: 2, cities: ['Chennai'] });
    const rec = { zone: 'South', location: 'Chennai' };
    const z = matchTerritory(zoneT, rec);
    const c = matchTerritory(cityT, rec);
    expect(z.matched && c.matched).toBe(true);
    expect(c.specificity).toBeGreaterThan(z.specificity);
  });

  test('matching is case- and whitespace-insensitive', () => {
    // The live data has 'Mumbai' next to 'mumbai '.
    const t = T({ cities: ['Chennai'] });
    expect(matchTerritory(t, { location: '  chennai ' }).matched).toBe(true);
    expect(matchTerritory(t, { location: 'CHENNAI' }).matched).toBe(true);
  });

  test('a record missing a dimension the territory declares does not match', () => {
    const t = T({ cities: ['Chennai'] });
    expect(matchTerritory(t, { zone: 'South' }).matched).toBe(false);
    expect(matchTerritory(t, { location: '' }).matched).toBe(false);
    expect(matchTerritory(t, {}).matched).toBe(false);
  });

  test('a territory constraining nothing is a catch-all at specificity 0', () => {
    // It matches, so a company can define a fallback territory — but it must
    // never outrank a real rule.
    const catchAll = matchTerritory(T(), { zone: 'South' });
    const real = matchTerritory(T({ zones: ['South'] }), { zone: 'South' });
    expect(catchAll.matched).toBe(true);
    expect(catchAll.specificity).toBe(0);
    expect(real.specificity).toBeGreaterThan(catchAll.specificity);
  });

  test('legacy free-text region still participates', () => {
    // Territories written before zones/cities existed only have `region`.
    const t = T({ region: 'South' });
    expect(matchTerritory(t, { zone: 'South' }).matched).toBe(true);
    expect(matchTerritory(t, { region: 'South' }).matched).toBe(true);
    expect(matchTerritory(t, { zone: 'North' }).matched).toBe(false);
  });

  test('city and state are read from the fields leads actually carry', () => {
    // leads has `location`, not `city`. Reading only `city` would make every
    // city territory inert against real lead rows.
    const t = T({ cities: ['Pune'] });
    expect(matchTerritory(t, { location: 'Pune' }).matched).toBe(true);
    expect(matchTerritory(t, { city: 'Pune' }).matched).toBe(true);
  });
});
