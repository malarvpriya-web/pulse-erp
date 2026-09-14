// frontend/src/features/analytics/pages/DashboardBuilder.jsx
//
// The dashboard builder — the frontend the backend never had.
//
// WHY THIS EXISTS
// ---------------
// The BI parity audit found a section headed DASHBOARD BUILDER exposing CRUD
// over `dashboard_widgets` with a `query_config` column and x/y/w/h geometry,
// and concluded: "Nothing ever executes query_config, no frontend file calls
// the endpoints, and react-grid-layout sits in package.json with zero imports.
// It is a stub, not a feature."
//
// It was worse than that: `dashboard_widgets` had never existed in any
// migration, and the routes were short-circuited to 501 before their handlers
// ran. This page is the last of the five parts (table, executor, routes, gates,
// UI) and it is the first import react-grid-layout has ever had.
//
// WHAT A USER CAN DO WITHOUT A DEVELOPER
// --------------------------------------
// Pick a metric from the server's catalog, pick how to slice it, pick a chart,
// drop it on a grid, drag it where they want it. That is the honest version of
// self-service authoring for a system of record: composition over REGISTERED
// metrics, not a free SQL canvas. The catalog the picker renders is already
// filtered by the server to what this user is allowed to read, so there is no
// metric on offer here that will come back "not permitted".
//
// ⚠ Cancelled requests: axios throws `CanceledError`, NEVER `AbortError`.
// Guarding on the wrong name makes every abort read as a load failure, which is
// a live defect elsewhere in this codebase and reproduces on a double-clicked
// Refresh — not just in dev.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
// ⚠ react-grid-layout v2 REMOVED the `WidthProvider` HOC that every tutorial
// still shows; v2.2.2 (what is installed) exports a `useContainerWidth` hook
// instead. Importing WidthProvider fails the build with MISSING_EXPORT rather
// than at runtime, which is the good outcome — but it is why this is a hook and
// a ref rather than the wrapped component the docs describe.
import GridLayout, { useContainerWidth } from 'react-grid-layout';
import {
  LayoutDashboard, Plus, Trash2, RefreshCw, X, Save, AlertTriangle, Lock,
} from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  Treemap, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import api from '@/services/api/client';
import { PageHero, PageShell, EmptyState, LoadingState } from '@/components/pulse-ui';
import { PULSE_SERIES } from '@/components/charts/PulseViz';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './DashboardBuilder.css';


// ── formatting ────────────────────────────────────────────────────────────────
// A metric declares its unit, so the tile never has to guess from the value
// shape — which is how a percentage came to render as currency elsewhere.
const fmtCurrency = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  if (Math.abs(v) >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};
const fmtCount = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtValue = (n, unit) => {
  if (n == null) return '—';
  if (unit === 'currency') return fmtCurrency(n);
  if (unit === 'percent') return `${Number(n).toFixed(1)}%`;
  if (unit === 'days') return `${Number(n).toFixed(1)} d`;
  return fmtCount(n);
};

/** axios aborts are CanceledError; ERR_CANCELED is the code it sets. */
const isAbort = (err) =>
  err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || err?.name === 'AbortError';

