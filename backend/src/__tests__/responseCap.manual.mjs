// responseCap: must bound arrays, preserve shape, and never touch non-arrays.
process.env.RESPONSE_ROW_CAP = '5';
const { responseCap } = await import(
  'file:///c:/Users/malar/OneDrive/Desktop/Pulse_WORKING/Pulse/backend/src/middlewares/responseCap.js'
);

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  if (!ok) fails++;
};

function run(body) {
  const headers = {};
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    json: (b) => { res.sent = b; return res; },
  };
  responseCap({ path: '/api/x', originalUrl: '/api/x', user: {} }, res, () => {});
  res.json(body);
  return { sent: res.sent, headers };
}

const big = Array.from({ length: 12 }, (_, i) => i);
const r1 = run(big);
check('over cap → truncated to cap', r1.sent.length, 5);
check('  still an ARRAY (shape preserved)', Array.isArray(r1.sent), true);
check('  X-Truncated set', r1.headers['X-Truncated'], 'true');
check('  X-Total-Count is the true total', r1.headers['X-Total-Count'], 12);

const small = [1, 2, 3];
const r2 = run(small);
check('under cap → untouched', r2.sent, [1, 2, 3]);
check('  no X-Truncated header', r2.headers['X-Truncated'], undefined);

const obj = { tickets: big };
const r3 = run(obj);
check('non-array body passes through', r3.sent.tickets.length, 12);

const err = { error: 'boom' };
check('error object untouched', run(err).sent, { error: 'boom' });

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
