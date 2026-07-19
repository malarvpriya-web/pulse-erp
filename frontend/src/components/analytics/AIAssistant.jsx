// frontend/src/components/analytics/AIAssistant.jsx
import { useState, useRef, useEffect, useCallback } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import api from '@/services/api/client';

/* ─── helpers ──────────────────────────────────────────────────── */
function formatINR(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '₹0';
  if (num >= 10000000) return `₹${(num/10000000).toFixed(2)} Cr`;
  if (num >= 100000)   return `₹${(num/100000).toFixed(2)}L`;
  return `₹${Math.round(num).toLocaleString('en-IN')}`;
}

const QUICK_CHIPS = [
  { label:'Cash position today',   msg:'What is the cash position today?' },
  { label:'Who is on leave?',      msg:'Who is on leave this week?' },
  { label:'Overdue invoices',      msg:'Show me all overdue invoices' },
  { label:'Low stock items',       msg:'Which inventory items are low on stock?' },
  { label:'Pending approvals',     msg:'How many approvals are pending?' },
  { label:'Revenue this month',    msg:'What is the revenue this month?' },
  { label:'Payroll summary',       msg:'Show payroll summary this month' },
];

/* ─── response renderers ─────────────────────────────────────────── */
function NumberCard({ answer }) {
  return (
    <div style={{ background:'#f5f3ff', borderRadius:10, padding:'16px 20px', border:'1px solid #e9e4ff', marginTop:8 }}>
      <div style={{ fontSize:13, color:'#374151', lineHeight:1.6 }}>{answer}</div>
    </div>
  );
}

