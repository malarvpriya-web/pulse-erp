// frontend/src/features/admin/pages/APIDocumentation.jsx
import { useState } from 'react';
import { Code2, Copy, Check, Download, FileX } from 'lucide-react';
import api from '@/services/api/client';

const LOCAL_API   = import.meta.env.VITE_API_URL       || 'http://localhost:5000/api';
const STAGING_API = import.meta.env.VITE_API_URL_STAGING    || '';
const PROD_API    = import.meta.env.VITE_API_URL_PRODUCTION  || '';

const ENVS = Object.fromEntries(
  [
    ['Local',      `${LOCAL_API}/docs`],
    STAGING_API && ['Staging',    `${STAGING_API}/docs`],
    PROD_API    && ['Production', `${PROD_API}/docs`],
  ].filter(Boolean)
);

const ENDPOINT_STATS = [
  { method:'GET',    count:47, color:'#16a34a', bg:'#d1fae5' },
  { method:'POST',   count:28, color:'#2563eb', bg:'#dbeafe' },
  { method:'PUT',    count:18, color:'#d97706', bg:'#fef3c7' },
  { method:'DELETE', count:9,  color:'#dc2626', bg:'#fee2e2' },
  { method:'PATCH',  count:6,  color:'#6B3FDB', bg:'#ede9fe' },
];

