import { useState, useEffect, useRef } from "react";
import {
  Download, Plus, Trash2, Search, X, FolderOpen,
  FileText, FileSpreadsheet, FileImage, FileArchive, File,
  ExternalLink, Edit2, Clock, ChevronRight,
} from "lucide-react";
import api from "@/services/api/client";
import { useAuth } from "@/context/AuthContext";

// ── Constants ─────────────────────────────────────────────────────────────────

const DRIVE_ROOT = import.meta.env.VITE_DOCUMENTS_BASE_URL || null;

const CATEGORIES = ["All", "Letters", "Forms", "Onboarding", "Templates", "Policies", "Other"];

const CATEGORY_META = {
  Letters:    { emoji: "✉️",  bg: "#ede9fe", color: "#6B3FDB", desc: "Offer, Appointment, Experience & more" },
  Forms:      { emoji: "📋", bg: "#e0f2fe", color: "#0369a1", desc: "Leave, Expense, Asset & Feedback forms" },
  Onboarding: { emoji: "🚀", bg: "#dcfce7", color: "#15803d", desc: "Checklists, NDA & Data forms" },
  Templates:  { emoji: "📊", bg: "#fef3c7", color: "#92400e", desc: "Attendance, KPI & Review templates" },
  Policies:   { emoji: "📄", bg: "#fee2e2", color: "#dc2626", desc: "HR policies, Code of Conduct & more" },
  Other:      { emoji: "📁", bg: "#f3f4f6", color: "#6b7280", desc: "Miscellaneous HR documents" },
};

const FILE_TYPES = ["PDF", "DOCX", "XLSX", "PPTX", "Other"];

const VISIBLE_TO_OPTIONS = [
  { value: "all",      label: "All Employees" },
  { value: "managers", label: "Managers & Above" },
  { value: "hr_only",  label: "HR Only" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectFileType(url = "") {
  const ext = (url.split(".").pop() || "").toLowerCase().split("?")[0];
  if (["xls", "xlsx", "csv"].includes(ext)) return "XLSX";
  if (["ppt", "pptx"].includes(ext))        return "PPTX";
  if (["doc", "docx"].includes(ext))        return "DOCX";
  if (ext === "pdf")                         return "PDF";
  return null;
}

function fileIcon(type = "", url = "") {
  const t = (type || detectFileType(url) || "").toUpperCase();
  const s = { size: 18 };
  if (["XLSX", "CSV"].includes(t))  return <FileSpreadsheet {...s} />;
  if (["PPTX"].includes(t))         return <FileImage {...s} />;
  if (["PDF"].includes(t))          return <FileText {...s} />;
  if (["DOCX", "DOC"].includes(t))  return <File {...s} />;
  if ((url || "").includes("drive.google")) return <FolderOpen {...s} />;
  return <FileArchive {...s} />;
}

function TypeBadge({ type }) {
  if (!type) return null;
  return (
    <span style={{
      display: "inline-block", padding: "1px 6px", borderRadius: 4,
      fontSize: 9, fontWeight: 700, letterSpacing: "0.5px",
      background: "#f3f4f6", color: "#6b7280", textTransform: "uppercase",
    }}>{type}</span>
  );
}

function VisibilityBadge({ v }) {
  const MAP = {
    hr_only:  { label: "HR Only",   bg: "#fee2e2", color: "#dc2626" },
    managers: { label: "Managers",  bg: "#fef3c7", color: "#92400e" },
    all:      { label: "All Staff", bg: "#dcfce7", color: "#15803d" },
  };
  const m = MAP[v] ?? MAP.all;
  return (
    <span style={{
      display: "inline-block", padding: "1px 7px", borderRadius: 4,
      fontSize: 9, fontWeight: 700, background: m.bg, color: m.color,
    }}>{m.label}</span>
  );
}

function CategoryBadge({ cat }) {
  const m = CATEGORY_META[cat] ?? CATEGORY_META["Other"];
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10,
      fontSize: 10, fontWeight: 600, background: m.bg, color: m.color,
    }}>{cat}</span>
  );
}

