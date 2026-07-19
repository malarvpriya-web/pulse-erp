import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const ACTIVITY_TYPES = [
  { value: 'call',    label: 'Call',    icon: '📞', color: '#0d6efd' },
  { value: 'meeting', label: 'Meeting', icon: '🤝', color: '#6f42c1' },
  { value: 'email',   label: 'Email',   icon: '✉️', color: '#20c997' },
  { value: 'task',    label: 'Task',    icon: '✅', color: '#fd7e14' },
  { value: 'note',    label: 'Note',    icon: '📝', color: '#6c757d' },
  { value: 'demo',    label: 'Demo',    icon: '🖥️', color: '#e83e8c' },
];

const EMPTY_FORM = {
  activity_type: 'call',
  subject: '',
  description: '',
  activity_date: new Date().toISOString().slice(0, 16),
  duration_mins: '',
  lead_id: '',
  opportunity_id: '',
  account_id: '',
};

export default function CRMActivities() {
  const toast = useToast();
  const [activities, setActivities]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [filterType, setFilterType]   = useState('');
  const [search, setSearch]           = useState('');
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState(EMPTY_FORM);
  const [saving, setSaving]           = useState(false);
  const [editId, setEditId]           = useState(null);
  const [leads, setLeads]             = useState([]);
  const [accounts, setAccounts]       = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (filterType) params.type   = filterType;
      if (search)     params.search = search;
      const res = await api.get('/crm/activities', { params });
      if (isMounted.current) setActivities(res.data?.activities || []);
    } catch (e) {
      if (isMounted.current) setError(e.response?.data?.error || 'Failed to load activities');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [filterType, search]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    Promise.allSettled([
      api.get('/crm/leads'),
      api.get('/crm/accounts'),
      api.get('/crm/opportunities'),
    ]).then(([l, a, o]) => {
      if (!isMounted.current) return;
      if (l.status === 'fulfilled') setLeads(l.value.data || []);
      if (a.status === 'fulfilled') setAccounts(a.value.data?.accounts || []);
      if (o.status === 'fulfilled') setOpportunities(o.value.data || []);
    });
  }, []);

  const handleSubmit = async e => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form };
      if (!payload.lead_id)        delete payload.lead_id;
      if (!payload.opportunity_id) delete payload.opportunity_id;
      if (!payload.account_id)     delete payload.account_id;
      if (!payload.duration_mins)  delete payload.duration_mins;

      if (editId) {
        await api.put(`/crm/activities/${editId}`, payload);
      } else {
        await api.post('/crm/activities', payload);
      }
      setShowForm(false);
      setEditId(null);
      setForm(EMPTY_FORM);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to save activity');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = act => {
    setForm({
      activity_type:  act.activity_type || 'call',
      subject:        act.subject        || '',
      description:    act.description    || '',
      activity_date:  act.activity_date  ? new Date(act.activity_date).toISOString().slice(0, 16) : '',
      duration_mins:  act.duration_mins  || '',
      lead_id:        act.lead_id        || '',
      opportunity_id: act.opportunity_id || '',
      account_id:     act.account_id     || '',
    });
    setEditId(act.id);
    setShowForm(true);
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/crm/activities/${id}`);
      load();
    } catch (e) {
      toast.error('Failed to delete activity');
    }
  };

  const typeInfo = val => ACTIVITY_TYPES.find(t => t.value === val) || ACTIVITY_TYPES[0];

  return (
    <div style={{ padding: '24px' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Activity"
        message="Delete this activity?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Activities</h2>
          <p style={{ margin: 0, color: '#6c757d', fontSize: 13 }}>Calls, meetings, emails and tasks across all CRM records</p>
        </div>
        <button
          onClick={() => { setForm(EMPTY_FORM); setEditId(null); setShowForm(true); }}
          style={{ background: '#0d6efd', color: '#fff', border: 'none', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontWeight: 600 }}
        >
          + Log Activity
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          placeholder="Search subject or description..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ border: '1px solid #dee2e6', borderRadius: 6, padding: '7px 12px', width: 280 }}
        />
        <select value={filterType} onChange={e => setFilterType(e.target.value)}
          style={{ border: '1px solid #dee2e6', borderRadius: 6, padding: '7px 12px' }}>
          <option value="">All Types</option>
          {ACTIVITY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <button onClick={load} style={{ border: '1px solid #dee2e6', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', background: '#fff' }}>
          Refresh
        </button>
      </div>

      {/* Quick stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {ACTIVITY_TYPES.map(t => {
          const cnt = activities.filter(a => a.activity_type === t.value).length;
          return (
            <div key={t.value}
              onClick={() => setFilterType(filterType === t.value ? '' : t.value)}
              style={{
                background: filterType === t.value ? t.color : '#f8f9fa',
                color: filterType === t.value ? '#fff' : '#495057',
                border: `1px solid ${t.color}`,
                borderRadius: 8, padding: '8px 16px', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, transition: 'all .2s',
              }}
            >
              {t.icon} {t.label} ({cnt})
            </div>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: '#fff3f3', border: '1px solid #f5c2c7', borderRadius: 6, padding: 12, marginBottom: 16, color: '#842029' }}>
          {error}
        </div>
      )}

      {/* Activities list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#6c757d' }}>Loading activities...</div>
      ) : activities.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#6c757d' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No activities yet</div>
          <div style={{ fontSize: 13 }}>Log your first call, meeting, or task to get started.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {activities.map(act => {
            const ti = typeInfo(act.activity_type);
            return (
              <div key={act.id} style={{
                background: '#fff', border: '1px solid #e9ecef', borderRadius: 8,
                padding: '14px 18px', display: 'flex', alignItems: 'flex-start', gap: 14,
                boxShadow: '0 1px 3px rgba(0,0,0,.05)',
              }}>
                <div style={{
                  width: 42, height: 42, borderRadius: '50%', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', fontSize: 20,
                  background: ti.color + '18', flexShrink: 0,
                }}>
                  {ti.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{act.subject || ti.label}</span>
                      <span style={{
                        marginLeft: 8, fontSize: 11, fontWeight: 600, padding: '2px 8px',
                        borderRadius: 12, background: ti.color + '22', color: ti.color,
                      }}>
                        {ti.label}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => handleEdit(act)}
                        style={{ border: '1px solid #dee2e6', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12, background: '#fff' }}>
                        Edit
                      </button>
                      <button onClick={() => setPendingHandleDelete(act.id)}
                        style={{ border: '1px solid #f5c2c7', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12, background: '#fff', color: '#842029' }}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {act.description && (
                    <div style={{ fontSize: 13, color: '#495057', marginTop: 4 }}>{act.description}</div>
                  )}
                  <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 12, color: '#6c757d', flexWrap: 'wrap' }}>
                    {act.activity_date && (
                      <span>📅 {new Date(act.activity_date).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                    {act.duration_mins && <span>⏱ {act.duration_mins} min</span>}
                    {act.performed_by_name && <span>👤 {act.performed_by_name}</span>}
                    {act.lead_name        && <span>🎯 Lead: {act.lead_name}</span>}
                    {act.opportunity_name && <span>💼 Opp: {act.opportunity_name}</span>}
                    {act.account_name     && <span>🏢 {act.account_name}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showForm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
          zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ background: '#fff', borderRadius: 10, width: 560, padding: 28, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,.3)' }}>
            <h3 style={{ margin: '0 0 20px', fontSize: 18 }}>{editId ? 'Edit Activity' : 'Log Activity'}</h3>
            <form onSubmit={handleSubmit}>
              {/* Type */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Activity Type *</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {ACTIVITY_TYPES.map(t => (
                    <label key={t.value} style={{
                      display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                      padding: '5px 12px', borderRadius: 6, border: '1px solid',
                      borderColor: form.activity_type === t.value ? t.color : '#dee2e6',
                      background: form.activity_type === t.value ? t.color + '18' : '#fff',
                      fontSize: 12, fontWeight: 600,
                    }}>
                      <input type="radio" name="activity_type" value={t.value}
                        checked={form.activity_type === t.value}
                        onChange={e => setForm(f => ({ ...f, activity_type: e.target.value }))}
                        style={{ display: 'none' }}
                      />
                      {t.icon} {t.label}
                    </label>
                  ))}
                </div>
              </div>

              {/* Subject */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Subject *</label>
                <input required value={form.subject}
                  onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                  style={{ width: '100%', border: '1px solid #dee2e6', borderRadius: 6, padding: '8px 12px', boxSizing: 'border-box' }}
                  placeholder="What was discussed?"
                />
              </div>

              {/* Date + Duration */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Date & Time *</label>
                  <input required type="datetime-local" value={form.activity_date}
                    onChange={e => setForm(f => ({ ...f, activity_date: e.target.value }))}
                    style={{ width: '100%', border: '1px solid #dee2e6', borderRadius: 6, padding: '8px 12px', boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Duration (minutes)</label>
                  <input type="number" min="1" value={form.duration_mins}
                    onChange={e => setForm(f => ({ ...f, duration_mins: e.target.value }))}
                    style={{ width: '100%', border: '1px solid #dee2e6', borderRadius: 6, padding: '8px 12px', boxSizing: 'border-box' }}
                    placeholder="e.g. 30"
                  />
                </div>
              </div>

              {/* Link to entity */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Linked Lead</label>
                  <select value={form.lead_id} onChange={e => setForm(f => ({ ...f, lead_id: e.target.value }))}
                    style={{ width: '100%', border: '1px solid #dee2e6', borderRadius: 6, padding: '8px 10px', boxSizing: 'border-box' }}>
                    <option value="">None</option>
                    {leads.slice(0, 50).map(l => <option key={l.id} value={l.id}>{l.company_name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Linked Opportunity</label>
                  <select value={form.opportunity_id} onChange={e => setForm(f => ({ ...f, opportunity_id: e.target.value }))}
                    style={{ width: '100%', border: '1px solid #dee2e6', borderRadius: 6, padding: '8px 10px', boxSizing: 'border-box' }}>
                    <option value="">None</option>
                    {opportunities.slice(0, 50).map(o => <option key={o.id} value={o.id}>{o.opportunity_name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Linked Account</label>
                  <select value={form.account_id} onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}
                    style={{ width: '100%', border: '1px solid #dee2e6', borderRadius: 6, padding: '8px 10px', boxSizing: 'border-box' }}>
                    <option value="">None</option>
                    {accounts.slice(0, 50).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Description */}
              <div style={{ marginBottom: 18 }}>
                <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>Notes / Description</label>
                <textarea value={form.description} rows={3}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  style={{ width: '100%', border: '1px solid #dee2e6', borderRadius: 6, padding: '8px 12px', boxSizing: 'border-box', resize: 'vertical' }}
                  placeholder="Key outcomes, follow-up items..."
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" onClick={() => { setShowForm(false); setEditId(null); }}
                  style={{ border: '1px solid #dee2e6', borderRadius: 6, padding: '8px 18px', cursor: 'pointer', background: '#fff' }}>
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  style={{ background: '#0d6efd', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 22px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600 }}>
                  {saving ? 'Saving...' : editId ? 'Update Activity' : 'Log Activity'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
