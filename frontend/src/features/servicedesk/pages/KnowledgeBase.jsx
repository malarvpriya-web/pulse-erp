import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Search, BookOpen, Plus, X, ChevronDown, ChevronUp } from 'lucide-react';

const EMPTY = { title:'', category:'Getting Started', content:'', tags:'' };
const CATS = ['All','Getting Started','HR Policy','IT Support','Finance','Operations','General'];

export default function KnowledgeBase() {
  const [articles, setArticles] = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [search,   setSearch]   = useState('');
  const [cat,      setCat]      = useState('All');
  const [expanded, setExpanded] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const toast = useToast();

  const load = () => {
    setLoading(true);
    api.get('/servicedesk/knowledge-base', { params: { limit:100 } })
      .then(r => setArticles(Array.isArray(r.data) ? r.data : []))
      .catch(() => setArticles([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const filtered = (articles || []).filter(a => {
    const matchCat    = cat === 'All' || (a?.category ?? 'General') === cat;
    const tagsStr     = Array.isArray(a?.tags) ? a.tags.join(',') : (a?.tags || '');
    const matchSearch = !search || [a?.title, a?.content, tagsStr, a?.category].some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
    return matchCat && matchSearch;
  });

  const handleSave = async () => {
    if (!form.title || !form.content) return;
    setSaving(true);
    try {
      await api.post('/servicedesk/knowledge-base', form);
      setShowForm(false); setForm(EMPTY); load();
      toast.success('Article published successfully');
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Save failed. Please try again.');
    } finally { setSaving(false); }
  };

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Knowledge Base</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>{articles.length} articles</p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
          <Plus size={15}/> New Article
        </button>
      </div>

      <div style={{ display:'flex', gap:12, marginBottom:20, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:1, minWidth:220 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search articles..."
            style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
        </div>
        {CATS.map(c => (
          <button key={c} onClick={() => setCat(c)}
            style={{ padding:'7px 12px', borderRadius:8, border:'1px solid', fontSize:12, fontWeight:500, cursor:'pointer',
              borderColor:cat===c?'#6B3FDB':'#e5e7eb', background:cat===c?'#6B3FDB':'#fff', color:cat===c?'#fff':'#374151' }}>
            {c}
          </button>
        ))}
      </div>

      {loading ? <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading...</div> :
       filtered.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:12, padding:60, textAlign:'center', border:'1px solid #f0f0f4' }}>
          <BookOpen size={40} color="#d1d5db" style={{ marginBottom:12 }}/>
          <p style={{ color:'#9ca3af', margin:'0 0 16px' }}>No articles found</p>
          <button onClick={() => setShowForm(true)} style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>Create First Article</button>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {filtered.map(a => {
            const tagList = Array.isArray(a?.tags) ? a.tags : (a?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            return (
            <div key={a.id} style={{ background:'#fff', borderRadius:10, border:'1px solid #f0f0f4', overflow:'hidden' }}>
              <div onClick={() => setExpanded(expanded===a.id ? null : a.id)}
                style={{ padding:'14px 20px', display:'flex', justifyContent:'space-between', alignItems:'center', cursor:'pointer' }}>
                <div style={{ flex:1 }}>
                  <p style={{ fontSize:14, fontWeight:600, color:'#1f2937', margin:'0 0 6px' }}>{a?.title ?? 'Untitled'}</p>
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
                    {(a?.category ?? 'General') && <span style={{ background:'#ede9fe', color:'#6B3FDB', padding:'2px 8px', borderRadius:20, fontSize:10, fontWeight:600 }}>{a?.category ?? 'General'}</span>}
                    {tagList.slice(0,2).map((t,i) => (
                      <span key={i} style={{ background:'#f3f4f6', color:'#6b7280', padding:'2px 7px', borderRadius:20, fontSize:10 }}>{t}</span>
                    ))}
                    {a?.updated_at && <span style={{ color:'#9ca3af', fontSize:10, marginLeft:'auto' }}>Updated {new Date(a.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>}
                  </div>
                </div>
                {expanded===a.id ? <ChevronUp size={16} color="#9ca3af"/> : <ChevronDown size={16} color="#9ca3af"/>}
              </div>
              {expanded===a.id && (
                <div style={{ padding:'0 20px 16px', borderTop:'1px solid #f5f3ff' }}>
                  <p style={{ fontSize:13, color:'#374151', lineHeight:1.7, margin:'12px 0 0', whiteSpace:'pre-wrap' }}>{a?.content ?? ''}</p>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:540, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:17, fontWeight:700, color:'#1f2937', margin:0 }}>New Article</h2>
              <button onClick={() => setShowForm(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>
            <div style={{ display:'grid', gap:14 }}>
              {[{ label:'Title *', key:'title', placeholder:'Article title' },
                { label:'Tags', key:'tags', placeholder:'comma, separated, tags' }].map(f => (
                <div key={f.key}>
                  <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>{f.label}</label>
                  <input value={form[f.key]} onChange={e => setForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.placeholder}
                    style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                </div>
              ))}
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Category</label>
                <select value={form.category} onChange={e => setForm(p=>({...p,category:e.target.value}))}
                  style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none' }}>
                  {CATS.filter(c=>c!=='All').map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>Content *</label>
                <textarea value={form.content} onChange={e => setForm(p=>({...p,content:e.target.value}))} rows={8} placeholder="Write the article content here..."
                  style={{ width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', resize:'vertical', boxSizing:'border-box' }}/>
              </div>
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:20 }}>
              <button onClick={() => setShowForm(false)} style={{ padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving||!form.title||!form.content}
                style={{ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:(saving||!form.title||!form.content)?.6:1 }}>
                {saving?'Saving...':'Publish Article'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}