function Toast({ message, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 999,
      background: type === "error" ? "#dc2626" : "#16a34a",
      color: "#fff", borderRadius: 10, padding: "12px 18px",
      fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 10,
      boxShadow: "0 4px 20px rgba(0,0,0,0.2)", maxWidth: 360,
    }}>
      <span style={{ flex: 1 }}>{message}</span>
      <button onClick={onClose} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", padding: 0 }}>
        <X size={14} />
      </button>
    </div>
  );
}

const emptyForm = () => ({
  title: "", category: "Letters", description: "",
  file_url: "", file_type: "", visible_to: "all",
});

// ── Drive Quick Access Cards ──────────────────────────────────────────────────

function DriveAccessPanel() {
  const cards = Object.entries(CATEGORY_META).map(([cat, m]) => ({ cat, ...m }));
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>Google Drive — Document Folders</span>
        <span style={{
          background: "#E8E1FC", color: "#6B3FDB", fontSize: 10, fontWeight: 700,
          padding: "2px 8px", borderRadius: 10,
        }}>DRIVE</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))", gap: 10 }}>
        {cards.map(({ cat, emoji, bg, color, desc }) => (
          DRIVE_ROOT ? (
          <a
            key={cat}
            href={DRIVE_ROOT}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "none" }}
          >
            <div style={{
              background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
              padding: "14px 14px 12px", cursor: "pointer",
              transition: "box-shadow .15s, border-color .15s",
            }}
              onMouseEnter={e => {
                e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,.08)";
                e.currentTarget.style.borderColor = color;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.boxShadow = "none";
                e.currentTarget.style.borderColor = "#e5e7eb";
              }}
            >
              <div style={{
                width: 36, height: 36, borderRadius: 8, background: bg,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, marginBottom: 8,
              }}>{emoji}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 3 }}>{cat}</div>
              <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.35, marginBottom: 10 }}>{desc}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: color, fontWeight: 600 }}>
                Open in Drive <ExternalLink size={10} />
              </div>
            </div>
          </a>
          ) : (
          <div key={cat} style={{ textDecoration: "none" }}>
            <div style={{
              background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
              padding: "14px 14px 12px",
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8, background: bg,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18, marginBottom: 8,
              }}>{emoji}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 3 }}>{cat}</div>
              <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.35, marginBottom: 10 }}>{desc}</div>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>Configure VITE_DOCUMENTS_BASE_URL</div>
            </div>
          </div>
          )
        ))}
      </div>
    </div>
  );
}

// ── Register / Edit Modal ─────────────────────────────────────────────────────

