/**
 * KnowledgeBase — the governed knowledge workspace.
 *
 * Reads /servicedesk/knowledge (the workflow surface) rather than the legacy
 * /knowledge-base CRUD. What changed for the person using it: an article is now
 * a draft until somebody else approves it, editing a live article takes it off
 * the portal, and "was this article any good" is a measured number rather than
 * an impression.
 *
 * Every lifecycle button is offered from the server's own transition table, so
 * the UI cannot present a move the API will refuse — and when the API does
 * refuse (self-approval, missing role), the reason is surfaced verbatim instead
 * of a generic failure toast.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  Search, BookOpen, Plus, X, ChevronDown, ChevronUp, LifeBuoy,
  Send, Check, Ban, Globe, Archive, History, Eye, ThumbsUp, ThumbsDown, Lock,
} from 'lucide-react';
import { PageHero, PageShell } from '@/components/pulse-ui';

const EMPTY = { title: '', category: 'Getting Started', content: '', summary: '', tags: '', visibility: 'internal' };
const CATS = ['All', 'Getting Started', 'HR Policy', 'IT Support', 'Finance', 'Operations', 'General'];

/** Every state an article can be in, with the colour that carries its meaning. */
const STATES = {
  draft:     { label: 'Draft',       fg: '#6b7280', bg: '#f3f4f6' },
  in_review: { label: 'In review',   fg: '#b45309', bg: '#fef3c7' },
  approved:  { label: 'Approved',    fg: '#1d4ed8', bg: '#dbeafe' },
  published: { label: 'Published',   fg: '#047857', bg: '#d1fae5' },
  rejected:  { label: 'Rejected',    fg: '#b91c1c', bg: '#fee2e2' },
  archived:  { label: 'Archived',    fg: '#6b7280', bg: '#e5e7eb' },
};

/** target state → { verb, endpoint, icon }. Offered only when the server allows it. */
const MOVES = {
  in_review: { verb: 'Submit for review', path: 'submit',    Icon: Send },
  approved:  { verb: 'Approve',           path: 'approve',   Icon: Check },
  rejected:  { verb: 'Reject',            path: 'reject',    Icon: Ban },
  published: { verb: 'Publish',           path: 'publish',   Icon: Globe },
  archived:  { verb: 'Archive',           path: 'archive',   Icon: Archive },
  draft:     { verb: 'Return to draft',   path: 'unpublish', Icon: History },
};

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
  : '';

const chipStyle = (active) => ({
  padding: '7px 12px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', borderColor: active ? '#6B3FDB' : '#e5e7eb',
  background: active ? '#6B3FDB' : '#fff', color: active ? '#fff' : '#374151',
});