export default function APIDocumentation() {
  const [env, setEnv]           = useState('Local');
  const [copied, setCopied]     = useState(false);
  const [iframeLoaded, setLoaded] = useState(false);
  const [iframeError, setIframeError] = useState(false);

  const baseURL = ENVS[env]?.replace('/docs', '') || 'http://localhost:5000/api';
  const docsURL = ENVS[env];

  const copyBase = () => {
    navigator.clipboard.writeText(baseURL).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadSpec = async () => {
    try {
      const res = await api.get('/docs/json');
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = 'pulse-erp-openapi.json'; a.click();
      URL.revokeObjectURL(url);
    } catch {
      // fallback: open in new tab
      window.open('/api/docs/json', '_blank');
    }
  };

  return (
    <div style={{ padding:24, background:'#fff', minHeight:'100vh', display:'flex', flexDirection:'column' }}>
      {/* header */}
      <div className="page-header" style={{ marginBottom:20, display:'flex', alignItems:'center', gap:10 }}>
        <Code2 size={22} color="var(--color-text-primary, #111827)" />
        <div>
          <h1 className="page-title" style={{ margin:0 }}>API Documentation</h1>
          <p className="page-subtitle" style={{ margin:0 }}>
            Interactive Swagger UI — explore and test all Pulse ERP endpoints
          </p>
        </div>
      </div>

      {/* stats */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
        {ENDPOINT_STATS.map(({ method, count, color, bg }) => (
          <div key={method} style={{ padding:'6px 14px', borderRadius:20, background:bg, display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ fontWeight:700, color, fontSize:12 }}>{method}</span>
            <span style={{ fontWeight:600, color:'#374151', fontSize:12 }}>{count} endpoints</span>
          </div>
        ))}
        <div style={{ padding:'6px 14px', borderRadius:20, background:'#f5f3ff', border:'1px solid #e9e4ff', display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontWeight:700, color:'#6B3FDB', fontSize:12 }}>TOTAL</span>
          <span style={{ fontWeight:600, color:'#374151', fontSize:12 }}>
            {ENDPOINT_STATS.reduce((s,e)=>s+e.count,0)} endpoints
          </span>
        </div>
      </div>

      {/* toolbar */}
      <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:'12px 16px', display:'flex', alignItems:'center', gap:12, marginBottom:0, flexWrap:'wrap' }}>
        {/* base URL */}
        <div style={{ display:'flex', alignItems:'center', gap:8, flex:1, minWidth:200 }}>
          <span style={{ fontSize:12, color:'#6b7280', whiteSpace:'nowrap' }}>Base URL:</span>
          <code style={{ background:'#f5f3ff', padding:'4px 10px', borderRadius:6, fontSize:12, color:'#4c1d95', fontFamily:'monospace', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {baseURL}
          </code>
          <button onClick={copyBase}
            style={{ display:'flex', alignItems:'center', gap:4, background:'#ede9fe', color:'#6B3FDB', border:'none', borderRadius:7, padding:'5px 12px', cursor:'pointer', fontWeight:600, fontSize:12, whiteSpace:'nowrap' }}>
            {copied ? <><Check size={13}/>Copied</> : <><Copy size={13}/>Copy</>}
          </button>
        </div>

        {/* divider */}
        <div style={{ width:1, height:24, background:'#e9e4ff' }} />

        {/* env switcher */}
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:12, color:'#6b7280' }}>Env:</span>
          {Object.keys(ENVS).map(e => (
            <button key={e} onClick={() => { setEnv(e); setLoaded(false); setIframeError(false); }}
              style={{
                padding:'4px 12px', border:'none', borderRadius:20, cursor:'pointer', fontWeight:600, fontSize:12,
                background: env===e ? '#6B3FDB' : '#f3f4f6',
                color:      env===e ? '#fff'    : '#6b7280',
              }}>
              {e}
            </button>
          ))}
        </div>

        {/* download */}
        <button onClick={downloadSpec}
          style={{ display:'flex', alignItems:'center', gap:6, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'7px 16px', cursor:'pointer', fontWeight:600, fontSize:13, whiteSpace:'nowrap' }}>
          <Download size={14}/>Download OpenAPI JSON
        </button>
      </div>

      {/* iframe */}
      <div style={{ flex:1, marginTop:0, border:'1px solid #e9e4ff', borderTop:'none', borderRadius:'0 0 10px 10px', background:'#fff', position:'relative', minHeight:600 }}>
        {!iframeLoaded && !iframeError && (
          <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'#fff', zIndex:1 }}>
            <div style={{ width:40, height:40, border:'3px solid #e9e4ff', borderTop:'3px solid #6B3FDB', borderRadius:'50%', animation:'spin 0.8s linear infinite', marginBottom:12 }} />
            <p style={{ color:'#6B3FDB', fontWeight:600 }}>Loading Swagger UI…</p>
            <p style={{ color:'#9ca3af', fontSize:12 }}>Make sure the backend is running</p>
          </div>
        )}
        {iframeError && (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:60, textAlign:'center' }}>
            <FileX size={48} color="#d1d5db" style={{ marginBottom:16 }} />
            <h3 style={{ color:'#111827', margin:'0 0 8px' }}>Swagger UI Not Available</h3>
            <p style={{ color:'#6b7280', maxWidth:400, margin:'0 0 20px', fontSize:14 }}>
              Install swagger-ui-express on the backend to view the interactive documentation:
            </p>
            <code style={{ background:'#1e1e2e', color:'#cdd6f4', padding:'10px 20px', borderRadius:8, fontSize:13, display:'block', marginBottom:20 }}>
              cd backend && npm install swagger-ui-express
            </code>
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={downloadSpec}
                style={{ display:'flex', alignItems:'center', gap:6, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:700 }}>
                <Download size={14}/>Download OpenAPI JSON
              </button>
              <a href="https://swagger.io/tools/swagger-ui/" target="_blank" rel="noopener noreferrer"
                style={{ background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 20px', cursor:'pointer', fontWeight:700, textDecoration:'none', display:'flex', alignItems:'center' }}>
                Swagger UI Docs ↗
              </a>
            </div>
          </div>
        )}
        {!iframeError && (
          <iframe
            src={docsURL}
            title="Pulse ERP API Documentation"
            style={{ width:'100%', height:'100%', minHeight:600, border:'none', borderRadius:'0 0 10px 10px', display: iframeLoaded ? 'block' : 'none' }}
            onLoad={() => setLoaded(true)}
            onError={() => { setIframeError(true); setLoaded(false); }}
          />
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