function DocModal({ form, setForm, onClose, onSubmit, submitting, formErr, isEdit }) {
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isDriveUrl = form.file_url && (
    form.file_url.includes("drive.google.com") ||
    form.file_url.includes("docs.google.com")
  );

  const handleUrlBlur = () => {
    if (!form.file_type && form.file_url) {
      const detected = detectFileType(form.file_url);
      if (detected) set("file_type", detected);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 14, width: 500, maxWidth: "95vw", boxShadow: "0 8px 40px rgba(0,0,0,.18)", overflow: "hidden" }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #e5e7eb" }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: "#111827" }}>
            {isEdit ? "Edit Document" : "Register Document"}
          </span>
          <button onClick={onClose} style={{ background: "#f3f4f6", border: "none", borderRadius: 7, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14, maxHeight: "65vh", overflowY: "auto" }}>
          {formErr && (
            <div style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 7, padding: "8px 12px", fontSize: 12 }}>{formErr}</div>
          )}

          {/* Document Name */}
          <FieldInput label="Document Name *" value={form.title} onChange={v => set("title", v)}
            placeholder='e.g. "Offer Letter Template 2026"' />

          {/* Drive URL */}
          <FieldInput label="Google Drive URL *" value={form.file_url} onChange={v => set("file_url", v)}
            onBlur={handleUrlBlur}
            placeholder="Paste Google Drive sharing link…" type="url" />
          {isDriveUrl && (
            <div style={{ marginTop: -8, fontSize: 11, color: "#0369a1", display: "flex", alignItems: "center", gap: 4 }}>
              <ExternalLink size={10} /> Drive link detected — file type cannot be auto-detected, please select below.
            </div>
          )}

          {/* Category + File Type row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={labelStyle}>Category *</label>
              <select value={form.category} onChange={e => set("category", e.target.value)} style={inputStyle}>
                {CATEGORIES.filter(c => c !== "All").map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>File Type</label>
              <select value={form.file_type} onChange={e => set("file_type", e.target.value)} style={inputStyle}>
                <option value="">Auto-detect</option>
                {FILE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Visible To */}
          <div>
            <label style={labelStyle}>Visible To</label>
            <select value={form.visible_to} onChange={e => set("visible_to", e.target.value)} style={inputStyle}>
              {VISIBLE_TO_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Description (optional)</label>
            <textarea
              value={form.description}
              onChange={e => set("description", e.target.value)}
              placeholder="Brief description of this document…"
              rows={2}
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
              onFocus={e => { e.target.style.borderColor = "#6B3FDB"; e.target.style.boxShadow = "0 0 0 3px rgba(107,63,219,.1)"; }}
              onBlur={e => { e.target.style.borderColor = "#e5e7eb"; e.target.style.boxShadow = "none"; }}
            />
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "12px 20px", borderTop: "1px solid #e5e7eb" }}>
          <button onClick={onClose} style={{ padding: "8px 16px", background: "#f3f4f6", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", color: "#374151" }}>
            Cancel
          </button>
          <button onClick={onSubmit} disabled={submitting} style={{
            padding: "8px 20px", background: "#6B3FDB", color: "#fff", border: "none",
            borderRadius: 8, fontSize: 13, fontWeight: 600,
            cursor: submitting ? "not-allowed" : "pointer", opacity: submitting ? 0.7 : 1,
          }}>
            {submitting ? (isEdit ? "Saving…" : "Registering…") : (isEdit ? "Save Changes" : "Register Document")}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 };
const inputStyle = {
  width: "100%", padding: "8px 10px", border: "1px solid #e5e7eb",
  borderRadius: 8, fontSize: 13, color: "#111827",
  background: "#fff", outline: "none", boxSizing: "border-box",
};

function FieldInput({ label, value, onChange, onBlur, placeholder, type = "text" }) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        type={type} value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); onBlur?.(); }}
        placeholder={placeholder}
        style={{
          ...inputStyle,
          borderColor: focused ? "#6B3FDB" : "#e5e7eb",
          boxShadow: focused ? "0 0 0 3px rgba(107,63,219,.1)" : "none",
        }}
      />
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Downloads() {
  // Permission-matrix driven (matches backend requirePermission('hr', …) gates):
  // employees get a read-only library — no register/edit/delete, and no Drive
  // folder cards (the root folder is writable for anyone with the Drive link).
  const { hasPermission } = useAuth();
  const isHR = hasPermission("hr", "add") || hasPermission("hr", "edit");

  const [items,      setItems]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [search,     setSearch]     = useState("");
  const [catFilter,  setCatFilter]  = useState("All");
  const [showModal,  setShowModal]  = useState(false);
  const [editItem,   setEditItem]   = useState(null);
  const [form,       setForm]       = useState(emptyForm());
  const [formErr,    setFormErr]    = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [delId,      setDelId]      = useState(null);
  const [toast,      setToast]      = useState(null);
  const abortRef = useRef(null);

  const showToast = (message, type = "success") => setToast({ message, type });

  const fetchDownloads = async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true); setError(null);
    try {
      const res = await api.get("/hr/downloads", { signal: abortRef.current.signal });
      setItems(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      if (e.name !== "CanceledError" && e.code !== "ERR_CANCELED") {
        setError(e.response?.data?.error || e.message || "Failed to load documents");
      }
    } finally { setLoading(false); }
  };

  useEffect(() => {
    fetchDownloads();
    return () => abortRef.current?.abort();
  }, []);

  const openAdd = () => { setEditItem(null); setForm(emptyForm()); setFormErr(null); setShowModal(true); };
  const openEdit = (item) => {
    setEditItem(item);
    setForm({
      title: item.title || "", category: item.category || "Letters",
      description: item.description || "", file_url: item.file_url || "",
      file_type: item.file_type || "", visible_to: item.visible_to || "all",
    });
    setFormErr(null); setShowModal(true);
  };

  const handleSubmit = async () => {
    if (!form.title.trim()) { setFormErr("Document name is required"); return; }
    if (!form.file_url.trim()) { setFormErr("Google Drive URL is required"); return; }
    setSubmitting(true); setFormErr(null);
    try {
      if (editItem) {
        await api.patch(`/hr/downloads/${editItem.id}`, form);
        showToast("Document updated");
      } else {
        await api.post("/hr/downloads", form);
        showToast("Document registered");
      }
      setShowModal(false);
      await fetchDownloads();
    } catch (e) {
      setFormErr(e.response?.data?.error || e.message || "Failed to save document");
    } finally { setSubmitting(false); }
  };

  const handleDelete = async () => {
    if (!delId) return;
    try {
      await api.delete(`/hr/downloads/${delId}`);
      setDelId(null);
      await fetchDownloads();
      showToast("Document deleted");
    } catch (e) {
      showToast(e.response?.data?.error || "Failed to delete", "error");
      setDelId(null);
    }
  };

  const handleOpen = async (item) => {
    try { await api.patch(`/hr/downloads/${item.id}/increment`); } catch (_) { /* non-critical */ }
    window.open(item.file_url, "_blank", "noopener,noreferrer");
  };

  const filtered = items.filter(it => {
    const matchCat = catFilter === "All" || it.category === catFilter;
    const q = search.toLowerCase();
    const matchQ = !q
      || it.title?.toLowerCase().includes(q)
      || it.description?.toLowerCase().includes(q)
      || it.category?.toLowerCase().includes(q);
    return matchCat && matchQ;
  });

  const recentlyAdded = [...items]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5);

  return (
    <div style={{ padding: 24, background: "#f8f9fc", minHeight: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24, gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#111827", margin: "0 0 4px" }}>HR Documents</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: 0 }}>
            {items.length} document{items.length !== 1 ? "s" : ""} available · Powered by Google Drive
          </p>
        </div>
        {isHR && (
          <button
            onClick={openAdd}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              background: "#6B3FDB", color: "#fff", border: "none",
              borderRadius: 8, padding: "8px 16px", fontSize: 13,
              fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
            }}>
            <Plus size={14} /> Register Document
          </button>
        )}
      </div>

      {/* ── Google Drive Quick Access (HR only — folder links are writable) ── */}
      {isHR && <DriveAccessPanel />}

      {/* ── Recently Added ── */}
      {recentlyAdded.length > 0 && (
        <div style={{ marginBottom: 24, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
            <Clock size={14} style={{ color: "#6B3FDB" }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Recently Added</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {recentlyAdded.map(item => (
              <button
                key={item.id}
                onClick={() => handleOpen(item)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  background: "#f8f9fc", border: "1px solid #e5e7eb",
                  borderRadius: 20, padding: "5px 12px", fontSize: 12,
                  fontWeight: 500, color: "#374151", cursor: "pointer",
                  whiteSpace: "nowrap",
                }}>
                {fileIcon(item.file_type, item.file_url)}
                {item.title}
                <ChevronRight size={11} style={{ color: "#9ca3af" }} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Search + Category filter ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 220px", minWidth: 180 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#9ca3af", pointerEvents: "none" }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search documents…"
            style={{
              width: "100%", paddingLeft: 32, paddingRight: 10, paddingTop: 8, paddingBottom: 8,
              border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 13,
              color: "#111827", background: "#fff", outline: "none", boxSizing: "border-box",
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {CATEGORIES.map(cat => (
            <button key={cat}
              onClick={() => setCatFilter(cat)}
              style={{
                padding: "6px 12px", borderRadius: 20, border: "1px solid #e5e7eb",
                fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
                background: catFilter === cat ? "#6B3FDB" : "#fff",
                color: catFilter === cat ? "#fff" : "#374151",
              }}>
              {cat !== "All" && CATEGORY_META[cat] ? `${CATEGORY_META[cat].emoji} ` : ""}{cat}
            </button>
          ))}
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{ background: "#fee2e2", color: "#dc2626", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* ── Document List ── */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 64, color: "#9ca3af", fontSize: 13 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 64, background: "#fff", borderRadius: 12, border: "1px dashed #d1d5db" }}>
          <FolderOpen size={40} style={{ color: "#d1d5db", marginBottom: 12 }} />
          <p style={{ color: "#6b7280", fontSize: 14, margin: "0 0 4px", fontWeight: 600 }}>
            {search || catFilter !== "All" ? "No documents match your search" : "No documents yet"}
          </p>
          <p style={{ color: "#9ca3af", fontSize: 12, margin: 0 }}>
            {search || catFilter !== "All"
              ? "Try a different search term or category filter."
              : isHR ? 'Use "Register Document" to add Drive links.' : "Check back later."}
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filtered.map(item => (
            <div key={item.id} style={{
              background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
              padding: "14px 18px", display: "flex", alignItems: "center", gap: 14,
              transition: "box-shadow .15s",
            }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,.07)"}
              onMouseLeave={e => e.currentTarget.style.boxShadow = "none"}>

              {/* Icon */}
              <div style={{
                width: 40, height: 40, borderRadius: 9, flexShrink: 0,
                background: CATEGORY_META[item.category]?.bg ?? "#f3f4f6",
                color: CATEGORY_META[item.category]?.color ?? "#6b7280",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {fileIcon(item.file_type, item.file_url)}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{item.title}</span>
                  <CategoryBadge cat={item.category || "Other"} />
                  <TypeBadge type={item.file_type} />
                  {isHR && <VisibilityBadge v={item.visible_to || "all"} />}
                </div>
                {item.description && (
                  <p style={{ fontSize: 11, color: "#6b7280", margin: "3px 0 0", lineHeight: 1.4 }}>{item.description}</p>
                )}
                <div style={{ display: "flex", gap: 12, marginTop: 3, flexWrap: "wrap" }}>
                  {item.download_count > 0 && (
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>
                      {item.download_count} open{item.download_count !== 1 ? "s" : ""}
                    </span>
                  )}
                  {item.created_at && (
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>
                      Added {new Date(item.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                    </span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button
                  onClick={() => handleOpen(item)}
                  title="Open in Drive"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "6px 14px", borderRadius: 7, border: "none",
                    background: "#E8E1FC", color: "#6B3FDB",
                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}>
                  <Download size={12} /> Open
                </button>
                {isHR && (
                  <>
                    <button
                      onClick={() => openEdit(item)}
                      title="Edit document"
                      style={{
                        display: "inline-flex", alignItems: "center",
                        padding: "6px 10px", borderRadius: 7, border: "none",
                        background: "#f0fdf4", color: "#15803d",
                        fontSize: 12, cursor: "pointer",
                      }}>
                      <Edit2 size={12} />
                    </button>
                    <button
                      onClick={() => setDelId(item.id)}
                      title="Delete document"
                      style={{
                        display: "inline-flex", alignItems: "center",
                        padding: "6px 10px", borderRadius: 7, border: "none",
                        background: "#fee2e2", color: "#dc2626",
                        fontSize: 12, cursor: "pointer",
                      }}>
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Register / Edit Modal ── */}
      {showModal && (
        <DocModal
          form={form} setForm={setForm}
          onClose={() => setShowModal(false)}
          onSubmit={handleSubmit}
          submitting={submitting} formErr={formErr}
          isEdit={!!editItem}
        />
      )}

      {/* ── Delete Confirm ── */}
      {delId && (
        <div onClick={() => setDelId(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, width: 340, maxWidth: "92vw", boxShadow: "0 8px 32px rgba(0,0,0,.18)" }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700 }}>Delete Document</h3>
            <p style={{ margin: "0 0 20px", color: "#6b7280", fontSize: 13 }}>
              This document registration will be removed. The file in Google Drive is not affected.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setDelId(null)} style={{ padding: "8px 16px", background: "#f3f4f6", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>Cancel</button>
              <button onClick={handleDelete} style={{ padding: "8px 16px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