// ── one tile ──────────────────────────────────────────────────────────────────
function WidgetChart({ widget }) {
  const { rows = [], meta = {}, chart_type: chartType, ok, permitted, error } = widget;
  const unit = meta.unit;

  // A widget the viewer may not read, a retired metric and a genuine SQL failure
  // are all shown AS SUCH. Rendering an empty chart instead is how a broken
  // panel passes for "no data for this period".
  if (permitted === false) {
    return (
      <div className="dbw-state dbw-state--locked">
        <Lock size={18} />
        <span>{error || 'You do not have permission to read this metric.'}</span>
      </div>
    );
  }
  if (!ok) {
    return (
      <div className="dbw-state dbw-state--error">
        <AlertTriangle size={18} />
        <span>{error || 'This widget could not be computed.'}</span>
      </div>
    );
  }
  if (!rows.length) {
    return <div className="dbw-state">No data for this selection.</div>;
  }

  if (chartType === 'kpi') {
    return (
      <div className="dbw-kpi">
        <div className="dbw-kpi-value">{fmtValue(rows[0]?.value, unit)}</div>
        <div className="dbw-kpi-label">{rows[0]?.label}</div>
      </div>
    );
  }

  if (chartType === 'table') {
    return (
      <div className="dbw-table-wrap">
        <table className="dbw-table">
          <thead><tr><th>{meta.dimension}</th><th>{meta.label}</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}><td>{r.label}</td><td className="dbw-num">{fmtValue(r.value, unit)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const tip = (v) => fmtValue(v, unit);

  return (
    <ResponsiveContainer width="100%" height="100%">
      {chartType === 'line' ? (
        <LineChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmtValue(v, unit)} width={70} />
          <Tooltip formatter={tip} />
          <Line type="monotone" dataKey="value" name={meta.label} stroke={PULSE_SERIES[0]} strokeWidth={2} dot={false} />
        </LineChart>
      ) : chartType === 'area' ? (
        <AreaChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmtValue(v, unit)} width={70} />
          <Tooltip formatter={tip} />
          <Area type="monotone" dataKey="value" name={meta.label} stroke={PULSE_SERIES[0]} fill={PULSE_SERIES[0]} fillOpacity={0.18} />
        </AreaChart>
      ) : chartType === 'pie' || chartType === 'donut' ? (
        <PieChart>
          <Tooltip formatter={tip} />
          <Legend />
          <Pie
            data={rows} dataKey="value" nameKey="label"
            innerRadius={chartType === 'donut' ? '55%' : 0} outerRadius="80%"
          >
            {rows.map((_, i) => <Cell key={i} fill={PULSE_SERIES[i % PULSE_SERIES.length]} />)}
          </Pie>
        </PieChart>
      ) : chartType === 'treemap' ? (
        // Category share — the visual the audit named as missing and as exactly
        // what spend analysis needs.
        <Treemap
          data={rows.map((r, i) => ({ ...r, name: r.label, size: Math.abs(Number(r.value) || 0), fill: PULSE_SERIES[i % PULSE_SERIES.length] }))}
          dataKey="size" nameKey="name" stroke="#fff"
        >
          <Tooltip formatter={tip} />
        </Treemap>
      ) : chartType === 'scatter' ? (
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis dataKey="value" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtValue(v, unit)} width={70} />
          <Tooltip formatter={tip} />
          <Scatter data={rows} fill={PULSE_SERIES[0]} />
        </ScatterChart>
      ) : chartType === 'waterfall' ? (
        // A price-variance bridge. Recharts has no waterfall, so it is a stacked
        // bar with a transparent riser: `base` is invisible, `delta` is the step.
        <BarChart data={waterfallRows(rows)}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmtValue(v, unit)} width={70} />
          <Tooltip formatter={(v, n) => (n === 'base' ? null : tip(v))} />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="delta" stackId="w" radius={[4, 4, 0, 0]}>
            {waterfallRows(rows).map((r, i) => (
              <Cell key={i} fill={r.delta >= 0 ? PULSE_SERIES[0] : '#E0575B'} />
            ))}
          </Bar>
        </BarChart>
      ) : chartType === 'funnel' ? (
        // Horizontal bars ordered as given: a funnel stage must be CUMULATIVE,
        // and the metric that feeds it is responsible for making it so.
        <BarChart data={rows} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
          <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtValue(v, unit)} />
          <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={110} />
          <Tooltip formatter={tip} />
          <Bar dataKey="value" name={meta.label} radius={[0, 4, 4, 0]}>
            {rows.map((_, i) => <Cell key={i} fill={PULSE_SERIES[i % PULSE_SERIES.length]} />)}
          </Bar>
        </BarChart>
      ) : (
        <BarChart data={rows} layout={chartType === 'bar' ? 'vertical' : 'horizontal'}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
          {chartType === 'bar' ? (
            <>
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => fmtValue(v, unit)} />
              <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={110} />
            </>
          ) : (
            <>
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmtValue(v, unit)} width={70} />
            </>
          )}
          <Tooltip formatter={tip} />
          <Bar dataKey="value" name={meta.label} fill={PULSE_SERIES[0]} radius={4} />
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}

