import { useState, useEffect, useCallback } from 'react';
import { CheckSquare, Square, ChevronDown, ChevronUp, Users, Download } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const CHECKLIST_TEMPLATE = [
  { category: 'Pre-Joining', items: [
    'Offer letter signed and returned',
    'Background verification initiated',
    'Document collection (ID, Address, Education, Experience)',
    'System access request raised',
    'Laptop/equipment procurement initiated',
  ]},
  { category: 'Day 1 – IT Setup', items: [
    'Laptop configured and handed over',
    'Email account created',
    'Required software installed',
    'VPN and system access provided',
    'ID card issued',
  ]},
  { category: 'Day 1 – HR Induction', items: [
    'Company overview presentation',
    'HR policies briefing',
    'Leave and attendance orientation',
    'Benefits and payroll explanation',
    'Employee handbook shared',
  ]},
  { category: 'Week 1 – Department Onboarding', items: [
    'Introduced to team members',
    'Assigned a buddy/mentor',
    'Department-specific tools access granted',
    'First week tasks/goals set',
    'Manager 1-on-1 scheduled',
  ]},
  { category: 'Month 1 – Completion', items: [
    '30-day check-in completed',
    'Probation goals documented',
    'Training plan created',
    'All documents verified and filed',
    'Probation review date set',
  ]},
];

function buildChecklist() {
  return CHECKLIST_TEMPLATE.map(cat => ({ ...cat, items: cat.items.map(item => ({ label: item, done: false })) }));
}

/**
 * @param {Function} setPage - navigate to another page key
 */