export default function KnowledgeBase() {
  const [articles,   setArticles]   = useState([]);
  const [summary,    setSummary]    = useState(null);
  const [transitions, setTransitions] = useState({});
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [cat,        setCat]        = useState('All');
  const [state,      setState]      = useState('all');
  const [expanded,   setExpanded]   = useState(null);
  const [versions,   setVersions]   = useState({});
  const [showForm,   setShowForm]   = useState(false);
  const [form,       setForm]       = useState(EMPTY);
  const [saving,     setSaving]     = useState(false);
  const [busyId,     setBusyId]     = useState(null);
  const [denied,     setDenied]     = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    const params = { limit: 200 };
    if (state !== 'all') params.status = state;
    Promise.all([
      api.get('/servicedesk/knowledge', { params }),
      api.get('/servicedesk/knowledge/summary'),
    ])
      .then(([list, sum]) => {
        setArticles(Array.isArray(list.data) ? list.data : []);
        setSummary(sum.data || null);
        setDenied(false);
      })
      .catch((err) => {
        // 403 is a real answer, not a load failure — say which one it was rather
        // than rendering an empty list that looks like "no articles exist".
        if (err.response?.status === 403) { setDenied(true); setArticles([]); }
        else { setArticles([]); toast.error(err.response?.data?.error || 'Could not load articles'); }
      })
      .finally(() => setLoading(false));
  }, [state, toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/servicedesk/knowledge/meta/transitions')
      .then(r => setTransitions(r.data || {}))
      .catch(() => setTransitions({}));
  }, []);

  const filtered = (articles || []).filter(a => {
    const matchCat = cat === 'All' || (a?.category ?? 'General') === cat;
    const tagsStr  = Array.isArray(a?.tags) ? a.tags.join(',') : (a?.tags || '');
    const matchSearch = !search ||
      [a?.title, a?.content, tagsStr, a?.category].some(v => (v || '').toLowerCase().includes(search.toLowerCase()));
    return matchCat && matchSearch;
  });

  const handleSave = async () => {
    if (!form.title || !form.content) return;
    setSaving(true);
    try {
      const { data } = await api.post('/servicedesk/knowledge', form);
      setShowForm(false); setForm(EMPTY); load();
      // NOT "published" — it is a draft, and saying otherwise is how somebody
      // comes to believe an unreviewed answer is live on the portal.
      toast.success(data?.notice || 'Saved as a draft. Submit it for review to publish.');
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Save failed. Please try again.');
    } finally { setSaving(false); }
  };

  const move = async (article, to) => {
    const { verb, path } = MOVES[to];
    let reason;
    if (to === 'rejected') {
      reason = window.prompt('Why is this article being sent back?');
      if (reason === null) return;                 // cancelled, not an empty reason
    }
    setBusyId(article.id);
    try {
      const { data } = await api.post(`/servicedesk/knowledge/${article.id}/${path}`, { reason });
      toast.success(`${article.title} — ${STATES[data.status]?.label ?? data.status}`);
      load();
    } catch (err) {
      // The server's refusal already explains itself ("cannot be approved by the
      // person who submitted it", "requires one of: …"). Pass it through.
      toast.error(err.response?.data?.error || `${verb} failed`);
    } finally { setBusyId(null); }
  };

  const loadVersions = async (id) => {
    if (versions[id]) return;
    try {
      const { data } = await api.get(`/servicedesk/knowledge/${id}/versions`);
      setVersions(v => ({ ...v, [id]: Array.isArray(data) ? data : [] }));
    } catch { setVersions(v => ({ ...v, [id]: [] })); }
  };

  const toggle = (id) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next) loadVersions(next);
  };

  const rate = async (article, event) => {
    try {
      await api.post(`/servicedesk/knowledge/${article.id}/feedback`, { event });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not record that'); }
  };

  return (
    <PageShell dock={
      <PageHero
        icon={LifeBuoy}
        eyebrow="Service Desk"
        title="Knowledge Base"
        actions={<button className="plh-cta" onClick={() => setShowForm(true)}>
          <Plus size={15} /> New Article
        </button>}
      />
    }>
      {summary && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <button onClick={() => setState('all')} style={chipStyle(state === 'all')}>
            All {summary.total}
          </button>
          {Object.entries(STATES).map(([key, s]) => (
            <button key={key} onClick={() => setState(key)} style={chipStyle(state === key)}>
              {s.label} {summary[key] ?? 0}
            </button>
          ))}
          {summary.review_overdue > 0 && (
            <span style={{ padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                           background: '#fef3c7', color: '#b45309', alignSelf: 'center' }}>
              {summary.review_overdue} due for review
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search articles..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        {CATS.map(c => (
          <button key={c} onClick={() => setCat(c)} style={chipStyle(cat === c)}>{c}</button>
        ))}
      </div>

      {denied ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', border: '1px solid #f0f0f4' }}>
          <Lock size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#6b7280', margin: 0, fontWeight: 600 }}>You do not have access to the knowledge base</p>
          <p style={{ color: '#9ca3af', margin: '6px 0 0', fontSize: 13 }}>Ask an administrator for Service Desk access.</p>
        </div>
      ) : loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', border: '1px solid #f0f0f4' }}>
          <BookOpen size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af', margin: '0 0 16px' }}>No articles found</p>
          <button onClick={() => setShowForm(true)} style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Create First Article</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(a => {
            const tagList = Array.isArray(a?.tags) ? a.tags : (a?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            const st = STATES[a.status] || STATES.draft;
            const allowed = transitions[a.status] || [];
            const isOpen = expanded === a.id;
            return (
              <div key={a.id} style={{ background: '#fff', borderRadius: 10, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
                <div onClick={() => toggle(a.id)}
                  style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <p style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>{a?.title ?? 'Untitled'}</p>
                      <span style={{ background: st.bg, color: st.fg, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
                        {st.label}
                      </span>
                      {a.visibility === 'public' && (
                        <span title="Visible to customers when published"
                          style={{ background: '#e0f2fe', color: '#0369a1', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <Globe size={10} /> Public
                        </span>
                      )}
                      <span style={{ color: '#9ca3af', fontSize: 10 }}>v{a.version}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ background: '#ede9fe', color: '#6B3FDB', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600 }}>{a?.category ?? 'General'}</span>
                      {tagList.slice(0, 2).map((t, i) => (
                        <span key={i} style={{ background: '#f3f4f6', color: '#6b7280', padding: '2px 7px', borderRadius: 20, fontSize: 10 }}>{t}</span>
                      ))}
                      <span style={{ color: '#9ca3af', fontSize: 10, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <Eye size={11} /> {a.views ?? 0}
                      </span>
                      {/* An unrated article is UNMEASURED, not 0% helpful — the two
                          must not look the same, so it renders as a dash. */}
                      <span style={{ color: '#9ca3af', fontSize: 10 }}>
                        {a.helpful_pct === null || a.helpful_pct === undefined
                          ? 'not yet rated'
                          : `${a.helpful_pct}% helpful`}
                      </span>
                      {a.updated_at && <span style={{ color: '#9ca3af', fontSize: 10, marginLeft: 'auto' }}>Updated {fmtDate(a.updated_at)}</span>}
                    </div>
                  </div>
                  {isOpen ? <ChevronUp size={16} color="#9ca3af" /> : <ChevronDown size={16} color="#9ca3af" />}
                </div>

                {isOpen && (
                  <div style={{ padding: '0 20px 16px', borderTop: '1px solid #f5f3ff' }}>
                    {a.rejected_reason && (
                      <p style={{ margin: '12px 0 0', padding: '8px 12px', background: '#fee2e2', color: '#b91c1c', borderRadius: 8, fontSize: 12 }}>
                        Sent back: {a.rejected_reason}
                      </p>
                    )}
                    <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.7, margin: '12px 0 0', whiteSpace: 'pre-wrap' }}>{a?.content ?? ''}</p>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16, alignItems: 'center' }}>
                      {allowed.map(to => {
                        const m = MOVES[to];
                        if (!m) return null;
                        return (
                          <button key={to} disabled={busyId === a.id} onClick={() => move(a, to)}
                            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff',
                                     cursor: busyId === a.id ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600, color: '#374151',
                                     display: 'inline-flex', gap: 6, alignItems: 'center', opacity: busyId === a.id ? 0.6 : 1 }}>
                            <m.Icon size={13} /> {m.verb}
                          </button>
                        );
                      })}
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                        <button onClick={() => rate(a, 'helpful')} title="This answered the question"
                          style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: '#047857' }}>
                          <ThumbsUp size={13} /> <span style={{ fontSize: 11 }}>{a.helpful_yes ?? 0}</span>
                        </button>
                        <button onClick={() => rate(a, 'not_helpful')} title="This did not answer the question"
                          style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: '#b91c1c' }}>
                          <ThumbsDown size={13} /> <span style={{ fontSize: 11 }}>{a.helpful_no ?? 0}</span>
                        </button>
                      </span>
                    </div>

                    {(versions[a.id]?.length > 0) && (
                      <div style={{ marginTop: 16, borderTop: '1px solid #f5f3ff', paddingTop: 12 }}>
                        <p style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', margin: '0 0 8px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <History size={12} /> Version history
                        </p>
                        {versions[a.id].map(v => (
                          <div key={v.id} style={{ display: 'flex', gap: 10, fontSize: 11, color: '#6b7280', padding: '3px 0' }}>
                            <span style={{ fontWeight: 700, minWidth: 26 }}>v{v.version}</span>
                            <span style={{ flex: 1 }}>{v.change_note || v.title}</span>
                            {v.changed_by_name && <span>{v.changed_by_name}</span>}
                            <span>{fmtDate(v.created_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>New Article</h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gap: 14 }}>
              {[{ label: 'Title *', key: 'title', placeholder: 'Article title' },
                { label: 'Summary', key: 'summary', placeholder: 'One line — what this answers' },
                { label: 'Tags', key: 'tags', placeholder: 'comma, separated, tags' }].map(f => (
                <div key={f.key}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{f.label}</label>
                  <input value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                </div>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Category</label>
                  <select value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                    {CATS.filter(c => c !== 'All').map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Audience</label>
                  <select value={form.visibility} onChange={e => setForm(p => ({ ...p, visibility: e.target.value }))}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
                    <option value="internal">Internal — staff only</option>
                    <option value="public">Public — customer portal</option>
                  </select>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Content *</label>
                <textarea value={form.content} onChange={e => setForm(p => ({ ...p, content: e.target.value }))} rows={8} placeholder="Write the article content here..."
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
              </div>
              <p style={{ margin: 0, fontSize: 11, color: '#9ca3af' }}>
                Saved as a draft. It reaches readers once someone else approves and publishes it.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowForm(false)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.title || !form.content}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (saving || !form.title || !form.content) ? .6 : 1 }}>
                {saving ? 'Saving...' : 'Save Draft'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