/** Turn a series into (invisible base, visible step) pairs for the bridge. */
function waterfallRows(rows) {
  let running = 0;
  return rows.map((r) => {
    const delta = Number(r.value) || 0;
    const base = delta >= 0 ? running : running + delta;
    running += delta;
    return { label: r.label, base, delta: Math.abs(delta) * Math.sign(delta) || delta };
  });
}

// ── the add-widget panel ──────────────────────────────────────────────────────
function WidgetComposer({ catalog, chartTypes, onCancel, onSave, saving }) {
  const [metricId, setMetricId] = useState(catalog[0]?.id ?? '');
  const metric = useMemo(() => catalog.find((m) => m.id === metricId), [catalog, metricId]);
  const [dimension, setDimension] = useState(metric?.default_dimension ?? 'none');
  const [chartType, setChartType] = useState('bar');
  const [title, setTitle] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewErr, setPreviewErr] = useState('');
  const abortRef = useRef(null);

  // Re-seed the slice when the metric changes: a dimension the previous metric
  // supported is very often one this metric refuses.
  useEffect(() => {
    if (!metric) return;
    setDimension(metric.default_dimension);
    if (!metric.accepts_date_range) { setFrom(''); setTo(''); }
  }, [metricId]); // eslint-disable-line react-hooks/exhaustive-deps

  const config = useMemo(() => ({
    metric: metricId,
    dimension,
    chart_type: chartType,
    ...(metric?.accepts_date_range && from ? { from } : {}),
    ...(metric?.accepts_date_range && to ? { to } : {}),
  }), [metricId, dimension, chartType, from, to, metric]);

  // Live preview. The server validates and executes; nothing is composed here.
  useEffect(() => {
    if (!metricId) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let alive = true;
    (async () => {
      try {
        const { data } = await api.post('/intelligence/metrics/preview',
          { query_config: config }, { signal: ctrl.signal });
        if (!alive) return;
        setPreview(data);
        setPreviewErr('');
      } catch (err) {
        if (isAbort(err) || !alive) return;
        setPreview(null);
        setPreviewErr(err?.response?.data?.error || 'Preview failed.');
      }
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [config, metricId]);

  if (!catalog.length) {
    return (
      <div className="dbw-composer">
        <EmptyState
          title="No metrics available to you"
          message="The metric catalog is filtered to what your roles allow you to read. Ask an administrator for access to a module to chart it."
        />
        <button className="dbw-btn" onClick={onCancel}>Close</button>
      </div>
    );
  }

  return (
    <div className="dbw-composer">
      <div className="dbw-composer-head">
        <h3>Add a widget</h3>
        <button className="dbw-icon-btn" onClick={onCancel} aria-label="Close"><X size={16} /></button>
      </div>

      <div className="dbw-composer-body">
        <div className="dbw-fields">
          <label>
            <span>Metric</span>
            <select value={metricId} onChange={(e) => setMetricId(e.target.value)}>
              {Object.entries(
                catalog.reduce((acc, m) => {
                  (acc[m.category] ||= []).push(m); return acc;
                }, {})
              ).map(([cat, items]) => (
                <optgroup key={cat} label={cat}>
                  {items.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>

          {metric?.desc && <p className="dbw-metric-desc">{metric.desc}</p>}

          <label>
            <span>Slice by</span>
            <select value={dimension} onChange={(e) => setDimension(e.target.value)}>
              {(metric?.dimensions ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Chart</span>
            <select value={chartType} onChange={(e) => setChartType(e.target.value)}>
              {chartTypes.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>

          {/* A snapshot metric refuses a date range rather than ignoring one,
              so the controls are hidden rather than shown-and-dropped. */}
          {metric?.accepts_date_range ? (
            <div className="dbw-dates">
              <label><span>From</span>
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label><span>To</span>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            </div>
          ) : (
            <p className="dbw-note">This metric is a snapshot of the present and takes no date range.</p>
          )}

          <label>
            <span>Title</span>
            <input
              type="text" value={title} placeholder={metric?.label ?? ''}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        </div>

        <div className="dbw-preview">
          <div className="dbw-preview-head">Preview</div>
          <div className="dbw-preview-body">
            {previewErr
              ? <div className="dbw-state dbw-state--error"><AlertTriangle size={18} /><span>{previewErr}</span></div>
              : preview
                ? <WidgetChart widget={{ ...preview, chart_type: chartType }} />
                : <LoadingState />}
          </div>
        </div>
      </div>

      <div className="dbw-composer-foot">
        <button className="dbw-btn" onClick={onCancel}>Cancel</button>
        <button
          className="dbw-btn dbw-btn--primary"
          disabled={saving || !!previewErr || !preview?.ok}
          onClick={() => onSave({ title: title || metric?.label, query_config: config })}
        >
          <Save size={15} /> {saving ? 'Adding…' : 'Add to dashboard'}
        </button>
      </div>
    </div>
  );
}

// ── the page ──────────────────────────────────────────────────────────────────
export default function DashboardBuilder() {
  const [boards, setBoards] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [board, setBoard] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [chartTypes, setChartTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [composing, setComposing] = useState(false);
  const [saving, setSaving] = useState(false);

  // v2's replacement for the WidthProvider HOC: it measures the element the ref
  // is attached to, so the grid still reflows on resize without a wrapper.
  const { width: gridWidth, containerRef } = useContainerWidth();

  const loadCatalog = useCallback(async () => {
    try {
      const { data } = await api.get('/intelligence/metrics');
      setCatalog(data.metrics || []);
      setChartTypes(data.chart_types || []);
    } catch (e) {
      if (!isAbort(e)) setErr(e?.response?.data?.error || 'Could not load the metric catalog.');
    }
  }, []);

  const loadBoards = useCallback(async () => {
    const { data } = await api.get('/intelligence/dashboards');
    setBoards(data || []);
    return data || [];
  }, []);

  const loadBoard = useCallback(async (id) => {
    if (!id) { setBoard(null); return; }
    const { data } = await api.get(`/intelligence/dashboards/${id}`);
    setBoard(data);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        await loadCatalog();
        const list = await loadBoards();
        if (!alive) return;
        const first = list[0]?.id ?? null;
        setActiveId(first);
        if (first) await loadBoard(first);
      } catch (e) {
        if (!isAbort(e) && alive) setErr(e?.response?.data?.error || 'Could not load dashboards.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [loadCatalog, loadBoards, loadBoard]);

  const createBoard = async () => {
    const name = window.prompt('Name this dashboard');
    if (!name?.trim()) return;
    try {
      const { data } = await api.post('/intelligence/dashboards', { name: name.trim() });
      await loadBoards();
      setActiveId(data.id);
      await loadBoard(data.id);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Could not create the dashboard.');
    }
  };

  const addWidget = async (payload) => {
    if (!activeId) return;
    setSaving(true);
    try {
      await api.post(`/intelligence/dashboards/${activeId}/widgets`, payload);
      await loadBoard(activeId);
      setComposing(false);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Could not add the widget.');
    } finally {
      setSaving(false);
    }
  };

  const removeWidget = async (id) => {
    try {
      await api.delete(`/intelligence/widgets/${id}`);
      await loadBoard(activeId);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Could not remove the widget.');
    }
  };

  // Persist geometry after a drag or resize. Sends ONLY the layout — the config
  // is untouched, so moving a tile can never invalidate it.
  const persistLayout = async (layout) => {
    await Promise.allSettled(layout.map((l) =>
      api.put(`/intelligence/widgets/${l.i}`, {
        position_x: l.x, position_y: l.y, width: l.w, height: l.h,
      })
    ));
  };

  const layout = useMemo(() => (board?.widgets ?? []).map((w) => ({
    i: String(w.id), x: w.layout.x, y: w.layout.y, w: w.layout.w, h: w.layout.h,
    minW: 2, minH: 2,
  })), [board]);

  if (loading) return <LoadingState />;

  return (
    <PageShell>
      <PageHero
        icon={LayoutDashboard}
        eyebrow="Analytics"
        title="Dashboard Builder"
        subtitle="Compose a board from registered metrics — pick a measure, a slice and a chart. No SQL, and nothing you could not already read."
        tone="violet"
        actions={
          <>
            <button className="dbw-btn" onClick={() => loadBoard(activeId)} disabled={!activeId}>
              <RefreshCw size={15} /> Refresh
            </button>
            <button className="dbw-btn dbw-btn--primary" onClick={createBoard}>
              <Plus size={15} /> New dashboard
            </button>
          </>
        }
      />

      {err && (
        <div className="dbw-banner dbw-banner--error">
          <AlertTriangle size={16} /> <span>{err}</span>
          <button className="dbw-icon-btn" onClick={() => setErr('')} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      {boards.length > 0 && (
        <div className="dbw-boardbar">
          {boards.map((b) => (
            <button
              key={b.id}
              className={`dbw-tab${b.id === activeId ? ' is-active' : ''}`}
              onClick={() => { setActiveId(b.id); loadBoard(b.id); }}
            >
              {b.name} <span className="dbw-tab-count">{b.widget_count}</span>
            </button>
          ))}
          <button className="dbw-btn dbw-btn--ghost" onClick={() => setComposing(true)} disabled={!activeId}>
            <Plus size={15} /> Add widget
          </button>
        </div>
      )}

      {composing && (
        <WidgetComposer
          catalog={catalog}
          chartTypes={chartTypes}
          saving={saving}
          onCancel={() => setComposing(false)}
          onSave={addWidget}
        />
      )}

      {!boards.length ? (
        <EmptyState
          icon={LayoutDashboard}
          title="No dashboards yet"
          message="Create one, then compose it from the metric catalog. Metrics you can see here are the ones your roles already permit."
          action={<button className="dbw-btn dbw-btn--primary" onClick={createBoard}><Plus size={15} /> New dashboard</button>}
        />
      ) : !board?.widgets?.length ? (
        <EmptyState
          icon={Plus}
          title="This dashboard is empty"
          message="Add a widget to begin."
          action={<button className="dbw-btn dbw-btn--primary" onClick={() => setComposing(true)}><Plus size={15} /> Add widget</button>}
        />
      ) : (
        <div ref={containerRef}>
          <GridLayout
            className="dbw-grid"
            layout={layout}
            width={gridWidth}
            cols={12}
            rowHeight={90}
            margin={[16, 16]}
            draggableHandle=".dbw-widget-head"
            onDragStop={persistLayout}
            onResizeStop={persistLayout}
          >
            {board.widgets.map((w) => (
              <div key={String(w.id)} className="dbw-widget">
                <div className="dbw-widget-head">
                  <span className="dbw-widget-title">{w.title}</span>
                  <button
                    className="dbw-icon-btn"
                    onClick={() => removeWidget(w.id)}
                    aria-label={`Remove ${w.title}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="dbw-widget-body">
                  <WidgetChart widget={w} />
                </div>
                {w.meta?.truncated && (
                  <div className="dbw-widget-foot">
                    Showing the top {w.meta.row_count} — this is not the whole set.
                  </div>
                )}
              </div>
            ))}
          </GridLayout>
        </div>
      )}
    </PageShell>
  );
}
