import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Zap, Clock, ArrowRight, X, Loader } from 'lucide-react';
import '../ai.css';

const NAV_SEARCH_URL = `${import.meta.env.VITE_API_URL || '/api'}/ai/nav-search`;
const SESSION_KEY = 'smart_search_recent';

const SEARCH_RULES = [
  { pattern: /salary|payroll|pay/i,           page: 'Payroll',             label: 'Payroll' },
  { pattern: /leave|vacation|off/i,           page: 'AllLeaves',           label: 'Leaves' },
  { pattern: /invoice|bill/i,                 page: 'InvoicesNew',         label: 'Invoices' },
  { pattern: /employee|staff/i,               page: 'EmployeesData',       label: 'Employees' },
  { pattern: /ticket|support/i,               page: 'AllTickets',          label: 'Tickets' },
  { pattern: /project/i,                      page: 'ProjectsDashboard',   label: 'Projects' },
  { pattern: /attendance|late/i,              page: 'AttendanceDashboard', label: 'Attendance' },
  { pattern: /purchase|procurement/i,         page: 'PurchaseOrders',      label: 'Purchase Orders' },
  { pattern: /travel|trip/i,                  page: 'TravelRequests',      label: 'Travel' },
  { pattern: /complaint/i,                    page: 'CustomerComplaintsIPCS', label: 'Complaints' },
  { pattern: /recruit|candidate|hire/i,       page: 'CandidatePipeline',   label: 'Recruitment' },
  { pattern: /inventory|stock/i,              page: 'StockSummary',        label: 'Inventory' },
  { pattern: /approval/i,                     page: 'ApprovalCenter',      label: 'Approvals' },
  { pattern: /announcement/i,                 page: 'Announcements',       label: 'Announcements' },
  { pattern: /finance|account|journal/i,      page: 'FinanceDashboardNew', label: 'Finance' },
  { pattern: /timesheet|timesheet|hour/i,     page: 'MyTimesheet',         label: 'Timesheets' },
  { pattern: /performance|review|goal/i,      page: 'PerformanceReviews',  label: 'Performance' },
  { pattern: /crm|lead|opportunity/i,         page: 'SalesDashboard',      label: 'CRM' },
  { pattern: /campaign|marketing/i,           page: 'Campaigns',           label: 'Marketing' },
  { pattern: /org.*chart|organiz/i,           page: 'OrgChart',            label: 'Org Chart' },
];

function getRecent() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '[]'); } catch { return []; }
}
function saveRecent(q) {
  try {
    const prev = getRecent().filter(r => r !== q);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify([q, ...prev].slice(0, 5)));
  } catch { /* ignore */ }
}

export default function SmartSearch({ setPage, open, onClose }) {
  const [query,       setQuery]       = useState('');
  const [suggestion,  setSuggestion]  = useState(null);
  const [aiLoading,   setAiLoading]   = useState(false);
  const [recent,      setRecent]      = useState([]);
  const inputRef = useRef(null);
  const aiTimer  = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSuggestion(null);
      setRecent(getRecent());
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // cleanup timer on unmount
  useEffect(() => () => clearTimeout(aiTimer.current), []);

  const navigate = useCallback((page, q) => {
    if (q) saveRecent(q);
    setPage?.(page);
    onClose?.();
  }, [setPage, onClose]);

  const callClaude = useCallback(async (q) => {
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch(NAV_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) throw new Error();
      const parsed = await res.json();
      if (parsed.page) setSuggestion({ page: parsed.page, label: parsed.label, isAI: true });
    } catch {
      // silently fail — rule-based already handled it
    } finally {
      setAiLoading(false);
    }
  }, []);

  const handleChange = (e) => {
    const q = e.target.value;
    setQuery(q);
    setSuggestion(null);
    clearTimeout(aiTimer.current);

    if (!q.trim()) return;

    // rule-based match first (instant)
    const match = SEARCH_RULES.find(r => r.pattern.test(q));
    if (match) {
      setSuggestion({ page: match.page, label: match.label, isAI: false });
    } else {
      // debounce Claude call
      aiTimer.current = setTimeout(() => callClaude(q), 600);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Escape') onClose?.();
    if (e.key === 'Enter' && suggestion) navigate(suggestion.page, query);
  };

  if (!open) return null;

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9998, backdropFilter: 'blur(2px)' }} />

      <div style={{
        position: 'fixed', top: '12%', left: '50%', transform: 'translateX(-50%)',
        width: '90%', maxWidth: 560, zIndex: 9999,
        background: '#fff', borderRadius: 16, boxShadow: '0 25px 50px rgba(0,0,0,0.25)',
        overflow: 'hidden',
      }}>
        {/* Input row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid #f0f0f4' }}>
          <Search size={18} color="#9ca3af" />
          <input
            ref={inputRef}
            value={query}
            onChange={handleChange}
            onKeyDown={handleKey}
            placeholder={'Ask anything… "leave requests", "Ramesh payslip"'}
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 15, color: '#111827', background: 'transparent' }}
          />
          {aiLoading && <Loader size={14} color="#6366f1" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />}
          {query && !aiLoading && (
            <button onClick={() => { setQuery(''); setSuggestion(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#9ca3af' }}>
              <X size={16} />
            </button>
          )}
          <kbd style={{ fontSize: 11, color: '#9ca3af', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 4, padding: '2px 6px' }}>Esc</kbd>
        </div>

        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {/* AI / rule suggestion */}
          {suggestion && (
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f4' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                {suggestion.isAI ? '🤖 AI Suggestion' : '⚡ Quick Match'}
              </div>
              <button
                onClick={() => navigate(suggestion.page, query)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  width: '100%', padding: '10px 12px', borderRadius: 8,
                  background: '#eef2ff', border: '1px solid #c7d2fe', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 600, color: '#4338ca' }}>
                  Go to {suggestion.label}
                </span>
                <ArrowRight size={14} color="#6366f1" />
              </button>
            </div>
          )}

          {/* AI loading */}
          {aiLoading && !suggestion && query && (
            <div style={{ padding: '14px 16px', color: '#6b7280', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Zap size={14} color="#6366f1" /> Asking AI for suggestions…
            </div>
          )}

          {/* Recent searches */}
          {!query && recent.length > 0 && (
            <div style={{ padding: '8px 16px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                Recent
              </div>
              {recent.map((r, i) => (
                <div
                  key={i}
                  onClick={() => { setQuery(r); handleChange({ target: { value: r } }); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', cursor: 'pointer', fontSize: 14, color: '#374151', borderRadius: 6 }}
                >
                  <Clock size={13} color="#9ca3af" /> {r}
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!query && recent.length === 0 && (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              Type a question or page name to navigate
            </div>
          )}

          {query && !suggestion && !aiLoading && (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              No match found for "{query}"
            </div>
          )}
        </div>

        <div style={{ padding: '8px 16px', borderTop: '1px solid #f0f0f4', display: 'flex', gap: 16, fontSize: 11, color: '#9ca3af' }}>
          <span><kbd style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 3, padding: '1px 4px' }}>↵</kbd> navigate</span>
          <span><kbd style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 3, padding: '1px 4px' }}>Esc</kbd> close</span>
          <span style={{ marginLeft: 'auto', color: '#c7d2fe' }}>⚡ AI-powered</span>
        </div>
      </div>
    </>
  );
}
