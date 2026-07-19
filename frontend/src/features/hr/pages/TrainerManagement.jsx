// frontend/src/features/hr/pages/TrainerManagement.jsx
import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const inputStyle = { width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 };

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:'#fff', borderRadius:12, padding:24, width:'100%', maxWidth:520, maxHeight:'85vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <h3 style={{ margin:0, color:'#4c1d95', fontSize:16 }}>{title}</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:20, color:'#6b7280' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function TrainerManagement() {
  const toast = useToast();
  const [trainers, setTrainers] = useState([]);
  const [selectedTrainer, setSelectedTrainer] = useState(null);
  const [trainerPrograms, setTrainerPrograms] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editTrainer, setEditTrainer] = useState(null);
  const [showPrograms, setShowPrograms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ name:'', trainer_type:'internal', employee_id:'', email:'', phone:'', specialization:'' });
  const [pendingDeactivate, setPendingDeactivate] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/trainers');
      setTrainers(r.data || []);
    } catch { setTrainers([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveTrainer = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (editTrainer) {
        await api.put(`/trainers/${editTrainer.id}`, form);
        toast.success('Trainer updated');
      } else {
        await api.post('/trainers', form);
        toast.success('Trainer added');
      }
      setShowForm(false); setEditTrainer(null);
      setForm({ name:'', trainer_type:'internal', employee_id:'', email:'', phone:'', specialization:'' });
      load();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const deactivate = async () => {
    if (!pendingDeactivate) return;
    const id = pendingDeactivate;
    setPendingDeactivate(null);
    try { await api.delete(`/trainers/${id}`); toast.success('Deactivated'); load(); }
    catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
  };

  const openPrograms = async (trainer) => {
    setSelectedTrainer(trainer);
    try {
      const r = await api.get(`/trainers/${trainer.id}/programs`);
      setTrainerPrograms(r.data || []);
    } catch { setTrainerPrograms([]); }
    setShowPrograms(true);
  };

  const filtered = trainers.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    (t.specialization || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh' }}>
      <ConfirmDialog
        open={!!pendingDeactivate}
        title="Deactivate Trainer"
        message="Deactivate this trainer? They will be removed from future training programs."
        confirmLabel="Deactivate"
        variant="warning"
        onConfirm={deactivate}
        onCancel={() => setPendingDeactivate(null)}
      />
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20, flexWrap:'wrap', gap:10 }}>
        <div>
          <h2 style={{ margin:0, color:'#4c1d95', fontSize:22 }}>👨‍🏫 Trainer Management</h2>
          <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Internal and external trainers, programs delivered, ratings</p>
        </div>
        <button onClick={() => { setShowForm(true); setEditTrainer(null); setForm({ name:'', trainer_type:'internal', employee_id:'', email:'', phone:'', specialization:'' }); }}
          style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', cursor:'pointer', fontWeight:600 }}>
          + Add Trainer
        </button>
      </div>

      <div style={{ marginBottom:16, maxWidth:400 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or specialization…" style={inputStyle} />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:16 }}>
        {filtered.map(t => (
          <div key={t.id} style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:12, padding:20 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:8 }}>
              <div>
                <div style={{ fontWeight:700, color:'#1f2937', fontSize:15 }}>{t.name}</div>
                {t.employee_full_name && t.employee_full_name !== t.name && (
                  <div style={{ fontSize:11, color:'#9ca3af', marginTop:1 }}>({t.employee_full_name})</div>
                )}
              </div>
              <span style={{ fontSize:11, padding:'2px 8px', borderRadius:10, fontWeight:600, background: t.trainer_type==='internal' ? '#e9e4ff' : '#fef3c7', color: t.trainer_type==='internal' ? '#6B3FDB' : '#d97706' }}>
                {t.trainer_type}
              </span>
            </div>
            {t.specialization && <p style={{ fontSize:12, color:'#6b7280', margin:'0 0 10px' }}>Specialization: {t.specialization}</p>}
            <div style={{ display:'flex', gap:16, fontSize:12, color:'#6b7280', marginBottom:12, flexWrap:'wrap' }}>
              {t.email && <span>✉ {t.email}</span>}
              {t.phone && <span>📞 {t.phone}</span>}
              <span>Programs: <strong>{t.programs_count || 0}</strong></span>
            </div>
            <div style={{ display:'flex', gap:6 }}>
              <button onClick={() => openPrograms(t)} style={{ padding:'5px 12px', background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Programs</button>
              <button onClick={() => { setEditTrainer(t); setForm({ name:t.name, trainer_type:t.trainer_type, employee_id:t.employee_id||'', email:t.email||'', phone:t.phone||'', specialization:t.specialization||'' }); setShowForm(true); }} style={{ padding:'5px 12px', background:'#f5f3ff', color:'#6b7280', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Edit</button>
              <button onClick={() => setPendingDeactivate(t.id)} style={{ padding:'5px 12px', background:'#fef2f2', color:'#dc2626', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Deactivate</button>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ gridColumn:'1/-1', textAlign:'center', padding:'48px 0', color:'#9ca3af' }}>No trainers found</div>
        )}
      </div>

      {/* Add/Edit modal */}
      {showForm && (
        <Modal title={editTrainer ? 'Edit Trainer' : 'Add Trainer'} onClose={() => { setShowForm(false); setEditTrainer(null); }}>
          <form onSubmit={saveTrainer}>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Full Name *</label>
              <input required value={form.name} onChange={e => setForm(f => ({...f, name:e.target.value}))} style={inputStyle} />
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Type</label>
              <select value={form.trainer_type} onChange={e => setForm(f => ({...f, trainer_type:e.target.value}))} style={inputStyle}>
                <option value="internal">Internal</option>
                <option value="external">External</option>
              </select>
            </div>
            {form.trainer_type === 'internal' && (
              <div style={{ marginBottom:12 }}>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Employee ID</label>
                <input value={form.employee_id} onChange={e => setForm(f => ({...f, employee_id:e.target.value}))} style={inputStyle} placeholder="Link to employee record" />
              </div>
            )}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Email</label>
                <input type="email" value={form.email} onChange={e => setForm(f => ({...f, email:e.target.value}))} style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Phone</label>
                <input value={form.phone} onChange={e => setForm(f => ({...f, phone:e.target.value}))} style={inputStyle} />
              </div>
            </div>
            <div style={{ marginBottom:16 }}>
              <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>Specialization</label>
              <input value={form.specialization} onChange={e => setForm(f => ({...f, specialization:e.target.value}))} style={inputStyle} placeholder="e.g. Safety, Six Sigma, Leadership" />
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <button type="submit" disabled={loading} style={{ flex:1, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>
                {loading ? 'Saving…' : editTrainer ? 'Update' : 'Add Trainer'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditTrainer(null); }} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Programs modal */}
      {showPrograms && selectedTrainer && (
        <Modal title={`Programs by ${selectedTrainer.name}`} onClose={() => setShowPrograms(false)}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead><tr style={{ background:'#f5f3ff' }}>
              {['Program','Category','Date','Enrolled','Completed','Avg Rating'].map(h => (
                <th key={h} style={{ padding:'8px 10px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, fontSize:12 }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {trainerPrograms.map(p => (
                <tr key={p.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                  <td style={{ padding:'8px 10px', fontWeight:600, fontSize:12 }}>{p.title}</td>
                  <td style={{ padding:'8px 10px', color:'#6b7280', fontSize:12 }}>{p.category}</td>
                  <td style={{ padding:'8px 10px', fontSize:12 }}>{p.scheduled_date || '—'}</td>
                  <td style={{ padding:'8px 10px', fontSize:12 }}>{p.enrolled_count || 0}</td>
                  <td style={{ padding:'8px 10px', fontSize:12 }}>{p.completed_count || 0}</td>
                  <td style={{ padding:'8px 10px', fontWeight:700, color:'#d97706', fontSize:12 }}>{p.avg_rating ? `${p.avg_rating} ⭐` : '—'}</td>
                </tr>
              ))}
              {trainerPrograms.length === 0 && <tr><td colSpan={6} style={{ padding:'24px', textAlign:'center', color:'#9ca3af' }}>No programs delivered yet</td></tr>}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
