import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, BookOpen, Search, Copy, Trash2, Eye, MoreHorizontal } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const CATEGORIES = ['All', 'Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closing', 'General'];
const STAGES     = ['prospecting', 'qualification', 'proposal', 'negotiation', 'closing', 'won'];

const CAT_COLORS = {
  prospecting:  { bg: '#dbeafe', color: '#1d4ed8' },
  qualification:{ bg: '#fef3c7', color: '#92400e' },
  proposal:     { bg: '#ede9fe', color: '#6B3FDB' },
  negotiation:  { bg: '#fee2e2', color: '#b91c1c' },
  closing:      { bg: '#d1fae5', color: '#065f46' },
  general:      { bg: '#f3f4f6', color: '#374151' },
};

const EMPTY_FORM = { name: '', category: 'qualification', applicable_stage: 'qualification', description: '' };

function catColor(cat) {
  return CAT_COLORS[(cat || '').toLowerCase()] || CAT_COLORS.general;
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

export default function SalesPlaybooks({ setPage }) {
  const toast = useToast();
  const [playbooks, setPlaybooks] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [category,  setCategory]  = useState('All');
  const [search,    setSearch]    = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form,      setForm]      = useState(EMPTY_FORM);
  const [saving,    setSaving]    = useState(false);
  const [menuOpen,  setMenuOpen]  = useState(null);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (category !== 'All') params.category = category.toLowerCase();
    if (search.trim())       params.search   = search.trim();
    api.get('/sales/playbooks', { params })
      .then(r => setPlaybooks(r.data?.data ?? []))
      .catch(() => setPlaybooks([]))
      .finally(() => setLoading(false));
  }, [category, search]);

  useEffect(() => { load(); }, [load]);

  const openModal = () => { setForm(EMPTY_FORM); setShowModal(true); };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await api.post('/sales/playbooks', {
        name: form.name.trim(),
        category: form.category,
        applicable_stage: form.applicable_stage,
        description: form.description,
      });
      setShowModal(false);
      toast.success('Playbook created');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create playbook');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/sales/playbooks/${id}`);
      toast.success('Playbook deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  const handleDuplicate = async (pb) => {
    try {
      const res = await api.post('/sales/playbooks', {
        name: `${pb.name} (Copy)`,
        category: pb.category,
        applicable_stage: pb.applicable_stage,
        description: pb.description,
      });
      const newId = res.data?.data?.id;
      if (newId && pb.step_count > 0) {
        const detail = await api.get(`/sales/playbooks/${pb.id}`);
        const steps = detail.data?.data?.steps ?? [];
        for (const s of steps) {
          await api.post(`/sales/playbooks/${newId}/steps`, {
            title: s.title, description: s.description,
            step_type: s.step_type, content: s.content,
            is_mandatory: s.is_mandatory,
          });
        }
      }
      toast.success('Playbook duplicated');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Duplicate failed');
    }
  };

  const openDetail = (pb) => {
    sessionStorage.setItem('selectedPlaybookId', pb.id);
    sessionStorage.setItem('selectedPlaybook', JSON.stringify(pb));
    if (setPage) setPage('PlaybookDetail', { id: pb.id });
  };

  const displayedPlaybooks = playbooks;

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100%' }}
         onClick={() => menuOpen && setMenuOpen(null)}>
      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Playbook"
        message="Delete this playbook and all its steps?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Sales Playbooks</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            {playbooks.length} playbook{playbooks.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button onClick={openModal}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px',
                   background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8,
                   cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15} /> New Playbook
        </button>
      </div>

      {/* Search + Category pills */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '0 0 260px' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%',
                                     transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Search playbooks..."
                 style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8,
                          paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8,
                          fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {CATEGORIES.map(c => (
            <button key={c} onClick={() => setCategory(c)}
              style={{ padding: '6px 14px', borderRadius: 20, border: '1px solid',
                       fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all .15s',
                       background: category === c ? '#6B3FDB' : '#fff',
                       color:      category === c ? '#fff'    : '#6b7280',
                       borderColor:category === c ? '#6B3FDB' : '#e5e7eb' }}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading…</div>
      ) : displayedPlaybooks.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60,
                      textAlign: 'center', border: '1px solid #f0f0f4' }}>
          <BookOpen size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af', margin: '0 0 16px', fontSize: 14 }}>
            No playbooks yet. Create your first sales playbook.
          </p>
          <button onClick={openModal}
            style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff',
                     border: 'none', borderRadius: 8, cursor: 'pointer',
                     fontSize: 13, fontWeight: 600 }}>
            Create Playbook
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {displayedPlaybooks.map(pb => {
            const cc = catColor(pb.category);
            return (
              <div key={pb.id}
                style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4',
                         padding: '20px', display: 'flex', flexDirection: 'column',
                         gap: 12, position: 'relative' }}>

                {/* Top row: name + badge + menu */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 15, fontWeight: 700, color: '#1f2937',
                                margin: '0 0 6px', lineHeight: 1.3 }}>
                      {pb.name}
                    </p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {pb.category && (
                        <span style={{ background: cc.bg, color: cc.color,
                                       padding: '2px 8px', borderRadius: 20,
                                       fontSize: 10, fontWeight: 700,
                                       textTransform: 'uppercase', letterSpacing: '.4px' }}>
                          {pb.category}
                        </span>
                      )}
                      {pb.applicable_stage && pb.applicable_stage !== pb.category && (
                        <span style={{ background: '#f3f4f6', color: '#6b7280',
                                       padding: '2px 8px', borderRadius: 20, fontSize: 10 }}>
                          Stage: {pb.applicable_stage}
                        </span>
                      )}
                      <span style={{ background: pb.is_active ? '#d1fae5' : '#f3f4f6',
                                     color:      pb.is_active ? '#065f46' : '#9ca3af',
                                     padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600 }}>
                        {pb.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                  {/* 3-dot menu */}
                  <div style={{ position: 'relative' }}>
                    <button onClick={e => { e.stopPropagation(); setMenuOpen(menuOpen === pb.id ? null : pb.id); }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer',
                               padding: 4, color: '#9ca3af', borderRadius: 6 }}>
                      <MoreHorizontal size={18} />
                    </button>
                    {menuOpen === pb.id && (
                      <div onClick={e => e.stopPropagation()}
                        style={{ position: 'absolute', right: 0, top: '100%', zIndex: 20,
                                 background: '#fff', border: '1px solid #e5e7eb',
                                 borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.12)',
                                 minWidth: 140, padding: '4px 0' }}>
                        {[
                          { icon: <Eye size={13} />,   label: 'View / Edit', fn: () => { setMenuOpen(null); openDetail(pb); } },
                          { icon: <Copy size={13} />,  label: 'Duplicate',   fn: () => { setMenuOpen(null); handleDuplicate(pb); } },
                          { icon: <Trash2 size={13} />,label: 'Delete',      fn: () => { setMenuOpen(null); setPendingHandleDelete(pb.id); }, danger: true },
                        ].map(item => (
                          <button key={item.label} onClick={item.fn}
                            style={{ display: 'flex', alignItems: 'center', gap: 8,
                                     width: '100%', padding: '8px 14px', background: 'none',
                                     border: 'none', cursor: 'pointer', fontSize: 13,
                                     color: item.danger ? '#dc2626' : '#374151',
                                     textAlign: 'left' }}>
                            {item.icon} {item.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Description */}
                {pb.description && (
                  <p style={{ fontSize: 13, color: '#6b7280', margin: 0, lineHeight: 1.5,
                               display: '-webkit-box', WebkitLineClamp: 2,
                               WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {pb.description}
                  </p>
                )}

                {/* Step count + created info */}
                <div style={{ display: 'flex', justifyContent: 'space-between',
                               alignItems: 'center', marginTop: 'auto', paddingTop: 8,
                               borderTop: '1px solid #f5f3ff' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#6B3FDB' }}>
                    {pb.step_count ?? 0} step{pb.step_count !== 1 ? 's' : ''}
                  </span>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>
                    {pb.created_by_name ? `By ${pb.created_by_name} · ` : ''}{fmtDate(pb.created_at)}
                  </span>
                </div>

                {/* View/Edit CTA */}
                <button onClick={() => openDetail(pb)}
                  style={{ width: '100%', padding: '8px', background: '#f5f3ff',
                           color: '#6B3FDB', border: '1px solid #ede9fe', borderRadius: 8,
                           cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  View / Edit
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* New Playbook Modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
                      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
             onClick={() => setShowModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 500,
                        maxHeight: '90vh', overflowY: 'auto',
                        boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}
               onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: '0 0 20px' }}>
              New Sales Playbook
            </h2>
            <div style={{ display: 'grid', gap: 14 }}>
              {/* Name */}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                 color: '#374151', marginBottom: 4 }}>Name *</label>
                <input value={form.name}
                       onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                       placeholder="e.g. Enterprise Deal Playbook"
                       style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              {/* Category */}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                 color: '#374151', marginBottom: 4 }}>Category</label>
                <select value={form.category}
                        onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                        style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                 borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  {CATEGORIES.filter(c => c !== 'All').map(c => (
                    <option key={c} value={c.toLowerCase()}>{c}</option>
                  ))}
                </select>
              </div>
              {/* Applicable Stage */}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                 color: '#374151', marginBottom: 4 }}>Applicable Stage</label>
                <select value={form.applicable_stage}
                        onChange={e => setForm(f => ({ ...f, applicable_stage: e.target.value }))}
                        style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                 borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  {STAGES.map(s => (
                    <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                  ))}
                </select>
              </div>
              {/* Description */}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                 color: '#374151', marginBottom: 4 }}>Description</label>
                <textarea value={form.description}
                          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                          rows={3} placeholder="Brief overview of this playbook…"
                          style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                   borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical',
                                   boxSizing: 'border-box' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowModal(false)}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8,
                         background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !form.name.trim()}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff',
                         border: 'none', borderRadius: 8, cursor: 'pointer',
                         fontSize: 13, fontWeight: 600,
                         opacity: saving || !form.name.trim() ? .6 : 1 }}>
                {saving ? 'Creating…' : 'Create Playbook'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