export default function OnboardingChecklist({ setPage: _setPage }) {
  const [newHires, setNewHires]         = useState([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState(null);
  const [selectedHire, setSelectedHire] = useState(null);
  const [checklist, setChecklist]       = useState([]);
  const [expanded, setExpanded]         = useState({});
  const _toast = useToast();
  const showToast = useCallback((msg) => _toast({ message: msg, type: 'success' }), [_toast]);

  const fetchNewHires = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/recruitment/onboarding');
      const data = res.data?.results ?? res.data;
      // Always trust the API response — empty array is a valid state (no pending onboardings)
      if (Array.isArray(data)) {
        setNewHires(data);
      } else {
        setNewHires([]);
      }
    } catch (err) {
      setError(err.message || 'Failed to load new hires');
      setNewHires([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchNewHires(); }, [fetchNewHires]);

  const STORAGE_KEY = id => `onboarding_checklist_${id}`;

  const selectHire = hire => {
    setSelectedHire(hire);
    // Restore saved progress from localStorage
    const saved = localStorage.getItem(STORAGE_KEY(hire.id));
    if (saved) {
      try { setChecklist(JSON.parse(saved)); } catch { setChecklist(buildChecklist()); }
    } else {
      setChecklist(buildChecklist());
    }
    const exp = {};
    CHECKLIST_TEMPLATE.forEach(c => { exp[c.category] = true; });
    setExpanded(exp);
  };

  const toggleItem = (ci, ii) => setChecklist(cl =>
    cl.map((cat, c) => c !== ci ? cat : {
      ...cat, items: cat.items.map((item, i) => i !== ii ? item : { ...item, done: !item.done }),
    })
  );

  const totalItems = checklist.reduce((a, c) => a + c.items.length, 0);
  const doneItems  = checklist.reduce((a, c) => a + c.items.filter(i => i.done).length, 0);
  const pct = totalItems ? Math.round((doneItems / totalItems) * 100) : 0;

  return (
    <div style={{ padding: '24px' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: '22px', fontWeight: 700 }}>Onboarding Checklist</h2>
      <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: '13px' }}>Track new hire onboarding progress</p>

      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '13px' }}>{error}</div>
      )}

      {!selectedHire ? (
        <>
          <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px' }}>New Hires – Pending Onboarding</h3>
          {loading ? (
            <div style={{ background: '#f3f4f6', borderRadius: '8px', padding: '20px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>Loading…</div>
          ) : (
          <div style={{ display: 'grid', gap: '12px' }}>
            {newHires.map(hire => (
              <div key={hire.id} style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: '#d1fae5', color: '#065f46', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '15px' }}>
                    {hire.name.charAt(0)}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>{hire.name}</div>
                    <div style={{ fontSize: '12px', color: '#6b7280' }}>{hire.designation} · {hire.department} · Joining: {hire.joining_date}</div>
                  </div>
                </div>
                <button onClick={() => selectHire(hire)} style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', padding: '7px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                  Start Checklist
                </button>
              </div>
            ))}
          </div>
          )}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <div>
              <span style={{ fontWeight: 700, fontSize: '16px' }}>{selectedHire.name}</span>
              <span style={{ marginLeft: '10px', fontSize: '13px', color: '#6b7280' }}>Joining: {selectedHire.joining_date}</span>
            </div>
            <button onClick={() => setSelectedHire(null)} style={{ background: '#f3f4f6', border: 'none', borderRadius: '8px', padding: '7px 14px', fontSize: '12px', cursor: 'pointer' }}>
              ← Back
            </button>
          </div>

          <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', padding: '16px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px', fontWeight: 600 }}>
              <span>Overall Progress</span>
              <span>{doneItems}/{totalItems} tasks ({pct}%)</span>
            </div>
            <div style={{ background: '#f3f4f6', borderRadius: '99px', height: '8px', overflow: 'hidden' }}>
              <div style={{ height: '8px', background: pct === 100 ? '#10b981' : '#6366f1', width: `${pct}%`, borderRadius: '99px', transition: 'width 0.3s' }} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
            {checklist.map((cat, ci) => (
              <div key={cat.category} style={{ background: '#fff', borderRadius: '12px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                <button onClick={() => setExpanded(e => ({ ...e, [cat.category]: !e[cat.category] }))}
                  style={{ width: '100%', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer' }}>
                  <span style={{ fontWeight: 600, fontSize: '14px' }}>{cat.category}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '12px', color: '#6b7280' }}>{cat.items.filter(i => i.done).length}/{cat.items.length}</span>
                    {expanded[cat.category] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </div>
                </button>
                {expanded[cat.category] && (
                  <div style={{ borderTop: '1px solid #f3f4f6', padding: '8px 16px 12px' }}>
                    {cat.items.map((item, ii) => (
                      <div key={item.label} onClick={() => toggleItem(ci, ii)}
                        style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', cursor: 'pointer', borderBottom: ii < cat.items.length - 1 ? '1px solid #f9fafb' : 'none' }}>
                        {item.done
                          ? <CheckSquare size={16} color="#10b981" style={{ flexShrink: 0 }} />
                          : <Square size={16} color="#9ca3af" style={{ flexShrink: 0 }} />}
                        <span style={{ fontSize: '13px', textDecoration: item.done ? 'line-through' : 'none', color: item.done ? '#9ca3af' : '#111827' }}>
                          {item.label}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => {
                localStorage.setItem(STORAGE_KEY(selectedHire.id), JSON.stringify(checklist));
                showToast('Progress saved');
              }}
              style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>
              Save Progress
            </button>
            <button
              onClick={() => {
                const lines = [`Onboarding Report — ${selectedHire.name}`, `Joining: ${selectedHire.joining_date}`, `Progress: ${doneItems}/${totalItems} (${pct}%)`, ''];
                checklist.forEach(cat => {
                  lines.push(`## ${cat.category}`);
                  cat.items.forEach(item => lines.push(`[${item.done ? 'x' : ' '}] ${item.label}`));
                  lines.push('');
                });
                const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `onboarding_${selectedHire.name.replace(/\s+/g,'_')}.txt`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#f3f4f6', border: 'none', borderRadius: '8px', padding: '10px 20px', fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>
              <Download size={14} /> Download Report
            </button>
          </div>
        </>
      )}
    </div>
  );
}