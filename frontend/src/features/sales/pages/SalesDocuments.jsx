import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { FileText, Download, Search, Upload, Trash2, X } from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const DOC_TYPES  = ['Proposal','Contract','Brochure','Presentation','Other'];
const ALL_TABS   = ['All', ...DOC_TYPES];
const TYPE_COLOR = { Proposal:'#6366f1', Contract:'#10b981', Brochure:'#f59e0b', Presentation:'#ef4444', Other:'#6b7280' };

export default function SalesDocuments() {
  const toast = useToast();
  const [docs,       setDocs]       = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState('');
  const [activeTab,  setActiveTab]  = useState('All');
  const [showUpload, setShowUpload] = useState(false);
  const [form,       setForm]       = useState({ name:'', type:'Other', customer_name:'', file_url:'' });
  const [saving,     setSaving]     = useState(false);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);

  function load() {
    setLoading(true);
    api.get('/sales/documents', { params:{ limit:200 } })
      .then(r => setDocs(Array.isArray(r.data) ? r.data : []))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const filtered = docs.filter(d => {
    const matchType = activeTab === 'All' || (d.type || 'Other') === activeTab;
    const matchSearch = !search || [d.name, d.type, d.customer_name].some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
    return matchType && matchSearch;
  });

  async function handleUpload(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const res = await api.post('/sales/documents', form);
      setDocs(prev => [res.data, ...prev]);
      setShowUpload(false);
      setForm({ name:'', type:'Other', customer_name:'', file_url:'' });
      toast.success('Document added');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save document');
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/sales/documents/${id}`);
      setDocs(prev => prev.filter(d => d.id !== id));
      toast.success('Document deleted');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete document');
    }
  }

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Document"
        message="Delete this document?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Sales Documents</h1>
        <button onClick={() => setShowUpload(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Upload size={14}/> Upload Document
        </button>
      </div>

      {/* Type filter tabs */}
      <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap' }}>
        {ALL_TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            style={{ padding:'5px 14px', borderRadius:20, fontSize:12, fontWeight:600, cursor:'pointer', border:'none',
              background: activeTab === tab ? '#6B3FDB' : '#f3f4f6',
              color:      activeTab === tab ? '#fff'    : '#374151' }}>
            {tab}
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{ position:'relative', marginBottom:14, maxWidth:320 }}>
        <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search documents..."
          style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
          <FileText size={40} color="#d1d5db" style={{ marginBottom:12 }}/>
          <p style={{ color:'#9ca3af' }}>No documents found. Upload proposals, contracts, and more here.</p>
        </div>
      ) : (
        <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Document Name','Type','Customer','Size','Uploaded','Actions'].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d, i) => {
                const tc = TYPE_COLOR[d.type] || '#6b7280';
                return (
                  <tr key={d.id || i} style={{ borderBottom:'1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding:'10px 16px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <FileText size={16} color={tc}/>
                        <span style={{ fontWeight:500, color:'#1f2937' }}>{d.name || '—'}</span>
                      </div>
                    </td>
                    <td style={{ padding:'10px 16px' }}>
                      <span style={{ background: tc + '18', color:tc, padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:600 }}>{d.type || 'Other'}</span>
                    </td>
                    <td style={{ padding:'10px 16px', color:'#6b7280' }}>{d.customer_name || '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#9ca3af', fontSize:12 }}>{d.file_size ? `${(d.file_size / 1024).toFixed(0)} KB` : '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#374151' }}>{(d.created_at || '').slice(0, 10)}</td>
                    <td style={{ padding:'10px 16px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        {d.file_url && (
                          <a href={d.file_url} target="_blank" rel="noopener noreferrer"
                            style={{ display:'flex', alignItems:'center', gap:4, padding:'5px 10px', background:'#ede9fe', color:'#6B3FDB', borderRadius:6, textDecoration:'none', fontSize:12, fontWeight:600 }}>
                            <Download size={11}/> Download
                          </a>
                        )}
                        <button onClick={() => setPendingHandleDelete(d.id)}
                          style={{ background:'#fee2e2', color:'#ef4444', border:'none', borderRadius:6, padding:'5px 8px', cursor:'pointer', display:'flex', alignItems:'center' }}>
                          <Trash2 size={12}/>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showUpload && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:28, width:420, boxShadow:'0 8px 32px rgba(0,0,0,.18)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h3 style={{ margin:0, fontSize:16, fontWeight:700, color:'#1f2937' }}>Add Document</h3>
              <button onClick={() => setShowUpload(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#6b7280' }}><X size={18}/></button>
            </div>
            <form onSubmit={handleUpload} style={{ display:'flex', flexDirection:'column', gap:14 }}>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Document Name *</label>
                <input required value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))}
                  placeholder="e.g. Client Proposal Q2"
                  style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Type</label>
                <select value={form.type} onChange={e => setForm(f => ({...f, type: e.target.value}))}
                  style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', background:'#fff', boxSizing:'border-box' }}>
                  {['Proposal','Contract','Brochure','Presentation','Other'].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Customer</label>
                <input value={form.customer_name} onChange={e => setForm(f => ({...f, customer_name: e.target.value}))}
                  placeholder="e.g. Acme Corp"
                  style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div>
                <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>File URL</label>
                <input value={form.file_url} onChange={e => setForm(f => ({...f, file_url: e.target.value}))}
                  placeholder="https://... or leave blank"
                  style={{ width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:4 }}>
                <button type="button" onClick={() => setShowUpload(false)}
                  style={{ padding:'8px 18px', background:'#f5f5f5', border:'1px solid #e0e0e0', borderRadius:8, cursor:'pointer', fontSize:13 }}>Cancel</button>
                <button type="submit" disabled={saving}
                  style={{ padding:'8px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor: saving ? 'not-allowed' : 'pointer', fontWeight:600, fontSize:13, opacity: saving ? 0.7 : 1 }}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
