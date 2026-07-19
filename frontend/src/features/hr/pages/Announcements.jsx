import { useState, useEffect, useRef, useCallback } from "react";
import DOMPurify from "dompurify";
import {
  Megaphone, Plus, X, Pencil, Trash2, Eye, EyeOff,
  Clock, Pin, PinOff, CalendarClock, Users, Search,
  CheckCircle, AlertTriangle, Info,
} from "lucide-react";
import api from "@/services/api/client";
import "./Announcements.css";
import ConfirmDialog from "@/components/core/ConfirmDialog";

/* ── constants ───────────────────────────────────────────────────────────────── */
const TABS = ["All", "Active", "Scheduled", "Inactive", "Expired"];
const TITLE_MAX = 120;

const PRIORITIES = [
  { value: "high",   label: "High",   cls: "ann-badge-pri-high"   },
  { value: "medium", label: "Medium", cls: "ann-badge-pri-medium" },
  { value: "low",    label: "Low",    cls: "ann-badge-pri-low"    },
];

const CATEGORIES = ["General", "HR Policy", "Finance", "IT", "Operations", "Legal", "Urgent", "Other"];

/* ── date helpers ────────────────────────────────────────────────────────────── */
const localDateStr = (d = new Date()) => {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

const todayStr   = () => localDateStr();
const futureDays = (n) => localDateStr(new Date(Date.now() + n * 86400000));

const toDateStr = (val) => {
  if (!val) return "";
  if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  const d = new Date(val);
  if (isNaN(d.getTime())) return typeof val === "string" ? val.slice(0, 10) : "";
  return localDateStr(d);
};

const toDatetimeLocal = (val) => {
  if (!val) return "";
  const d = new Date(val);
  if (isNaN(d.getTime())) return "";
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const isExpired  = (ann) => ann.to_date ? toDateStr(ann.to_date) < todayStr() : false;
const isScheduled = (ann) => ann.publish_at && new Date(ann.publish_at) > new Date();

const daysLeft = (ann) => {
  if (!ann.to_date) return null;
  const end   = new Date(toDateStr(ann.to_date) + "T00:00:00");
  const today = new Date(todayStr()             + "T00:00:00");
  return Math.ceil((end - today) / 86400000);
};

const targetLabel = (type, value) => {
  if (type === "all")        return { label: "All Employees", cls: "ann-badge-all" };
  if (type === "department") return { label: `Dept: ${value || "—"}`, cls: "ann-badge-dept" };
  if (type === "employee")   return { label: `Employee: ${value || "—"}`, cls: "ann-badge-emp" };
  return { label: type || "All", cls: "ann-badge-all" };
};

const fmtDate = (val) => {
  const s = toDateStr(val);
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
};

const fmtScheduledAt = (val) => {
  if (!val) return "";
  const d = new Date(val);
  if (isNaN(d.getTime())) return "";
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const safe = (html) => DOMPurify.sanitize(html || "", { USE_PROFILES: { html: true } });

const emptyForm = () => ({
  title: "", message: "",
  fromDate: todayStr(), toDate: futureDays(7),
  targetType: "all", targetValue: "",
  isActive: true, isPinned: false, publishAt: "",
  priority: "medium", category: "General",
});

/* ── Toast ───────────────────────────────────────────────────────────────────── */
function Toast({ toasts, remove }) {
  return (
    <div className="ann-toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={`ann-toast ann-toast-${t.type}`}>
          {t.type === "success" && <CheckCircle size={14} />}
          {t.type === "error"   && <AlertTriangle size={14} />}
          {t.type === "info"    && <Info size={14} />}
          <span>{t.message}</span>
          <button className="ann-toast-close" onClick={() => remove(t.id)}><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}

function useToast() {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((message, type = "success") => {
    const id = Date.now() + Math.random();
    setToasts(ts => [...ts, { id, message, type }]);
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), 3500);
  }, []);
  const remove = useCallback((id) => setToasts(ts => ts.filter(t => t.id !== id)), []);
  return { toasts, add, remove };
}

/* ── Rich Text Editor ─────────────────────────────────────────────────────── */
function RichTextEditor({ value, onChange, drawerKey }) {
  const ref = useRef(null);
  const [linkModal, setLinkModal] = useState({ open: false, url: '' });

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = value || "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerKey]);

  const exec = (cmd, arg = null) => {
    ref.current?.focus();
    // execCommand is deprecated but still universally supported; replacement (InputEvent) is not yet viable
    document.execCommand(cmd, false, arg); // eslint-disable-line no-restricted-globals
    onChange(ref.current?.innerHTML || "");
  };

  const handleLink = (e) => {
    e.preventDefault();
    setLinkModal({ open: true, url: '' });
  };

  const confirmLink = () => {
    const { url } = linkModal;
    setLinkModal({ open: false, url: '' });
    if (url) exec("createLink", url);
  };

  return (
    <div className="ann-rte">
      {linkModal.open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>Insert Link</h3>
            <input
              autoFocus
              type="url"
              style={{ width: '100%', borderRadius: 8, border: '1px solid #d1d5db', padding: '8px 12px', fontSize: 13 }}
              placeholder="https://..."
              value={linkModal.url}
              onChange={e => setLinkModal(m => ({ ...m, url: e.target.value }))}
              onKeyDown={e => e.key === 'Enter' && confirmLink()}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setLinkModal({ open: false, url: '' })} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: 'transparent', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={confirmLink} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#4f46e5', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>Insert</button>
            </div>
          </div>
        </div>
      )}
      <div className="ann-rte-toolbar">
        <button type="button" className="ann-rte-btn"
          onMouseDown={e => { e.preventDefault(); exec("bold"); }} title="Bold">
          <b>B</b>
        </button>
        <button type="button" className="ann-rte-btn"
          onMouseDown={e => { e.preventDefault(); exec("italic"); }} title="Italic">
          <i>I</i>
        </button>
        <button type="button" className="ann-rte-btn"
          onMouseDown={e => { e.preventDefault(); exec("underline"); }} title="Underline">
          <u>U</u>
        </button>
        <span className="ann-rte-sep" />
        <button type="button" className="ann-rte-btn"
          onMouseDown={e => { e.preventDefault(); exec("insertUnorderedList"); }} title="Bullet list">
          • List
        </button>
        <button type="button" className="ann-rte-btn"
          onMouseDown={e => { e.preventDefault(); exec("insertOrderedList"); }} title="Numbered list">
          1. List
        </button>
        <span className="ann-rte-sep" />
        <button type="button" className="ann-rte-btn" onMouseDown={handleLink} title="Insert link">
          Link
        </button>
        <button type="button" className="ann-rte-btn"
          onMouseDown={e => { e.preventDefault(); exec("removeFormat"); }} title="Clear formatting">
          Clear
        </button>
      </div>
      <div
        ref={ref}
        className="ann-input ann-rte-editor"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Write your announcement…"
        onInput={() => onChange(ref.current?.innerHTML || "")}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
export default function Announcements() {
  const [items,        setItems]        = useState([]);
  const [employees,    setEmployees]    = useState([]);
  const [departments,  setDepartments]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [tab,          setTab]          = useState("All");
  const [search,       setSearch]       = useState("");
  const [showDrawer,   setShowDrawer]   = useState(false);
  const [drawerKey,    setDrawerKey]    = useState(0);
  const [editingId,    setEditingId]    = useState(null);
  const [form,         setForm]         = useState(emptyForm());
  const [formErr,      setFormErr]      = useState(null);
  const [submitting,   setSubmitting]   = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [isDirty,      setIsDirty]      = useState(false);
  const [pendingDiscardChanges, setPendingDiscardChanges] = useState(false);
  const { toasts, add: addToast, remove: removeToast } = useToast();
  const abortRef = useRef(null);

  const set = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    setIsDirty(true);
  };

  /* ── fetch ── */
  const fetchAnnouncements = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setError(null);
    try {
      const res = await api.get("/announcements", { signal: abortRef.current.signal });
      const list = Array.isArray(res.data)
        ? res.data
        : (res.data?.announcements ?? res.data?.data ?? []);
      setItems(list);
    } catch (err) {
      if (err.name !== "CanceledError" && err.code !== "ERR_CANCELED") {
        setError(err.response?.data?.message || err.message || "Failed to load");
      }
    } finally { setLoading(false); }
  }, []);

  const fetchEmployees = useCallback(async () => {
    const EX = new Set(['left','terminated','resigned','ex-employee','notice_period','notice period','inactive']);
    try {
      const res = await api.get("/employees");
      const raw  = Array.isArray(res.data) ? res.data : (res.data?.employees ?? res.data?.data ?? []);
      const list = raw.filter(e => !EX.has((e.status || '').toLowerCase()));
      setEmployees(list);
      setDepartments([...new Set(list.map(e => e.department).filter(Boolean))].sort());
    } catch (e) { console.error("[Announcements] fetchEmployees failed:", e.message); }
  }, []);

  useEffect(() => {
    fetchAnnouncements();
    fetchEmployees();
    return () => abortRef.current?.abort();
  }, [fetchAnnouncements, fetchEmployees]);

  /* ── drawer helpers ── */
  const openCreate = () => {
    setForm(emptyForm()); setEditingId(null); setFormErr(null); setIsDirty(false);
    setDrawerKey(k => k + 1); setShowDrawer(true);
  };

  const openEdit = (ann) => {
    setForm({
      title:       ann.title   || "",
      message:     ann.message || "",
      fromDate:    toDateStr(ann.from_date),
      toDate:      toDateStr(ann.to_date),
      targetType:  ann.target_type  || "all",
      targetValue: ann.target_value != null ? String(ann.target_value) : "",
      isActive:    Boolean(ann.is_active),
      isPinned:    Boolean(ann.is_pinned),
      publishAt:   toDatetimeLocal(ann.publish_at),
      priority:    ann.priority  || "medium",
      category:    ann.category  || "General",
    });
    setEditingId(ann.id); setFormErr(null); setIsDirty(false);
    setDrawerKey(k => k + 1); setShowDrawer(true);
  };

  const handleCloseDrawer = () => {
    if (isDirty) {
      setPendingDiscardChanges(true);
      return;
    }
    setShowDrawer(false);
  };

  /* ── save ── */
  const handleSave = async () => {
    if (!form.title.trim())   { setFormErr("Title is required");       return; }
    if (form.title.trim().length > TITLE_MAX) { setFormErr(`Title must be ${TITLE_MAX} characters or less`); return; }
    if (!form.message.replace(/<[^>]*>/g, "").trim()) {
      setFormErr("Message is required"); return;
    }
    if (!form.fromDate)       { setFormErr("Start date is required");  return; }
    if (!form.toDate)         { setFormErr("End date is required");    return; }
    if (form.toDate < form.fromDate) {
      setFormErr("End date cannot be before start date"); return;
    }
    if (form.targetType !== "all" && !form.targetValue) {
      setFormErr(`Please select a ${form.targetType === "department" ? "department" : "employee"}`);
      return;
    }

    setSubmitting(true); setFormErr(null);
    try {
      const payload = {
        title:        form.title.trim(),
        message:      form.message,
        from_date:    form.fromDate,
        to_date:      form.toDate,
        target_type:  form.targetType,
        target_value: form.targetType === "all" ? "" : form.targetValue,
        is_active:    form.isActive,
        is_pinned:    form.isPinned,
        publish_at:   form.publishAt || null,
        priority:     form.priority,
        category:     form.category,
      };
      if (editingId) await api.put(`/announcements/${editingId}`, payload);
      else           await api.post("/announcements", payload);
      setShowDrawer(false);
      setIsDirty(false);
      await fetchAnnouncements();
      addToast(editingId ? "Announcement updated successfully" : "Announcement posted successfully");
    } catch (err) {
      setFormErr(err.response?.data?.message || err.message || "Error saving");
    } finally { setSubmitting(false); }
  };

  /* ── toggle / pin / delete ── */
  const handleToggle = async (ann) => {
    if (!ann.is_active && isExpired(ann)) {
      addToast("Cannot activate an expired announcement. Update the end date first.", "error");
      return;
    }
    const newActive = !ann.is_active;
    setItems(prev => prev.map(a => a.id === ann.id ? { ...a, is_active: newActive } : a));
    try {
      await api.put(`/announcements/${ann.id}/toggle`, { is_active: newActive });
      addToast(ann.is_active ? "Announcement hidden" : "Announcement made active");
    } catch (err) {
      setItems(prev => prev.map(a => a.id === ann.id ? { ...a, is_active: ann.is_active } : a));
      addToast(err.response?.data?.message || "Error updating", "error");
    }
  };

  const handlePin = async (ann) => {
    const newPinned = !ann.is_pinned;
    setItems(prev => prev.map(a => a.id === ann.id ? { ...a, is_pinned: newPinned } : a));
    try {
      await api.put(`/announcements/${ann.id}/pin`, { is_pinned: newPinned });
      addToast(ann.is_pinned ? "Unpinned" : "Pinned to top");
    } catch (err) {
      setItems(prev => prev.map(a => a.id === ann.id ? { ...a, is_pinned: ann.is_pinned } : a));
      addToast(err.response?.data?.message || "Error updating", "error");
    }
  };

  const handleDelete = async () => {
    if (!pendingDeleteId) return;
    try {
      await api.delete(`/announcements/${pendingDeleteId}`);
      await fetchAnnouncements();
      addToast("Announcement deleted");
    } catch (err) {
      addToast(err.response?.data?.message || "Error deleting", "error");
    } finally { setPendingDeleteId(null); }
  };

  /* ── derived counts & filter ── */
  const activeCount    = items.filter(a =>  a.is_active && !isExpired(a) && !isScheduled(a)).length;
  const scheduledCount = items.filter(a =>  a.is_active && !isExpired(a) &&  isScheduled(a)).length;
  const inactiveCount  = items.filter(a => !a.is_active && !isExpired(a)).length;
  const expiredCount   = items.filter(a => isExpired(a)).length;

  const filtered = items.filter(a => {
    const expired   = isExpired(a);
    const scheduled = isScheduled(a);
    let passTab = true;
    if (tab === "Active")    passTab = a.is_active && !expired && !scheduled;
    else if (tab === "Scheduled") passTab = a.is_active && !expired && scheduled;
    else if (tab === "Inactive")  passTab = !a.is_active && !expired;
    else if (tab === "Expired")   passTab = expired;
    if (!passTab) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      a.title?.toLowerCase().includes(q) ||
      a.category?.toLowerCase().includes(q) ||
      a.priority?.toLowerCase().includes(q)
    );
  });

  /* ── read % helper ── */
  const readPct = (ann) => {
    const total = ann.total_audience ?? 0;
    const count = ann.read_count     ?? 0;
    if (!total) return null;
    return { count, total, pct: Math.round((count / total) * 100) };
  };

  const priMeta = (p) => PRIORITIES.find(x => x.value === p) ?? PRIORITIES[1];

  return (
    <div className="ann-root">
      <ConfirmDialog
        open={pendingDiscardChanges}
        title="Discard Changes"
        message="You have unsaved changes. Discard and close?"
        confirmLabel="Discard"
        variant="warning"
        onConfirm={() => { setPendingDiscardChanges(false); setShowDrawer(false); }}
        onCancel={() => setPendingDiscardChanges(false)}
      />

      {/* ── Header ── */}
      <div className="ann-header">
        <div className="ann-header-l">
          <h1>Announcements</h1>
          <p>
            {items.length} total · {activeCount} active
            {scheduledCount > 0 && ` · ${scheduledCount} scheduled`}
            {` · ${inactiveCount} inactive`}
            {expiredCount > 0 && ` · ${expiredCount} expired`}
          </p>
        </div>
        <button className="ann-btn-primary" onClick={openCreate}>
          <Plus size={14} /> New Announcement
        </button>
      </div>

      {/* ── Error banner ── */}
      {error && <div className="ann-error">{error}</div>}

      {/* ── Tabs + Search row ── */}
      <div className="ann-toolbar">
        <div className="ann-tabs">
          {TABS.map(t => {
            const count =
              t === "Active"    ? activeCount :
              t === "Scheduled" ? scheduledCount :
              t === "Inactive"  ? inactiveCount :
              t === "Expired"   ? expiredCount :
              items.length;
            return (
              <button key={t}
                className={`ann-tab${tab === t ? " active" : ""}`}
                onClick={() => setTab(t)}>
                {t}{t !== "All" ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>
        <div className="ann-search-wrap">
          <Search size={13} className="ann-search-icon" />
          <input
            className="ann-search-input"
            placeholder="Search by title, category…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="ann-search-clear" onClick={() => setSearch("")}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* ── List ── */}
      <div className="ann-list">
        {loading ? (
          <div className="ann-empty">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="ann-empty">
            {search ? `No announcements matching "${search}"` : "No announcements in this category"}
          </div>
        ) : filtered.map(ann => {
          const tgt      = targetLabel(ann.target_type, ann.target_value);
          const expired  = isExpired(ann);
          const sched    = isScheduled(ann);
          const days     = daysLeft(ann);
          const expSoon  = !expired && days !== null && days >= 0 && days <= 3;
          const reads    = readPct(ann);
          const pri      = priMeta(ann.priority);

          return (
            <div key={ann.id}
              className={`ann-card ${expired ? "expired" : ann.is_active ? "active" : "inactive"}${ann.is_pinned ? " pinned" : ""}`}>

              <div className={`ann-card-icon${expired ? " expired" : ""}`}>
                <Megaphone size={16} />
              </div>

              <div className="ann-card-body">
                <div className="ann-card-top">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ann-card-title">
                      {ann.is_pinned && <Pin size={11} style={{ marginRight: 4, verticalAlign: "middle", color: "#92400e" }} />}
                      {ann.title}
                    </div>
                    <div className="ann-meta-row">
                      {/* Status badge */}
                      {expired ? (
                        <span className="ann-badge ann-badge-expired">Expired</span>
                      ) : sched ? (
                        <span className="ann-badge ann-badge-scheduled">
                          <CalendarClock size={9} style={{ marginRight: 3, verticalAlign: "middle" }} />
                          Goes live {fmtScheduledAt(ann.publish_at)}
                        </span>
                      ) : ann.is_active ? (
                        <span className="ann-badge ann-badge-active">Active</span>
                      ) : (
                        <span className="ann-badge ann-badge-inactive">Inactive</span>
                      )}
                      {/* Priority */}
                      <span className={`ann-badge ${pri.cls}`}>{pri.label}</span>
                      {/* Category */}
                      {ann.category && ann.category !== "General" && (
                        <span className="ann-badge ann-badge-category">{ann.category}</span>
                      )}
                      {/* Pin */}
                      {ann.is_pinned && (
                        <span className="ann-badge ann-badge-pinned">📌 Pinned</span>
                      )}
                      {/* Audience */}
                      <span className={`ann-badge ${tgt.cls}`}>{tgt.label}</span>
                      {/* Date range */}
                      {ann.from_date && (
                        <span className="ann-badge ann-badge-date">
                          {fmtDate(ann.from_date)} → {fmtDate(ann.to_date)}
                        </span>
                      )}
                      {/* Expiry warning */}
                      {expSoon && (
                        <span className="ann-badge ann-badge-warn">
                          <Clock size={9} style={{ marginRight: 3, verticalAlign: "middle" }} />
                          {days === 0 ? "Expires today" : `${days}d left`}
                        </span>
                      )}
                      {/* Read receipts */}
                      {reads && (
                        <span className="ann-badge ann-badge-reads" title={`${reads.count} of ${reads.total} employees have read this`}>
                          <Users size={9} style={{ marginRight: 3, verticalAlign: "middle" }} />
                          {reads.count}/{reads.total} read ({reads.pct}%)
                        </span>
                      )}
                    </div>
                    {/* Author */}
                    {ann.created_by_name && (
                      <div className="ann-author">
                        Posted by {ann.created_by_name}
                        {ann.created_at && (
                          <> · {new Date(ann.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="ann-card-actions">
                    <button
                      className={`ann-action-btn ${ann.is_pinned ? "unpin" : "pin"}`}
                      onClick={() => handlePin(ann)}
                      title={ann.is_pinned ? "Unpin" : "Pin to top"}>
                      {ann.is_pinned
                        ? <><PinOff size={11} style={{ marginRight: 3 }} />Unpin</>
                        : <><Pin    size={11} style={{ marginRight: 3 }} />Pin</>}
                    </button>
                    {!expired && (
                      <button
                        className={`ann-action-btn ${ann.is_active ? "toggle-on" : "toggle-off"}`}
                        onClick={() => handleToggle(ann)}
                        title={ann.is_active ? "Deactivate" : "Activate"}>
                        {ann.is_active
                          ? <><EyeOff size={11} style={{ marginRight: 3 }} />Hide</>
                          : <><Eye    size={11} style={{ marginRight: 3 }} />Display</>}
                      </button>
                    )}
                    <button className="ann-action-btn edit" onClick={() => openEdit(ann)}>
                      <Pencil size={11} style={{ marginRight: 3 }} />Edit
                    </button>
                    <button className="ann-action-btn del" onClick={() => setPendingDeleteId(ann.id)}>
                      <Trash2 size={11} style={{ marginRight: 3 }} />Delete
                    </button>
                  </div>
                </div>

                {/* Sanitized rich text message */}
                <div
                  className="ann-card-msg"
                  dangerouslySetInnerHTML={{ __html: safe(ann.message) }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Delete confirm ── */}
      {pendingDeleteId && (
        <div className="ann-overlay" onClick={() => setPendingDeleteId(null)}>
          <div className="ann-modal-box" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700 }}>Delete Announcement</h3>
            <p style={{ margin: "0 0 20px", color: "#6b7280", fontSize: 13 }}>
              This announcement will be permanently deleted and cannot be recovered.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="ann-btn-ghost" onClick={() => setPendingDeleteId(null)}>Cancel</button>
              <button className="ann-btn-danger" onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Drawer ── */}
      {showDrawer && (
        <>
          <div className="ann-overlay" onClick={handleCloseDrawer} />
          <div className="ann-drawer">
            <div className="ann-drawer-hd">
              <span>{editingId ? "Edit Announcement" : "New Announcement"}</span>
              <button className="ann-drawer-close" onClick={handleCloseDrawer}>
                <X size={16} />
              </button>
            </div>

            <div className="ann-drawer-body">
              {formErr && <div className="ann-form-err">{formErr}</div>}

              {/* Title */}
              <div>
                <label className="ann-label">
                  Title *
                  <span className="ann-char-count">{form.title.length}/{TITLE_MAX}</span>
                </label>
                <input
                  className="ann-input"
                  placeholder="Announcement title"
                  maxLength={TITLE_MAX}
                  value={form.title}
                  onChange={e => set("title", e.target.value)}
                />
              </div>

              {/* Message */}
              <div>
                <label className="ann-label">Message *</label>
                <RichTextEditor
                  key={drawerKey}
                  drawerKey={drawerKey}
                  value={form.message}
                  onChange={v => set("message", v)}
                />
              </div>

              {/* Priority + Category */}
              <div className="ann-row2">
                <div>
                  <label className="ann-label">Priority</label>
                  <select className="ann-input" value={form.priority}
                    onChange={e => set("priority", e.target.value)}>
                    {PRIORITIES.map(p => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="ann-label">Category</label>
                  <select className="ann-input" value={form.category}
                    onChange={e => set("category", e.target.value)}>
                    {CATEGORIES.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* From / To dates */}
              <div className="ann-row2">
                <div>
                  <label className="ann-label">From Date *</label>
                  <input type="date" className="ann-input"
                    value={form.fromDate}
                    onChange={e => set("fromDate", e.target.value)} />
                </div>
                <div>
                  <label className="ann-label">To Date *</label>
                  <input type="date" className="ann-input"
                    value={form.toDate} min={form.fromDate}
                    onChange={e => set("toDate", e.target.value)} />
                </div>
              </div>
              {form.toDate && form.fromDate && form.toDate < form.fromDate && (
                <p className="ann-field-err">End date cannot be before start date</p>
              )}

              {/* Target Audience */}
              <div>
                <label className="ann-label">Target Audience</label>
                <select className="ann-input" value={form.targetType}
                  onChange={e => { set("targetType", e.target.value); set("targetValue", ""); }}>
                  <option value="all">All Employees</option>
                  <option value="department">Department</option>
                  <option value="employee">Specific Employee</option>
                </select>
              </div>

              {form.targetType === "department" && (
                <div>
                  <label className="ann-label">Department *</label>
                  <select className="ann-input" value={form.targetValue}
                    onChange={e => set("targetValue", e.target.value)}>
                    <option value="">Select department</option>
                    {departments.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              )}

              {form.targetType === "employee" && (
                <div>
                  <label className="ann-label">Employee *</label>
                  <select className="ann-input" value={form.targetValue}
                    onChange={e => set("targetValue", e.target.value)}>
                    <option value="">Select employee</option>
                    {employees.map(e => (
                      <option key={e.id} value={String(e.id)}>
                        {`${e.first_name ?? ""} ${e.last_name ?? ""}`.trim() || e.name || `#${e.id}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Status + Pin */}
              <div className="ann-row2">
                <div>
                  <label className="ann-label">Status</label>
                  <select className="ann-input"
                    value={form.isActive ? "active" : "inactive"}
                    onChange={e => set("isActive", e.target.value === "active")}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive (Draft)</option>
                  </select>
                </div>
                <div>
                  <label className="ann-label ann-pin-label">
                    <input type="checkbox"
                      checked={form.isPinned}
                      onChange={e => set("isPinned", e.target.checked)} />
                    Pin to top
                  </label>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                    Pinned posts stay above all others
                  </div>
                </div>
              </div>

              {/* Scheduled Publish */}
              <div>
                <label className="ann-label">
                  <CalendarClock size={12} style={{ marginRight: 5, verticalAlign: "middle" }} />
                  Scheduled Publish (optional)
                </label>
                <input type="datetime-local" className="ann-input"
                  value={form.publishAt}
                  min={`${form.fromDate}T00:00`}
                  onChange={e => set("publishAt", e.target.value)} />
                <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9ca3af" }}>
                  Leave blank to publish immediately when Active.
                </p>
              </div>
            </div>

            <div className="ann-drawer-ft">
              <button className="ann-btn-ghost" onClick={handleCloseDrawer}>Cancel</button>
              <button className="ann-btn-primary" onClick={handleSave} disabled={submitting}>
                {submitting ? "Saving…" : editingId ? "Update Announcement" : "Post Announcement"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Toast stack ── */}
      <Toast toasts={toasts} remove={removeToast} />
    </div>
  );
}
