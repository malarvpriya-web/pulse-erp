import { useState, useEffect, useRef } from "react";
import api from "@/services/api/client";
import { fmtDate } from "@/utils/dateFormatter";
import "./MyRequests.css";

const TYPE_META = {
  leave:           { bg: '#eef2ff', color: '#4338ca' },
  expense:         { bg: '#fef3c7', color: '#92400e' },
  travel:          { bg: '#f0fdf4', color: '#166534' },
  purchase:        { bg: '#fce7f3', color: '#9d174d' },
  regularization:  { bg: '#fff7ed', color: '#c2410c' },
  ot:              { bg: '#fef9c3', color: '#854d0e' },
};
const typeMeta = t => TYPE_META[(t || '').toLowerCase()] || { bg: '#f3f4f6', color: '#374151' };

const STATUS_META = {
  approved: { bg: '#dcfce7', color: '#15803d' },
  rejected: { bg: '#fee2e2', color: '#dc2626' },
  pending:  { bg: '#fef3c7', color: '#92400e' },
};
const statusMeta = s => STATUS_META[(s || '').toLowerCase()] || { bg: '#f3f4f6', color: '#374151' };

export default function MyRequests() {
  const [awaitingMyAction, setAwaitingMyAction] = useState([]);
  const [submitted,        setSubmitted]        = useState([]);
  const [loading,          setLoading]          = useState(true);
  const [error,            setError]            = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    (async () => {
      setLoading(true);
      try {
        const res = await api.get('/approvals/my-requests');
        if (!isMounted.current) return;
        setAwaitingMyAction(Array.isArray(res.data?.awaitingMyAction) ? res.data.awaitingMyAction : []);
        setSubmitted(Array.isArray(res.data?.submitted) ? res.data.submitted : []);
        setError(false);
      } catch {
        if (isMounted.current) setError(true);
      } finally {
        if (isMounted.current) setLoading(false);
      }
    })();
    return () => { isMounted.current = false; };
  }, []);

  return (
    <div className="pulse-page my-requests-page">
      <h1>My Requests</h1>
      <p className="mr-subtitle">Status and history of what you've submitted — view only.</p>

      {error && <div className="mr-empty mr-error">Could not load your requests — try again.</div>}

      {awaitingMyAction.length > 0 && (
        <section className="mr-section">
          <h2>Awaiting Your Action</h2>
          <p className="mr-hint">
            These are routed to you for sign-off. Act on them from the relevant module
            (e.g. Leave Approvals) — this page is read-only.
          </p>
          <div className="mr-table-container">
            <table className="mr-table">
              <thead>
                <tr><th>Type</th><th>Request</th><th>From</th><th>Date</th></tr>
              </thead>
              <tbody>
                {awaitingMyAction.map((a, i) => (
                  <tr key={a.id || i}>
                    <td>
                      <span className="mr-badge" style={{ background: typeMeta(a.type).bg, color: typeMeta(a.type).color }}>
                        {a.type}
                      </span>
                    </td>
                    <td>{a.title}</td>
                    <td>{a.requested_by || '—'}</td>
                    <td className="mr-nowrap">{fmtDate(a.request_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mr-section">
        <h2>Submitted by Me</h2>
        {loading ? (
          <div className="mr-empty">Loading…</div>
        ) : submitted.length === 0 ? (
          <div className="mr-empty">You haven't submitted any requests yet.</div>
        ) : (
          <div className="mr-table-container">
            <table className="mr-table">
              <thead>
                <tr><th>Type</th><th>Request</th><th>Date</th><th>Amount</th><th>Status</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {submitted.map((r, i) => (
                  <tr key={r.id || i}>
                    <td>
                      <span className="mr-badge" style={{ background: typeMeta(r.request_type).bg, color: typeMeta(r.request_type).color }}>
                        {r.request_type}
                      </span>
                    </td>
                    <td>{r.request_title}</td>
                    <td className="mr-nowrap">{fmtDate(r.request_date)}</td>
                    <td>{r.amount != null ? Number(r.amount).toLocaleString('en-IN') : '—'}</td>
                    <td>
                      <span className="mr-badge" style={{ background: statusMeta(r.status).bg, color: statusMeta(r.status).color }}>
                        {r.status || '—'}
                      </span>
                    </td>
                    <td className="mr-notes">{r.comments || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
