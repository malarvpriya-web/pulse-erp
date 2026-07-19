import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Users, Plus, X, Search, Eye, Pencil, Trash2, Tag, Building2 } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const EMPTY_FORM = { pool_name: '', description: '', department: '', skills: [], is_active: true };
const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#3b82f6','#ec4899','#14b8a6'];

const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '';

export default function TalentPools({ setPage }) {
  const toast = useToast();
  const [pools,       setPools]       = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [showModal,   setShowModal]   = useState(false);
  const [editPool,    setEditPool]    = useState(null);
  const [form,        setForm]        = useState(EMPTY_FORM);
  const [saving,      setSaving]      = useState(false);
  const [search,      setSearch]      = useState('');
  const [departments, setDepartments] = useState([]);
  const [skillInput,  setSkillInput]  = useState('');
  const [deleting,    setDeleting]    = useState(null);
  const [pendingDeletePool, setPendingDeletePool] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/talent/pools', { params: { search } });
      setPools(r.data?.data ?? (Array.isArray(r.data) ? r.data : []));
    } catch {
      setPools([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [search]);

  useEffect(() => {
    api.get('/orgchart/departments')
      .then(r => setDepartments(r.data?.data ?? (Array.isArray(r.data) ? r.data : [])))
      .catch(() => {});
  }, []);

  const openCreate = () => {
    setEditPool(null);
    setForm(EMPTY_FORM);
    setSkillInput('');
    setShowModal(true);
  };

  const openEdit = (p) => {
    setEditPool(p);
    const skills = Array.isArray(p.skills) ? p.skills
      : typeof p.skills === 'string' ? JSON.parse(p.skills || '[]')
      : (p.skill_focus ? p.skill_focus.split(',').map(s => s.trim()).filter(Boolean) : []);
    setForm({
      pool_name:   p.pool_name || '',
      description: p.description || '',
      department:  p.department || '',
      skills,
      is_active:   p.is_active !== false,
    });
    setSkillInput('');
    setShowModal(true);
  };

  const addSkill = () => {
    const sk = skillInput.trim();
    if (sk && !form.skills.includes(sk)) {
      setForm(f => ({ ...f, skills: [...f.skills, sk] }));
    }
    setSkillInput('');
  };

  const removeSkill = (sk) => setForm(f => ({ ...f, skills: f.skills.filter(s => s !== sk) }));

  const handleSave = async () => {
    if (!form.pool_name.trim()) return;
    setSaving(true);
    try {
      if (editPool) {
        await api.put(`/talent/pools/${editPool.id}`, form);
        toast.success(`Pool "${form.pool_name}" updated`);
      } else {
        await api.post('/talent/pools', form);
        toast.success(`Talent pool "${form.pool_name}" created`);
      }
      setShowModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save pool');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDeletePool) return;
    const p = pendingDeletePool;
    setPendingDeletePool(null);
    setDeleting(p.id);
    try {
      await api.delete(`/talent/pools/${p.id}`);
      toast.success('Pool deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete pool');
    } finally {
      setDeleting(null);
    }
  };

  const handleView = (p) => {
    sessionStorage.setItem('selectedPoolId', p.id);
    sessionStorage.setItem('selectedPool', JSON.stringify(p));
    if (setPage) setPage('TalentPoolDetail', { id: p.id });
  };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingDeletePool}
        title="Delete Talent Pool"
        message={pendingDeletePool ? `Delete pool "${pendingDeletePool.pool_name}"?` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDeletePool(null)}
      />
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Talent Pools</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>{pools.length} pool{pools.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={openCreate}
          style={{ display:'flex', alignItems:'center', gap: 6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius: 8, cursor:'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15}/> New Pool
        </button>
      </div>

      {/* Search */}
      <div style={{ position:'relative', marginBottom: 16, maxWidth: 320 }}>
        <Search size={14} style={{ position:'absolute', left: 10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search pools…"
          style={{ width:'100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border:'1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline:'none', boxSizing:'border-box' }}/>
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ textAlign:'center', padding: 40, color:'#9ca3af' }}>Loading…</div>
      ) : pools.length === 0 ? (
        <div style={{ background:'#fff', borderRadius: 12, padding: 60, textAlign:'center', border:'1px solid #f0f0f4' }}>
          <Users size={40} color="#d1d5db" style={{ marginBottom: 12 }}/>
          <p style={{ color:'#9ca3af', margin:'0 0 16px', fontSize: 14 }}>No talent pools yet. Create one to start organizing candidates.</p>
          <button onClick={openCreate}
            style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius: 8, cursor:'pointer', fontSize: 13, fontWeight: 600 }}>
            Create First Pool
          </button>
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {pools.map((p, i) => {
            const skills = Array.isArray(p.skills) ? p.skills
              : typeof p.skills === 'string' ? (() => { try { return JSON.parse(p.skills); } catch { return []; } })()
              : [];
            const legacySkills = p.skill_focus ? p.skill_focus.split(',').map(s => s.trim()).filter(Boolean) : [];
            const allSkills = skills.length ? skills : legacySkills;
            const memberCount = parseInt(p.member_count) || 0;
            const color = COLORS[i % COLORS.length];

            return (
              <div key={p.id} style={{ background:'#fff', borderRadius: 12, padding: 20, border:'1px solid #f0f0f4', boxShadow:'0 1px 3px rgba(0,0,0,.05)', display:'flex', flexDirection:'column', gap: 10 }}>
                {/* Title row */}
                <div style={{ display:'flex', alignItems:'flex-start', gap: 12 }}>
                  <div style={{ width: 42, height: 42, borderRadius: 10, background: color + '18', display:'flex', alignItems:'center', justifyContent:'center', flexShrink: 0 }}>
                    <Users size={20} color={color}/>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap: 6, flexWrap:'wrap' }}>
                      <p style={{ fontSize: 14, fontWeight: 700, color:'#1f2937', margin: 0 }}>{p.pool_name}</p>
                      <span style={{ fontSize: 10, fontWeight: 600, padding:'2px 7px', borderRadius: 20,
                        background: p.is_active !== false ? '#dcfce7' : '#f3f4f6',
                        color: p.is_active !== false ? '#15803d' : '#6b7280' }}>
                        {p.is_active !== false ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    {p.department && (
                      <div style={{ display:'flex', alignItems:'center', gap: 4, marginTop: 2 }}>
                        <Building2 size={10} color="#9ca3af"/>
                        <span style={{ fontSize: 11, color:'#9ca3af' }}>{p.department}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Description */}
                {p.description && (
                  <p style={{ fontSize: 12, color:'#6b7280', margin: 0, display:'-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>
                    {p.description}
                  </p>
                )}

                {/* Skill tags */}
                {allSkills.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap: 4 }}>
                    {allSkills.slice(0, 3).map((sk, j) => (
                      <span key={j} style={{ background:'#f5f3ff', color:'#6B3FDB', padding:'2px 7px', borderRadius: 20, fontSize: 10, fontWeight: 500, display:'flex', alignItems:'center', gap: 3 }}>
                        <Tag size={8}/>{sk}
                      </span>
                    ))}
                    {allSkills.length > 3 && (
                      <span style={{ background:'#f9fafb', color:'#9ca3af', padding:'2px 7px', borderRadius: 20, fontSize: 10 }}>
                        +{allSkills.length - 3} more
                      </span>
                    )}
                  </div>
                )}

                {/* Stats */}
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: color }}>
                    {memberCount} candidate{memberCount !== 1 ? 's' : ''}
                  </span>
                  {p.created_by_name && (
                    <span style={{ fontSize: 11, color:'#9ca3af' }}>by {p.created_by_name}</span>
                  )}
                </div>
                {p.created_at && (
                  <p style={{ fontSize: 11, color:'#d1d5db', margin: 0 }}>Created {fmtDate(p.created_at)}</p>
                )}

                {/* Actions */}
                <div style={{ display:'flex', gap: 8, borderTop:'1px solid #f3f4f6', paddingTop: 10, marginTop: 2 }}>
                  <button onClick={() => handleView(p)}
                    style={{ flex: 1, display:'flex', alignItems:'center', justifyContent:'center', gap: 5, padding:'7px 0', background:'#6B3FDB', color:'#fff', border:'none', borderRadius: 7, cursor:'pointer', fontSize: 12, fontWeight: 600 }}>
                    <Eye size={13}/> View Pool
                  </button>
                  <button onClick={() => openEdit(p)}
                    style={{ padding:'7px 10px', background:'#f3f4f6', color:'#374151', border:'none', borderRadius: 7, cursor:'pointer' }}>
                    <Pencil size={14}/>
                  </button>
                  <button onClick={() => { if (parseInt(p.member_count) > 0) { toast.error('Remove all members before deleting this pool'); return; } setPendingDeletePool(p); }} disabled={deleting === p.id || memberCount > 0}
                    title={memberCount > 0 ? 'Remove all members first' : 'Delete pool'}
                    style={{ padding:'7px 10px', background: memberCount > 0 ? '#f9fafb' : '#fef2f2', color: memberCount > 0 ? '#d1d5db' : '#dc2626', border:'none', borderRadius: 7, cursor: memberCount > 0 ? 'not-allowed' : 'pointer', opacity: deleting === p.id ? 0.6 : 1 }}>
                    <Trash2 size={14}/>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <div style={{ position:'fixed', inset: 0, background:'rgba(0,0,0,0.5)', zIndex: 1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius: 16, padding: 32, width: 480, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color:'#1f2937', margin: 0 }}>
                {editPool ? 'Edit Talent Pool' : 'New Talent Pool'}
              </h2>
              <button onClick={() => setShowModal(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>

            <div style={{ display:'grid', gap: 14 }}>
              {/* Pool Name */}
              <div>
                <label style={labelStyle}>Pool Name *</label>
                <input value={form.pool_name} onChange={e => setForm(f => ({ ...f, pool_name: e.target.value }))}
                  placeholder="e.g. Senior Backend Engineers"
                  style={inputStyle}/>
              </div>

              {/* Description */}
              <div>
                <label style={labelStyle}>Description</label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Purpose of this pool…" rows={3}
                  style={{ ...inputStyle, resize:'vertical', fontFamily:'inherit' }}/>
              </div>

              {/* Department */}
              <div>
                <label style={labelStyle}>Department</label>
                <select value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
                  style={inputStyle}>
                  <option value="">— Any department —</option>
                  {departments.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>

              {/* Skills tag input */}
              <div>
                <label style={labelStyle}>Target Skills</label>
                <div style={{ display:'flex', gap: 6 }}>
                  <input value={skillInput}
                    onChange={e => setSkillInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSkill(); } }}
                    placeholder="Type skill + Enter"
                    style={{ ...inputStyle, flex: 1, marginBottom: 0 }}/>
                  <button onClick={addSkill} type="button"
                    style={{ padding:'8px 14px', background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #e9d5ff', borderRadius: 8, cursor:'pointer', fontSize: 12, fontWeight: 600, whiteSpace:'nowrap' }}>
                    Add
                  </button>
                </div>
                {form.skills.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap: 6, marginTop: 8 }}>
                    {form.skills.map(sk => (
                      <span key={sk} style={{ background:'#f5f3ff', color:'#6B3FDB', padding:'3px 8px', borderRadius: 20, fontSize: 11, fontWeight: 500, display:'flex', alignItems:'center', gap: 4 }}>
                        {sk}
                        <button onClick={() => removeSkill(sk)} style={{ background:'none', border:'none', cursor:'pointer', color:'#a78bfa', padding: 0, lineHeight: 1, fontSize: 14 }}>×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Active toggle */}
              <div style={{ display:'flex', alignItems:'center', gap: 10 }}>
                <label style={{ ...labelStyle, margin: 0 }}>Active</label>
                <div onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
                  style={{ width: 44, height: 24, borderRadius: 12, background: form.is_active ? '#6B3FDB' : '#e5e7eb', cursor:'pointer', position:'relative', transition:'background .2s', flexShrink: 0 }}>
                  <div style={{ position:'absolute', top: 3, left: form.is_active ? 23 : 3, width: 18, height: 18, borderRadius: '50%', background:'#fff', transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.2)' }}/>
                </div>
              </div>
            </div>

            <div style={{ display:'flex', gap: 10, justifyContent:'flex-end', marginTop: 24 }}>
              <button onClick={() => setShowModal(false)}
                style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius: 8, background:'#fff', cursor:'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !form.pool_name.trim()}
                style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius: 8, cursor:'pointer', fontSize: 13, fontWeight: 600, opacity: (saving || !form.pool_name.trim()) ? 0.6 : 1 }}>
                {saving ? 'Saving…' : (editPool ? 'Save Changes' : 'Create Pool')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle = { display:'block', fontSize: 12, fontWeight: 600, color:'#374151', marginBottom: 4 };
const inputStyle  = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline:'none', boxSizing:'border-box', background:'#fff' };