function TableResponse({ data }) {
  if (!data?.length) return null;
  const keys = Object.keys(data[0]).filter(k => !['id'].includes(k)).slice(0, 5);
  return (
    <div style={{ overflowX:'auto', marginTop:8 }}>
      <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
        <thead>
          <tr style={{ background:'#f5f3ff' }}>
            {keys.map(k => <th key={k} style={{ padding:'6px 8px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600, textTransform:'capitalize', whiteSpace:'nowrap' }}>{k.replace(/_/g,' ')}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.slice(0,8).map((row, i) => (
            <tr key={i} style={{ borderBottom:'1px solid #f0ebff' }}>
              {keys.map(k => (
                <td key={k} style={{ padding:'5px 8px', color:'#374151', whiteSpace:'nowrap' }}>
                  {typeof row[k] === 'number' && row[k] > 10000 ? formatINR(row[k]) : String(row[k] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > 8 && <p style={{ fontSize:11, color:'#9ca3af', margin:'4px 0 0', textAlign:'right' }}>+{data.length-8} more rows</p>}
    </div>
  );
}

function BarResponse({ data }) {
  if (!data?.length) return null;
  const keys = Object.keys(data[0]);
  const nameKey  = keys.find(k => typeof data[0][k] === 'string') || keys[0];
  const valueKey = keys.find(k => typeof data[0][k] === 'number') || keys[1];
  return (
    <div style={{ marginTop:8, height:180 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data.slice(0,8)} margin={{ top:4, right:8, left:0, bottom:20 }}>
          <XAxis dataKey={nameKey} tick={{ fontSize:10 }} angle={-35} textAnchor="end" />
          <YAxis tick={{ fontSize:10 }} tickFormatter={v => v >= 100000 ? `₹${(v/100000).toFixed(1)}L` : v} />
          <Tooltip formatter={(v, n) => [typeof v === 'number' && v > 1000 ? formatINR(v) : v, n.replace(/_/g,' ')]} />
          <Bar dataKey={valueKey} fill="#7c3aed" radius={[4,4,0,0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LineResponse({ data }) {
  if (!data?.length) return null;
  const keys = Object.keys(data[0]);
  const nameKey  = keys.find(k => typeof data[0][k] === 'string') || keys[0];
  const valueKey = keys.find(k => typeof data[0][k] === 'number') || keys[1];
  return (
    <div style={{ marginTop:8, height:180 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top:4, right:8, left:0, bottom:20 }}>
          <XAxis dataKey={nameKey} tick={{ fontSize:10 }} angle={-35} textAnchor="end" />
          <YAxis tick={{ fontSize:10 }} tickFormatter={v => v >= 100000 ? `₹${(v/100000).toFixed(1)}L` : v} />
          <Tooltip formatter={(v) => [formatINR(v), 'Revenue']} />
          <Line type="monotone" dataKey={valueKey} stroke="#7c3aed" strokeWidth={2} dot={{ r:3, fill:'#7c3aed' }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{ display:'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom:12 }}>
      <div style={{ maxWidth:'90%' }}>
        {!isUser && (
          <div style={{ fontSize:10, color:'#9ca3af', marginBottom:3, paddingLeft:4 }}>Pulse AI</div>
        )}
        <div style={{
          background: isUser ? '#7c3aed' : '#fff',
          color:       isUser ? '#fff'    : '#1f2937',
          borderRadius: isUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
          padding:'10px 14px',
          fontSize:13, lineHeight:1.5,
          border: isUser ? 'none' : '1px solid #e9e4ff',
          boxShadow:'0 1px 4px rgba(0,0,0,0.06)',
        }}>
          {msg.content}
        </div>
        {/* chart / table response */}
        {msg.chart_type === 'table' && <TableResponse data={msg.data} />}
        {msg.chart_type === 'bar'   && <BarResponse   data={msg.data} />}
        {msg.chart_type === 'line'  && <LineResponse  data={msg.data} />}
        {msg.chart_type === 'number'&& msg.data?.length > 0 && (
          <div style={{ marginTop:6 }}>
            {msg.data.map((d,i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom:'1px solid #f0ebff', fontSize:12 }}>
                <span style={{ color:'#6b7280' }}>{d.label || d.type}</span>
                <span style={{ fontWeight:700, color:'#4c1d95' }}>{typeof d.value === 'number' ? formatINR(d.value) : d.value || d.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── main component ─────────────────────────────────────────────── */
export default function AIAssistant() {
  const [open, setOpen]       = useState(false);
  const [messages, setMessages] = useState([
    { role:'assistant', content:'Hi! I\'m Pulse AI. Ask me anything about your ERP — leaves, cash, inventory, revenue, or employees.', chart_type:null, data:[] },
  ]);
  const [input, setInput]     = useState('');
  const [loading, setLoading] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchRes, setSearchRes] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('chat');
  const bottomRef = useRef(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior:'smooth' });
  }, [messages, open]);

  const sendMessage = useCallback(async (text) => {
    const userMsg = text || input.trim();
    if (!userMsg || loading) return;
    setInput('');
    setMessages(m => [...m, { role:'user', content:userMsg, chart_type:null, data:[] }]);


    try {
      const res = await api.post('/ai/chat', { message: userMsg });
      const { answer, data, chart_type } = res.data;
      setMessages(m => [...m, { role:'assistant', content:answer, chart_type, data: data || [] }]);
    } catch {
      setMessages(m => [...m, { role:'assistant', content:'The AI assistant is temporarily unavailable. Please try again later or contact your administrator.', chart_type:null, data:[] }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  const handleSearch = async () => {
    if (!searchQ.trim()) return;

    try {
      const res = await api.get(`/ai/smart-search?q=${encodeURIComponent(searchQ)}`);
      setSearchRes(res.data);
    } catch {
      setSearchRes({ results:{}, total_hits:0, query:searchQ });
    } finally {
      setSearchLoading(false);
    }
  };

  const ENTITY_ICONS = { employees:'👤', invoices:'🧾', projects:'📋', leads:'🎯', inventory:'📦' };

  /* ── floating button ── */
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} title="Pulse AI Assistant"
        style={{ position:'fixed', bottom:28, right:28, width:56, height:56, borderRadius:'50%', background:'#7c3aed', color:'#fff', border:'none', cursor:'pointer', fontSize:24, display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 4px 20px rgba(124,58,237,0.45)', zIndex:9000, transition:'transform .15s' }}
        onMouseEnter={e => e.currentTarget.style.transform='scale(1.08)'}
        onMouseLeave={e => e.currentTarget.style.transform='scale(1)'}>
        🧠
      </button>
    );
  }

  /* ── drawer ── */
  return (
    <div style={{ position:'fixed', bottom:0, right:0, width:420, height:'92vh', background:'#fff', borderLeft:'1px solid #e9e4ff', borderTop:'1px solid #e9e4ff', borderRadius:'12px 0 0 0', boxShadow:'-4px 0 24px rgba(124,58,237,0.15)', zIndex:9000, display:'flex', flexDirection:'column' }}>

      {/* header */}
      <div style={{ background:'#7c3aed', padding:'14px 18px', borderRadius:'12px 0 0 0', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:22 }}>🧠</span>
          <div>
            <div style={{ color:'#fff', fontWeight:700, fontSize:15 }}>Pulse AI</div>
            <div style={{ color:'#c4b5fd', fontSize:11 }}>ERP Intelligence Assistant</div>
          </div>
        </div>
        <div style={{ display:'flex', gap:6 }}>
          <button onClick={() => setMessages([messages[0]])} title="Clear chat"
            style={{ background:'rgba(255,255,255,0.15)', color:'#fff', border:'none', borderRadius:6, padding:'4px 10px', cursor:'pointer', fontSize:12 }}>
            Clear
          </button>
          <button onClick={() => setOpen(false)}
            style={{ background:'rgba(255,255,255,0.15)', color:'#fff', border:'none', borderRadius:6, padding:'4px 10px', cursor:'pointer', fontSize:18, lineHeight:1 }}>
            ×
          </button>
        </div>
      </div>

      {/* tabs */}
      <div style={{ display:'flex', borderBottom:'1px solid #e9e4ff' }}>
        {[['chat','💬 Chat'],['search','🔍 Search']].map(([k,l]) => (
          <button key={k} onClick={() => setActiveTab(k)}
            style={{ flex:1, padding:'8px 0', border:'none', cursor:'pointer', fontSize:13, fontWeight:600,
              background: activeTab===k ? '#f5f3ff' : '#fff',
              color:      activeTab===k ? '#7c3aed' : '#6b7280',
              borderBottom: activeTab===k ? '2px solid #7c3aed' : '2px solid transparent' }}>
            {l}
          </button>
        ))}
      </div>

      {/* ── CHAT TAB ── */}
      {activeTab === 'chat' && (
        <>
          <div style={{ flex:1, overflowY:'auto', padding:'12px 14px' }}>
            {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}
            {loading && (
              <div style={{ display:'flex', gap:6, padding:'10px 14px' }}>
                {[0,1,2].map(i => (
                  <div key={i} style={{ width:8, height:8, borderRadius:'50%', background:'#7c3aed', animation:'bounce 1.2s infinite', animationDelay:`${i*0.2}s` }} />
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* quick chips */}
          <div style={{ padding:'8px 14px', overflowX:'auto', whiteSpace:'nowrap', borderTop:'1px solid #f0ebff' }}>
            {QUICK_CHIPS.map((c,i) => (
              <button key={i} onClick={() => sendMessage(c.msg)} disabled={loading}
                style={{ display:'inline-block', marginRight:6, padding:'4px 10px', borderRadius:20, border:'1px solid #e9e4ff', background:'#f5f3ff', color:'#4c1d95', fontSize:11, cursor:'pointer', fontWeight:500, whiteSpace:'nowrap' }}>
                {c.label}
              </button>
            ))}
          </div>

          {/* input */}
          <div style={{ padding:'10px 14px', borderTop:'1px solid #e9e4ff', display:'flex', gap:8 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="Ask about leaves, cash, inventory…"
              disabled={loading}
              style={{ flex:1, padding:'9px 12px', border:'1px solid #e9e4ff', borderRadius:8, fontSize:13, outline:'none' }}
            />
            <button onClick={() => sendMessage()} disabled={loading || !input.trim()}
              style={{ background:'#7c3aed', color:'#fff', border:'none', borderRadius:8, padding:'9px 14px', cursor:'pointer', fontWeight:700, fontSize:14, opacity: loading || !input.trim() ? 0.5 : 1 }}>
              ↑
            </button>
          </div>
        </>
      )}

      {/* ── SEARCH TAB ── */}
      {activeTab === 'search' && (
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'12px 14px', borderBottom:'1px solid #e9e4ff', display:'flex', gap:8 }}>
            <input value={searchQ} onChange={e => setSearchQ(e.target.value)} onKeyDown={e => e.key==='Enter' && handleSearch()}
              placeholder="Search employees, invoices, projects…"
              style={{ flex:1, padding:'8px 12px', border:'1px solid #e9e4ff', borderRadius:8, fontSize:13 }} />
            <button onClick={handleSearch} disabled={searchLoading}
              style={{ background:'#7c3aed', color:'#fff', border:'none', borderRadius:8, padding:'8px 14px', cursor:'pointer', fontWeight:700 }}>
              {searchLoading ? '…' : '🔍'}
            </button>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'12px 14px' }}>
            {searchRes && (
              <>
                <div style={{ fontSize:12, color:'#6b7280', marginBottom:10 }}>
                  {searchRes.total_hits} result(s) for "{searchRes.query}"
                </div>
                {Object.entries(searchRes.results || {}).filter(([k]) => k !== '_fallback').map(([entity, rows]) => (
                  <div key={entity} style={{ marginBottom:16 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:'#4c1d95', marginBottom:6, textTransform:'capitalize' }}>
                      {ENTITY_ICONS[entity] || '📄'} {entity} ({rows.length})
                    </div>
                    {rows.map((row, i) => (
                      <div key={i} style={{ padding:'8px 10px', background:'#f5f3ff', borderRadius:8, marginBottom:4, fontSize:12 }}>
                        {Object.entries(row).filter(([k]) => !['id'].includes(k)).slice(0,3).map(([k,v]) => (
                          <span key={k} style={{ marginRight:10 }}>
                            <strong style={{ color:'#7c3aed' }}>{k.replace(/_/g,' ')}:</strong>{' '}
                            <span style={{ color:'#374151' }}>{typeof v === 'number' && v > 10000 ? formatINR(v) : String(v ?? '—')}</span>
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
            {!searchRes && !searchLoading && (
              <div style={{ textAlign:'center', padding:40, color:'#9ca3af', fontSize:13 }}>
                Search across employees, invoices, projects, leads, and inventory.
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`@keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }`}</style>
    </div>
  );
}
