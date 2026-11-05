// frontend/src/features/_shared/scmKit.jsx
//
// Shared primitives for the supply-chain planning screens.
//
// These ten pages were built together to close the gap the 2026-09-15 SCA
// scorecard found: a large body of planning capability that ran, was mounted,
// and had no screen in Pulse that called it. Sharing the primitives keeps them
// looking like one workspace rather than ten, and keeps the "we could not
// measure this" language identical everywhere — which matters more than it
// sounds, because the single most common defect this audit found was a figure
// presented confidently with nothing behind it.

import { useCallback, useEffect, useState } from 'react';
import api from '@/services/api/client';

export const INK = '#374151', MUT = '#6b7280', LINE = '#ede9fe';
export const ACC = '#6B3FDB';
export const OK = '#15803d', WARN = '#b45309', BAD = '#b91c1c', CALM = '#1d4ed8';

export const card = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: 12, padding: 16 };
export const th = {
  textAlign: 'left', padding: '8px 10px', fontSize: 11, color: MUT, fontWeight: 700,
  textTransform: 'uppercase', borderBottom: `2px solid ${LINE}`, whiteSpace: 'nowrap',
};
export const td = {
  padding: '8px 10px', fontSize: 13, color: INK, borderBottom: '1px solid #f3f0ff', verticalAlign: 'top',
};
export const btnP = {
  background: ACC, color: '#fff', border: 'none', borderRadius: 8,
  padding: '8px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13,
};
export const btnS = {
  background: '#ede9fe', color: ACC, border: 'none', borderRadius: 8,
  padding: '6px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12,
};
export const input = {
  padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13,
};

export const n0 = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
export const fmt = (v, dp = 0) =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v))
    ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const inr = (v) =>
  v === null || v === undefined || Number.isNaN(Number(v))
    ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
export const pct = (v, dp = 1) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(dp)}%`;

/** KPI tile. `value` of null renders an em dash, never a zero. */
export function KPI({ label, value, tint = ACC, hint }) {
  return (
    <div style={{ ...card, flex: '1 1 150px', minWidth: 140 }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: tint, lineHeight: 1 }}>
        {value === null || value === undefined ? '—' : value}
      </div>
      <div style={{ fontSize: 12, color: MUT, marginTop: 6 }}>{label}</div>
      {hint ? <div style={{ fontSize: 11, color: MUT, marginTop: 3, opacity: 0.8 }}>{hint}</div> : null}
    </div>
  );
}

export function Pill({ tone = 'calm', children }) {
  const map = {
    ok:   { bg: '#dcfce7', fg: OK },
    warn: { bg: '#fef3c7', fg: WARN },
    bad:  { bg: '#fee2e2', fg: BAD },
    calm: { bg: '#e0e7ff', fg: CALM },
    mute: { bg: '#f3f4f6', fg: MUT },
  };
  const c = map[tone] || map.calm;
  return (
    <span style={{
      background: c.bg, color: c.fg, borderRadius: 999, padding: '2px 9px',
      fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', display: 'inline-block',
    }}>{children}</span>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)}
          style={{
            border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer',
            fontSize: 13, fontWeight: 700,
            background: value === t.key ? ACC : '#f5f3ff',
            color: value === t.key ? '#fff' : ACC,
          }}>{t.label}{t.count != null ? ` (${t.count})` : ''}</button>
      ))}
    </div>
  );
}

/**
 * The state every one of these screens can be in, said plainly.
 *
 * `empty` is deliberately distinct from `error`: a planning screen with nothing
 * on it usually means the mechanism has not been run yet, and telling the user
 * that — with the button that runs it — is the difference between a working
 * feature and one that looks broken.
 */
export function Panel({ loading, error, empty, emptyHint, children }) {
  if (loading) return <div style={{ ...card, color: MUT, fontSize: 13 }}>Loading…</div>;
  if (error) {
    return (
      <div style={{ ...card, borderColor: '#fecaca', color: BAD, fontSize: 13 }}>
        <strong>Could not load.</strong> {String(error)}
      </div>
    );
  }
  if (empty) {
    return (
      <div style={{ ...card, color: MUT, fontSize: 13 }}>
        <div style={{ fontWeight: 700, color: INK, marginBottom: 4 }}>Nothing to show yet</div>
        {emptyHint}
      </div>
    );
  }
  return children;
}

export function DataTable({ columns, rows, keyOf, empty = 'No rows', maxHeight = 520 }) {
  if (!rows?.length) return <div style={{ ...card, color: MUT, fontSize: 13 }}>{empty}</div>;
  return (
    <div style={{ ...card, padding: 0, overflow: 'auto', maxHeight }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
        <thead><tr>{columns.map(c => (
          <th key={c.key} style={{ ...th, textAlign: c.align || 'left' }}>{c.label}</th>
        ))}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={keyOf ? keyOf(r, i) : (r.id ?? i)}>
              {columns.map(c => (
                <td key={c.key} style={{ ...td, textAlign: c.align || 'left' }}>
                  {c.render ? c.render(r) : (r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** GET a URL into state, with loading/error, and a refetch handle. */
export function useFetch(url, { params, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!!enabled);
  const [error, setError] = useState(null);
  const key = JSON.stringify(params || {});

  const run = useCallback(async () => {
    if (!enabled) return;
    setLoading(true); setError(null);
    try {
      const res = await api.get(url, params ? { params } : undefined);
      setData(res.data);
    } catch (e) {
      // Axios cancellations are CanceledError here, not AbortError — treating
      // one as a failure is how a screen flashes an error on every re-filter.
      if (e?.name === 'CanceledError') return;
      setError(e?.response?.data?.error || e.message);
    } finally { setLoading(false); }
  }, [url, key, enabled]);            // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { run(); }, [run]);
  return { data, loading, error, refetch: run, setData };
}
