import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  ArrowLeft, Users, Plus, X, Search, Trash2, Tag,
  ExternalLink, Briefcase, Building2, Pencil,
} from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

const EMPTY_FORM = { pool_name: '', description: '', department: '', skills: [], is_active: true };

// ── Stage badge ───────────────────────────────────────────────────────────────
const STAGE_COLORS = {
  applied:    { bg:'#dbeafe', color:'#1d4ed8' },
  screening:  { bg:'#fef3c7', color:'#92400e' },
  hired:      { bg:'#dcfce7', color:'#15803d' },
  rejected:   { bg:'#fee2e2', color:'#dc2626' },
};
const StageBadge = ({ stage }) => {
  const c = STAGE_COLORS[stage] || { bg:'#f3f4f6', color:'#6b7280' };
  return (
    <span style={{ ...c, padding:'2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600, textTransform:'capitalize', whiteSpace:'nowrap' }}>
      {(stage || 'unknown').replace(/_/g, ' ')}
    </span>
  );
};

export default function TalentPoolDetail({ setPage, urlParams }) {
  const toast = useToast();

  // ── Pool data ─────────────────────────────────────────────────────────────
  const [pool,      setPool]      = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('selectedPool') || 'null'); } catch { return null; }
  });
  const [members,   setMembers]   = useState([]);
  const [loadingM,  setLoadingM]  = useState(false);
  const poolId = urlParams?.id || pool?.id || sessionStorage.getItem('selectedPoolId');

  // ── Edit pool modal ────────────────────────────────────────────────────────
  const [showEdit,    setShowEdit]    = useState(false);
  const [editForm,    setEditForm]    = useState(EMPTY_FORM);
  const [skillInput,  setSkillInput]  = useState('');
  const [saving,      setSaving]      = useState(false);
  const [departments, setDepartments] = useState([]);

  // ── Add candidates modal ───────────────────────────────────────────────────
  const [showAdd,     setShowAdd]     = useState(false);
  const [resumes,     setResumes]     = useState([]);
  const [resumeSearch,setResumeSearch]= useState('');
  const [loadingRes,  setLoadingRes]  = useState(false);
  const [selected,    setSelected]    = useState({});   // { candidateId: notes }
  const [adding,      setAdding]      = useState(false);

  // ── Move to pipeline modal ─────────────────────────────────────────────────
  const [showPipeline,  setShowPipeline]  = useState(false);
  const [pipelineTarget,setPipelineTarget]= useState(null);
  const [openings,      setOpenings]      = useState([]);
  const [selectedJob,   setSelectedJob]   = useState('');
  const [moving,        setMoving]        = useState(false);

  // ── Removing member ────────────────────────────────────────────────────────
  const [removing, setRemoving] = useState(null);
  const [pendingRemoveMember, setPendingRemoveMember] = useState(null);

  // ── Load pool fresh ───────────────────────────────────────────────────────
  const loadPool = useCallback(async () => {
    if (!poolId) return;
    try {
      const r = await api.get(`/talent/pools/${poolId}`);
      const p = r.data?.data ?? r.data;
      if (p) { setPool(p); sessionStorage.setItem('selectedPool', JSON.stringify(p)); }
    } catch { /* keep stale data */ }
  }, [poolId]);

  const loadMembers = useCallback(async () => {
    if (!poolId) return;
    setLoadingM(true);
    try {
      const r = await api.get(`/talent/pools/${poolId}/members`);
      setMembers(r.data?.data ?? (Array.isArray(r.data) ? r.data : []));
    } catch {
      setMembers([]);
    } finally {
      setLoadingM(false);
    }
  }, [poolId]);

  useEffect(() => {
    loadPool();
    loadMembers();
    api.get('/orgchart/departments')
      .then(r => setDepartments(r.data?.data ?? (Array.isArray(r.data) ? r.data : [])))
      .catch(() => {});
  }, [loadPool, loadMembers]);

  // ── Pool skills helper ─────────────────────────────────────────────────────
  const poolSkills = (() => {
    if (!pool) return [];
    const s = pool.skills;
    if (Array.isArray(s)) return s;
    if (typeof s === 'string') { try { return JSON.parse(s); } catch { return []; } }
    return pool.skill_focus ? pool.skill_focus.split(',').map(x => x.trim()).filter(Boolean) : [];
  })();

  // ── Edit pool ──────────────────────────────────────────────────────────────
  const openEditModal = () => {
    setEditForm({
      pool_name:   pool?.pool_name || '',
      description: pool?.description || '',
      department:  pool?.department || '',
      skills:      poolSkills,
      is_active:   pool?.is_active !== false,
    });
    setSkillInput('');
    setShowEdit(true);
  };

  const addSkillToEdit = () => {
    const sk = skillInput.trim();
    if (sk && !editForm.skills.includes(sk))
      setEditForm(f => ({ ...f, skills: [...f.skills, sk] }));
    setSkillInput('');
  };

  const handleSaveEdit = async () => {
    if (!editForm.pool_name.trim()) return;
    setSaving(true);
    try {
      await api.put(`/talent/pools/${poolId}`, editForm);
      toast.success('Pool updated');
      setShowEdit(false);
      loadPool();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update pool');
    } finally {
      setSaving(false);
    }
  };

  // ── Add candidates ─────────────────────────────────────────────────────────
  const openAddModal = async () => {
    setSelected({});
    setResumeSearch('');
    setShowAdd(true);
    setLoadingRes(true);
    try {
      const r = await api.get('/talent/resumes');
      const rows = r.data?.data ?? (Array.isArray(r.data) ? r.data : []);
      const existingIds = new Set(members.map(m => String(m.id)));
      setResumes(rows.filter(c => !existingIds.has(String(c.id))));
    } catch {
      setResumes([]);
    } finally {
      setLoadingRes(false);
    }
  };

  const toggleSelect = (id) => {
    setSelected(s => {
      const next = { ...s };
      if (id in next) delete next[id];
      else next[id] = '';
      return next;
    });
  };

  const handleAddSelected = async () => {
    const ids = Object.keys(selected);
    if (!ids.length) return;
    setAdding(true);
    let added = 0;
    for (const cid of ids) {
      try {
        await api.post(`/talent/pools/${poolId}/members`, { candidate_id: cid, notes: selected[cid] || null });
        added++;
      } catch { /* skip duplicates */ }
    }
    toast.success(`Added ${added} candidate${added !== 1 ? 's' : ''} to pool`);
    setShowAdd(false);
    setAdding(false);
    loadPool();
    loadMembers();
  };

  const filteredResumes = resumes.filter(c => {
    if (!resumeSearch) return true;
    const q = resumeSearch.toLowerCase();
    return (c.name || c.full_name || '').toLowerCase().includes(q)
      || (c.email || '').toLowerCase().includes(q)
      || (c.current_company || '').toLowerCase().includes(q)
      || (c.current_designation || c.candidate_role || '').toLowerCase().includes(q);
  });

  // ── Remove member ──────────────────────────────────────────────────────────
  const handleRemove = async () => {
    if (!pendingRemoveMember) return;
    const m = pendingRemoveMember;
    setPendingRemoveMember(null);
    setRemoving(m.id);
    try {
      await api.delete(`/talent/pools/${poolId}/members/${m.id}`);
      toast.success(`${m.name} removed from pool`);
      loadPool();
      loadMembers();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to remove member');
    } finally {
      setRemoving(null);
    }
  };

  // ── Move to pipeline ───────────────────────────────────────────────────────
  const openPipelineModal = async (m) => {
    setPipelineTarget(m);
    setSelectedJob('');
    setShowPipeline(true);
    try {
      const r = await api.get('/recruitment/openings', { params: { status: 'open' } });
      const rows = Array.isArray(r.data) ? r.data : (r.data?.data ?? r.data?.openings ?? []);
      setOpenings(rows);
    } catch {
      setOpenings([]);
    }
  };

  const handleMoveToPipeline = async () => {
    if (!selectedJob || !pipelineTarget) return;
    setMoving(true);
    try {
      await api.post('/recruitment/candidates', {
        opening_id:   selectedJob,
        applied_job_id: selectedJob,
        full_name:    pipelineTarget.name,
        email:        pipelineTarget.email,
        phone:        pipelineTarget.phone,
        source:       'talent_pool',
        current_stage: 'applied',
      });
      toast.success(`${pipelineTarget.name} added to recruitment pipeline`);
      setShowPipeline(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to add to pipeline');
    } finally {
      setMoving(false);
    }
  };

  if (!poolId) {
    return (
      <div style={{ padding: 40, textAlign:'center', color:'#9ca3af' }}>
        <p>No pool selected.</p>
        <button onClick={() => setPage?.('TalentPools')} style={{ marginTop: 12, padding:'8px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius: 8, cursor:'pointer', fontSize: 13 }}>
          Back to Talent Pools
        </button>
      </div>
    );
  }

  const memberCount = members.length || parseInt(pool?.member_count) || 0;

  return (
    <div style={{ padding: 24, background:'#f9fafb', minHeight:'100vh' }}>
      <ConfirmDialog
        open={!!pendingRemoveMember}
        title="Remove from Pool"
        message={pendingRemoveMember ? `Remove ${pendingRemoveMember.name} from this pool?` : ''}
        confirmLabel="Remove"
        variant="warning"
        onConfirm={handleRemove}
        onCancel={() => setPendingRemoveMember(null)}
      />

      {/* Back nav */}
      <button onClick={() => setPage?.('TalentPools')}
        style={{ display:'flex', alignItems:'center', gap: 6, background:'none', border:'none', cursor:'pointer', color:'#6b7280', fontSize: 13, marginBottom: 16, padding: 0 }}>
        <ArrowLeft size={15}/> Back to Talent Pools
      </button>

      {/* Pool header card */}
      <div style={{ background:'#fff', borderRadius: 12, padding: 24, border:'1px solid #f0f0f4', marginBottom: 20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display:'flex', alignItems:'center', gap: 10, flexWrap:'wrap' }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, color:'#1f2937', margin: 0 }}>{pool?.pool_name}</h1>
              <span style={{ fontSize: 11, fontWeight: 600, padding:'3px 9px', borderRadius: 20,
                background: pool?.is_active !== false ? '#dcfce7' : '#f3f4f6',
                color: pool?.is_active !== false ? '#15803d' : '#6b7280' }}>
                {pool?.is_active !== false ? 'Active' : 'Inactive'}
              </span>
            </div>

            {pool?.department && (
              <div style={{ display:'flex', alignItems:'center', gap: 4, marginTop: 4 }}>
                <Building2 size={12} color="#9ca3af"/>
                <span style={{ fontSize: 12, color:'#9ca3af' }}>{pool.department}</span>
              </div>
            )}

            {pool?.description && (
              <p style={{ fontSize: 13, color:'#6b7280', margin:'8px 0 0' }}>{pool.description}</p>
            )}

            {poolSkills.length > 0 && (
              <div style={{ display:'flex', flexWrap:'wrap', gap: 6, marginTop: 10 }}>
                {poolSkills.map((sk, i) => (
                  <span key={i} style={{ background:'#f5f3ff', color:'#6B3FDB', padding:'3px 8px', borderRadius: 20, fontSize: 11, fontWeight: 500, display:'flex', alignItems:'center', gap: 3 }}>
                    <Tag size={9}/>{sk}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap: 8 }}>
            <div style={{ textAlign:'center', padding:'10px 20px', background:'#f5f3ff', borderRadius: 10 }}>
              <p style={{ fontSize: 22, fontWeight: 700, color:'#6B3FDB', margin: 0 }}>{memberCount}</p>
              <p style={{ fontSize: 11, color:'#9ca3af', margin: 0 }}>Candidates</p>
            </div>
            <button onClick={openEditModal}
              style={{ display:'flex', alignItems:'center', gap: 5, padding:'7px 14px', background:'#f9fafb', color:'#374151', border:'1px solid #e5e7eb', borderRadius: 8, cursor:'pointer', fontSize: 12, fontWeight: 600 }}>
              <Pencil size={13}/> Edit Pool
            </button>
          </div>
        </div>
      </div>

      {/* Members section */}
      <div style={{ background:'#fff', borderRadius: 12, border:'1px solid #f0f0f4' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'16px 20px', borderBottom:'1px solid #f3f4f6' }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color:'#1f2937', margin: 0 }}>
            Pool Members <span style={{ fontWeight: 400, color:'#9ca3af', fontSize: 13 }}>({members.length})</span>
          </h2>
          <button onClick={openAddModal}
            style={{ display:'flex', alignItems:'center', gap: 5, padding:'8px 16px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius: 8, cursor:'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={14}/> Add Candidates
          </button>
        </div>

        {loadingM ? (
          <div style={{ padding: 40, textAlign:'center', color:'#9ca3af' }}>Loading members…</div>
        ) : members.length === 0 ? (
          <div style={{ padding: 40, textAlign:'center' }}>
            <Users size={36} color="#d1d5db" style={{ marginBottom: 12 }}/>
            <p style={{ color:'#9ca3af', margin:'0 0 16px', fontSize: 13 }}>No candidates in this pool yet.</p>
            <button onClick={openAddModal}
              style={{ padding:'8px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius: 8, cursor:'pointer', fontSize: 13, fontWeight: 600 }}>
              Add Candidates
            </button>
          </div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background:'#f9fafb' }}>
                  {['Name','Current Role','Experience','Skills','Stage','Resume','Added By','Notes','Actions'].map(h => (
                    <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontSize: 11, fontWeight: 600, color:'#6b7280', whiteSpace:'nowrap', borderBottom:'1px solid #f3f4f6' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map(m => {
                  const mSkills = Array.isArray(m.skills) ? m.skills
                    : typeof m.skills === 'string' ? (() => { try { return JSON.parse(m.skills); } catch { return []; } })()
                    : [];
                  return (
                    <tr key={m.id} style={{ borderBottom:'1px solid #f9fafb' }}>
                      <td style={{ padding:'12px 16px', whiteSpace:'nowrap' }}>
                        <div style={{ fontWeight: 600, color:'#1f2937' }}>{m.name}</div>
                        <div style={{ fontSize: 11, color:'#9ca3af' }}>{m.email}</div>
                      </td>
                      <td style={{ padding:'12px 16px' }}>
                        <div style={{ color:'#374151' }}>{m.current_designation || '—'}</div>
                        {m.current_company && <div style={{ fontSize: 11, color:'#9ca3af' }}>{m.current_company}</div>}
                      </td>
                      <td style={{ padding:'12px 16px', whiteSpace:'nowrap', color:'#374151' }}>
                        {m.experience_years != null ? `${m.experience_years} yr` : '—'}
                      </td>
                      <td style={{ padding:'12px 16px', maxWidth: 160 }}>
                        <div style={{ display:'flex', flexWrap:'wrap', gap: 3 }}>
                          {mSkills.slice(0, 2).map((sk, i) => (
                            <span key={i} style={{ background:'#f5f3ff', color:'#6B3FDB', padding:'1px 6px', borderRadius: 12, fontSize: 10 }}>{sk}</span>
                          ))}
                          {mSkills.length > 2 && <span style={{ fontSize: 10, color:'#9ca3af' }}>+{mSkills.length - 2}</span>}
                          {mSkills.length === 0 && <span style={{ color:'#d1d5db', fontSize: 11 }}>—</span>}
                        </div>
                      </td>
                      <td style={{ padding:'12px 16px', whiteSpace:'nowrap' }}>
                        <StageBadge stage={m.stage}/>
                      </td>
                      <td style={{ padding:'12px 16px' }}>
                        {m.resume_url
                          ? <a href={m.resume_url} target="_blank" rel="noopener noreferrer"
                              style={{ display:'flex', alignItems:'center', gap: 4, color:'#6B3FDB', fontSize: 12 }}>
                              <ExternalLink size={12}/> View
                            </a>
                          : <span style={{ color:'#d1d5db', fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ padding:'12px 16px', color:'#6b7280', fontSize: 12, whiteSpace:'nowrap' }}>
                        {m.added_by_name || '—'}
                        {m.added_at && <div style={{ fontSize: 10, color:'#d1d5db' }}>{fmtDate(m.added_at)}</div>}
                      </td>
                      <td style={{ padding:'12px 16px', maxWidth: 140 }}>
                        <span style={{ fontSize: 11, color:'#6b7280' }}>{m.notes || '—'}</span>
                      </td>
                      <td style={{ padding:'12px 16px', whiteSpace:'nowrap' }}>
                        <div style={{ display:'flex', gap: 6 }}>
                          <button onClick={() => openPipelineModal(m)}
                            title="Move to Recruitment Pipeline"
                            style={{ display:'flex', alignItems:'center', gap: 4, padding:'5px 10px', background:'#f0fdf4', color:'#15803d', border:'none', borderRadius: 6, cursor:'pointer', fontSize: 11, fontWeight: 600, whiteSpace:'nowrap' }}>
                            <Briefcase size={11}/> Pipeline
                          </button>
                          <button onClick={() => setPendingRemoveMember(m)} disabled={removing === m.id}
                            title="Remove from pool"
                            style={{ padding:'5px 8px', background:'#fef2f2', color:'#dc2626', border:'none', borderRadius: 6, cursor:'pointer', opacity: removing === m.id ? 0.5 : 1 }}>
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
      </div>

      {/* ── Edit Pool Modal ────────────────────────────────────────────────── */}
      {showEdit && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <div style={modalHeaderStyle}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color:'#1f2937', margin: 0 }}>Edit Pool</h2>
              <button onClick={() => setShowEdit(false)} style={iconBtnStyle}><X size={18}/></button>
            </div>
            <div style={{ display:'grid', gap: 14 }}>
              <Field label="Pool Name *">
                <input value={editForm.pool_name} onChange={e => setEditForm(f => ({ ...f, pool_name: e.target.value }))} style={inputStyle}/>
              </Field>
              <Field label="Description">
                <textarea value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} rows={3} style={{ ...inputStyle, resize:'vertical', fontFamily:'inherit' }}/>
              </Field>
              <Field label="Department">
                <select value={editForm.department} onChange={e => setEditForm(f => ({ ...f, department: e.target.value }))} style={inputStyle}>
                  <option value="">— Any —</option>
                  {departments.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </Field>
              <Field label="Target Skills">
                <div style={{ display:'flex', gap: 6 }}>
                  <input value={skillInput} onChange={e => setSkillInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSkillToEdit(); } }}
                    placeholder="Type + Enter" style={{ ...inputStyle, flex: 1 }}/>
                  <button onClick={addSkillToEdit} style={addTagBtnStyle}>Add</button>
                </div>
                {editForm.skills.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap: 6, marginTop: 8 }}>
                    {editForm.skills.map(sk => (
                      <span key={sk} style={skillChipStyle}>
                        {sk}
                        <button onClick={() => setEditForm(f => ({ ...f, skills: f.skills.filter(s => s !== sk) }))} style={removeTagBtnStyle}>×</button>
                      </span>
                    ))}
                  </div>
                )}
              </Field>
              <div style={{ display:'flex', alignItems:'center', gap: 10 }}>
                <label style={labelStyle}>Active</label>
                <div onClick={() => setEditForm(f => ({ ...f, is_active: !f.is_active }))} style={toggleStyle(editForm.is_active)}>
                  <div style={toggleKnobStyle(editForm.is_active)}/>
                </div>
              </div>
            </div>
            <div style={modalFooterStyle}>
              <button onClick={() => setShowEdit(false)} style={cancelBtnStyle}>Cancel</button>
              <button onClick={handleSaveEdit} disabled={saving || !editForm.pool_name.trim()} style={saveBtnStyle(saving || !editForm.pool_name.trim())}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Candidates Modal ───────────────────────────────────────────── */}
      {showAdd && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, width: 620, maxHeight:'85vh' }}>
            <div style={modalHeaderStyle}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color:'#1f2937', margin: 0 }}>Add Candidates to Pool</h2>
              <button onClick={() => setShowAdd(false)} style={iconBtnStyle}><X size={18}/></button>
            </div>

            <div style={{ position:'relative', marginBottom: 12 }}>
              <Search size={13} style={{ position:'absolute', left: 10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
              <input value={resumeSearch} onChange={e => setResumeSearch(e.target.value)}
                placeholder="Search by name, email, company, role…"
                style={{ ...inputStyle, paddingLeft: 32 }}/>
            </div>

            <div style={{ fontSize: 12, color:'#9ca3af', marginBottom: 8 }}>
              {Object.keys(selected).length} selected
            </div>

            <div style={{ maxHeight: 340, overflowY:'auto', border:'1px solid #f0f0f4', borderRadius: 8 }}>
              {loadingRes ? (
                <div style={{ padding: 24, textAlign:'center', color:'#9ca3af' }}>Loading candidates…</div>
              ) : filteredResumes.length === 0 ? (
                <div style={{ padding: 24, textAlign:'center', color:'#9ca3af' }}>
                  {resumes.length === 0 ? 'No candidates in resume database yet.' : 'No matches found.'}
                </div>
              ) : filteredResumes.map(c => {
                const cid = String(c.id);
                const checked = cid in selected;
                return (
                  <div key={c.id}
                    onClick={() => toggleSelect(cid)}
                    style={{ display:'flex', alignItems:'flex-start', gap: 10, padding:'10px 14px', cursor:'pointer', borderBottom:'1px solid #f9fafb', background: checked ? '#f5f3ff' : '#fff', transition:'background .1s' }}>
                    <input type="checkbox" checked={checked} readOnly
                      style={{ marginTop: 3, accentColor:'#6B3FDB', cursor:'pointer', flexShrink: 0 }}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color:'#1f2937', fontSize: 13 }}>{c.name || c.full_name}</div>
                      <div style={{ fontSize: 11, color:'#6b7280' }}>
                        {[c.current_designation || c.candidate_role, c.current_company].filter(Boolean).join(' @ ')}
                      </div>
                      <div style={{ fontSize: 11, color:'#9ca3af' }}>
                        {[c.email, c.experience_years != null ? `${c.experience_years} yr exp` : null].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <StageBadge stage={c.stage || c.current_stage}/>
                  </div>
                );
              })}
            </div>

            <div style={modalFooterStyle}>
              <button onClick={() => setShowAdd(false)} style={cancelBtnStyle}>Cancel</button>
              <button onClick={handleAddSelected} disabled={adding || Object.keys(selected).length === 0}
                style={saveBtnStyle(adding || Object.keys(selected).length === 0)}>
                {adding ? 'Adding…' : `Add ${Object.keys(selected).length || ''} Selected`.trim()}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Move to Pipeline Modal ─────────────────────────────────────────── */}
      {showPipeline && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, width: 440 }}>
            <div style={modalHeaderStyle}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color:'#1f2937', margin: 0 }}>Move to Recruitment Pipeline</h2>
              <button onClick={() => setShowPipeline(false)} style={iconBtnStyle}><X size={18}/></button>
            </div>

            <p style={{ fontSize: 13, color:'#6b7280', marginBottom: 16 }}>
              Assign <strong>{pipelineTarget?.name}</strong> to an open job position.
            </p>

            <Field label="Select Job Opening">
              <select value={selectedJob} onChange={e => setSelectedJob(e.target.value)} style={inputStyle}>
                <option value="">— Choose a position —</option>
                {openings.map(o => (
                  <option key={o.id} value={o.id}>
                    {o.job_title || o.title} {o.department ? `(${o.department})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            {openings.length === 0 && (
              <p style={{ fontSize: 12, color:'#9ca3af', marginTop: 4 }}>No open positions found.</p>
            )}

            <div style={modalFooterStyle}>
              <button onClick={() => setShowPipeline(false)} style={cancelBtnStyle}>Cancel</button>
              <button onClick={handleMoveToPipeline} disabled={moving || !selectedJob}
                style={saveBtnStyle(moving || !selectedJob)}>
                {moving ? 'Adding…' : 'Add to Pipeline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shared style helpers ──────────────────────────────────────────────────────
const labelStyle      = { display:'block', fontSize: 12, fontWeight: 600, color:'#374151', marginBottom: 4 };
const inputStyle      = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline:'none', boxSizing:'border-box', background:'#fff' };
const overlayStyle    = { position:'fixed', inset: 0, background:'rgba(0,0,0,0.5)', zIndex: 1000, display:'flex', alignItems:'center', justifyContent:'center', padding: 16 };
const modalStyle      = { background:'#fff', borderRadius: 16, padding: 28, width: 480, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' };
const modalHeaderStyle= { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 20 };
const modalFooterStyle= { display:'flex', gap: 10, justifyContent:'flex-end', marginTop: 24, paddingTop: 16, borderTop:'1px solid #f3f4f6' };
const iconBtnStyle    = { background:'none', border:'none', cursor:'pointer', color:'#9ca3af' };
const cancelBtnStyle  = { padding:'9px 18px', border:'1px solid #e5e7eb', borderRadius: 8, background:'#fff', cursor:'pointer', fontSize: 13 };
const saveBtnStyle    = (disabled) => ({ padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600, opacity: disabled ? 0.6 : 1 });
const addTagBtnStyle  = { padding:'8px 14px', background:'#f5f3ff', color:'#6B3FDB', border:'1px solid #e9d5ff', borderRadius: 8, cursor:'pointer', fontSize: 12, fontWeight: 600, whiteSpace:'nowrap' };
const skillChipStyle  = { background:'#f5f3ff', color:'#6B3FDB', padding:'3px 8px', borderRadius: 20, fontSize: 11, fontWeight: 500, display:'flex', alignItems:'center', gap: 4 };
const removeTagBtnStyle= { background:'none', border:'none', cursor:'pointer', color:'#a78bfa', padding: 0, lineHeight: 1, fontSize: 14 };
const toggleStyle     = (on) => ({ width: 44, height: 24, borderRadius: 12, background: on ? '#6B3FDB' : '#e5e7eb', cursor:'pointer', position:'relative', transition:'background .2s', flexShrink: 0 });
const toggleKnobStyle = (on) => ({ position:'absolute', top: 3, left: on ? 23 : 3, width: 18, height: 18, borderRadius:'50%', background:'#fff', transition:'left .2s', boxShadow:'0 1px 3px rgba(0,0,0,.2)' });

function Field({ label, children }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}
