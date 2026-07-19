import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Bell, Eye, ExternalLink, Send, Users } from "lucide-react";
import api from "@/services/api/client";
import { useAuth } from "@/context/AuthContext";
import ResultDialog from "@/components/ResultDialog";
import "./Policies.css";

const DEFAULT_CATEGORIES = [
  "Leave", "Travel", "Attendance", "Uniform",
  "Code of Conduct", "POSH", "IT & Device Usage",
  "Work From Home", "Expense Reimbursement", "Data Privacy",
  "Grievance", "Social Media",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const semverLike = (v = "") => {
  const m = String(v).trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i);
  if (!m) return [0, 0, 0];
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
};

const nextVersion = (versions = []) => {
  const max = versions
    .map(semverLike)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    .pop() || [0, 0, 0];
  return `v${max[0]}.${max[1] + 1}`;
};

function toYMD(date) {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function drivePreviewUrl(url) {
  if (!url) return null;
  const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  return m ? `https://drive.google.com/file/d/${m[1]}/preview` : null;
}

function isDriveUrl(url) {
  return Boolean(url?.includes("drive.google.com"));
}

function validatePolicyUrl(url) {
  if (!url?.trim()) return "Policy URL is required.";
  if (!url.startsWith("http://") && !url.startsWith("https://")) return "URL must start with https://";
  if (
    url.includes("drive.google.com") &&
    !url.includes("/file/d/") &&
    !url.includes("/open?id=")
  ) {
    return "Paste an individual file link, not a folder link. In Drive: right-click the file → Share → Copy link.";
  }
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Policies() {
  // Employees are view-only: they can read policies and acknowledge them, but
  // never link, version, remind, or delete. Mirrors the backend
  // requirePermission('hr', …) gates on the write endpoints.
  const { hasPermission } = useAuth();
  const canManage = hasPermission("hr", "add") || hasPermission("hr", "edit");

  const [allPolicies, setAllPolicies]         = useState([]);
  const [acknowledgements, setAcknowledgements] = useState(new Set());
  const [ackCounts, setAckCounts]             = useState({});
  const [totalEmployees, setTotalEmployees]   = useState(0);
  const [loading, setLoading]                 = useState(true);

  // Form state
  const [showFormFor, setShowFormFor]         = useState("");
  const [policyName, setPolicyName]           = useState("");
  const [policyVersion, setPolicyVersion]     = useState("");
  const [policyFileUrl, setPolicyFileUrl]     = useState("");
  const [customCategory, setCustomCategory]   = useState("");
  const [changelog, setChangelog]             = useState("");
  const [effectiveDate, setEffectiveDate]     = useState("");
  const [reviewDate, setReviewDate]           = useState("");
  const [requiresAck, setRequiresAck]         = useState(false);
  const [saving, setSaving]                   = useState(false);

  // Modal / dialog state
  const [dialog, setDialog]                   = useState(null);
  const [pendingDelete, setPendingDelete]     = useState(null);
  const [viewerPolicy, setViewerPolicy]       = useState(null);
  const [viewingAcks, setViewingAcks]         = useState(null);
  const [policyAcks, setPolicyAcks]           = useState([]);
  const [reminderState, setReminderState]     = useState({});

  const abortRef = useRef(null);

  const user = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("user") || "{}"); } catch (_e) { return {}; }
  }, []);
  const userId = user?.id || user?.employee_id || null;

  // ── Fetchers (stable refs via useCallback) ─────────────────────────────────

  const fetchPolicies = useCallback(async (signal) => {
    try {
      const res = await api.get("/hr/policies", signal ? { signal } : {});
      const rows = Array.isArray(res.data) ? res.data : [];
      setAllPolicies(rows.map((p) => ({
        ...p,
        displayName:    p.title || p.name || "Policy",
        displayVersion: p.version || "v1.0",
        fileUrl:        p.drive_url || p.file_url || "",
        effectiveDate:  p.effective_date || "",
        reviewDate:     p.review_date || "",
        changelog:      p.description || "",
      })));
    } catch (err) {
      if (err.name === "CanceledError" || err.code === "ERR_CANCELED") return;
      setDialog({ type: "error", title: "Failed", message: "Could not load policies." });
    }
  }, []);

  const fetchMyAcknowledgements = useCallback(async (signal) => {
    try {
      const res = await api.get("/hr/policies/my-acknowledgements", signal ? { signal } : {});
      const ids = Array.isArray(res.data) ? res.data : [];
      setAcknowledgements(new Set(ids.map(Number)));
    } catch (_err) {
      // non-critical — acknowledgements are refreshed after each action
    }
  }, []);

  const fetchAckCounts = useCallback(async (signal) => {
    try {
      const res = await api.get("/hr/policies/acknowledgement-counts", signal ? { signal } : {});
      setAckCounts(res.data?.counts || {});
      setTotalEmployees(res.data?.total_employees || 0);
    } catch (_err) {
      // non-critical
    }
  }, []);

  // ── Initial load ───────────────────────────────────────────────────────────

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;

    setLoading(true);
    Promise.all([
      fetchPolicies(signal),
      fetchMyAcknowledgements(signal),
      fetchAckCounts(signal),
    ]).finally(() => setLoading(false));

    return () => abortRef.current?.abort();
  }, [fetchPolicies, fetchMyAcknowledgements, fetchAckCounts]);

  // ── Derived state ──────────────────────────────────────────────────────────

  const categories = useMemo(() => {
    const set = new Set(DEFAULT_CATEGORIES);
    allPolicies.forEach((p) => { if (p.category) set.add(p.category); });
    if (customCategory.trim()) set.add(customCategory.trim());
    return Array.from(set);
  }, [allPolicies, customCategory]);

  const groupedByCategory = useMemo(() => {
    const map = {};
    categories.forEach((c) => { map[c] = []; });
    allPolicies.forEach((p) => {
      const c = p.category || "General";
      if (!map[c]) map[c] = [];
      map[c].push(p);
    });
    Object.keys(map).forEach((c) => {
      map[c].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    });
    return map;
  }, [allPolicies, categories]);

  const dueForReview = useMemo(() => allPolicies.filter((p) => {
    if (!p.reviewDate) return false;
    const d = new Date(p.reviewDate);
    if (Number.isNaN(d.getTime())) return false;
    const days = Math.floor((d - Date.now()) / 86400000);
    return days >= 0 && days <= 30;
  }), [allPolicies]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const ackSummary = useCallback((policies = []) => {
    if (!policies.length) return { label: "0%", pct: 0 };

    // HR view: show server-aggregated employee counts when available
    let totalAck = 0;
    let coveredPolicies = 0;
    policies.forEach((p) => {
      const c = ackCounts[p.id];
      if (c) { totalAck += c.acknowledged; coveredPolicies++; }
    });

    if (coveredPolicies > 0 && totalEmployees > 0) {
      const denominator = totalEmployees * coveredPolicies;
      const pct = Math.min(100, Math.round((totalAck / denominator) * 100));
      return { label: `${pct}% (${totalAck} / ${totalEmployees} employees per policy)`, pct };
    }

    // Fallback: current user's own acknowledgements
    const acked = policies.filter((p) => acknowledgements.has(p.id)).length;
    const pct = Math.round((acked / policies.length) * 100);
    return { label: `${pct}%`, pct };
  }, [ackCounts, totalEmployees, acknowledgements]);

  const resetForm = useCallback(() => {
    setPolicyName(""); setPolicyVersion(""); setPolicyFileUrl(""); setCustomCategory("");
    setChangelog(""); setEffectiveDate(""); setReviewDate(""); setRequiresAck(false);
    setShowFormFor("");
  }, []);

  const notifyPolicyUpdate = useCallback(async ({ title, version, category, changelog: cl, effectiveDate: goLive }) => {
    try {
      await api.post("/notifications/policy-update", {
        title, version, category, changelog: cl, effective_date: goLive || null,
      });
    } catch (_err) {
      // optional integration — ignore when unavailable
    }
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleAddPolicy = async (category) => {
    const cat = customCategory.trim() || category;
    if (!policyName.trim() || !policyVersion.trim() || !cat.trim()) {
      setDialog({ type: "warning", title: "Required", message: "Policy name, version and category are required." });
      return;
    }
    const urlError = validatePolicyUrl(policyFileUrl);
    if (urlError) {
      setDialog({ type: "warning", title: "Invalid URL", message: urlError });
      return;
    }
    setSaving(true);
    try {
      await api.post("/hr/policies", {
        title: policyName.trim(),
        name: policyName.trim(),
        version: policyVersion.trim(),
        category: cat,
        description: changelog || "",
        file_url: policyFileUrl,
        effective_date: effectiveDate || null,
        review_date: reviewDate || null,
        requires_acknowledgement: requiresAck,
      });
      notifyPolicyUpdate({ title: policyName, version: policyVersion, category: cat, changelog, effectiveDate });
      resetForm();
      await Promise.all([fetchPolicies(), fetchAckCounts()]);
      setDialog({ type: "success", title: "Saved", message: "Policy linked successfully.", autoClose: 1800 });
    } catch (_err) {
      setDialog({ type: "error", title: "Failed", message: "Error saving policy." });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateNextVersion = (policy) => {
    const versions = allPolicies
      .filter((p) => p.displayName?.trim().toLowerCase() === policy.displayName?.trim().toLowerCase())
      .map((p) => p.displayVersion);
    setPolicyName(policy.displayName);
    setPolicyVersion(nextVersion(versions));
    setCustomCategory(policy.category || "");
    setPolicyFileUrl(policy.fileUrl || "");
    setShowFormFor(policy.category || "General");
    setDialog({ type: "info", title: "New Version", message: "Update the URL and changelog, then save as the next version.", autoClose: 2000 });
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.delete(`/hr/policies/${pendingDelete.id}`);
      setDialog({ type: "success", title: "Deleted", message: "Policy deleted.", autoClose: 1500 });
      await fetchPolicies();
    } catch (_err) {
      setDialog({ type: "error", title: "Failed", message: "Error deleting policy." });
    } finally {
      setPendingDelete(null);
    }
  };

  const handleAcknowledge = async (policyId) => {
    try {
      await api.post(`/hr/policies/${policyId}/acknowledge`, { employee_id: userId });
      setAcknowledgements((prev) => new Set([...prev, policyId]));
      setDialog({ type: "success", title: "Acknowledged", message: "Acknowledgement recorded.", autoClose: 1400 });
      fetchAckCounts(); // refresh counts in background
    } catch (_err) {
      setDialog({ type: "error", title: "Failed", message: "Could not record acknowledgement." });
    }
  };

  const handleSendReminder = async (policy) => {
    setReminderState((s) => ({ ...s, [policy.id]: "sending" }));
    try {
      const res = await api.post(`/hr/policies/${policy.id}/send-reminder`);
      setDialog({ type: "success", title: "Reminder Queued", message: res.data?.message || "Reminder queued.", autoClose: 2500 });
    } catch (_err) {
      setDialog({ type: "error", title: "Failed", message: "Could not send reminder." });
    } finally {
      setReminderState((s) => ({ ...s, [policy.id]: "done" }));
    }
  };

  const handleViewAcks = async (policy) => {
    setViewingAcks(policy);
    setPolicyAcks([]);
    try {
      const res = await api.get(`/hr/policies/${policy.id}/acknowledgements`);
      setPolicyAcks(Array.isArray(res.data) ? res.data : []);
    } catch (_err) {
      setPolicyAcks([]);
    }
  };

  // ── Viewer ─────────────────────────────────────────────────────────────────

  const renderViewer = (policy) => {
    const url = policy.fileUrl;
    if (!url || url === "#") {
      return <div className="pol-empty">No file URL linked to this policy.</div>;
    }
    if (isDriveUrl(url)) {
      const preview = drivePreviewUrl(url);
      if (preview) {
        return <iframe title="Policy Viewer" src={preview} className="pol-iframe" allow="autoplay" />;
      }
      return (
        <a href={url} target="_blank" rel="noreferrer" className="pol-open-link">
          <ExternalLink size={14} style={{ marginRight: 6 }} />
          Open in Google Drive
        </a>
      );
    }
    if (url.toLowerCase().endsWith(".pdf")) {
      return <iframe title="Policy Viewer" src={url} className="pol-iframe" />;
    }
    return (
      <a href={url} target="_blank" rel="noreferrer" className="pol-open-link">
        <ExternalLink size={14} style={{ marginRight: 6 }} />
        Open Policy File
      </a>
    );
  };

  // ── Section renderer ───────────────────────────────────────────────────────

  const renderPolicySection = (title, policies, category) => {
    const { label: ackLabel } = ackSummary(policies);
    return (
      <div className="pol-sec" key={category}>
        <div className="pol-header">
          <div>
            <h2>{title}</h2>
            <div className="pol-sub">
              Policies: {policies.length} | Acknowledgement: {ackLabel}
            </div>
          </div>
          {canManage && (
            <button
              type="button"
              className="pol-primary-btn"
              onClick={() => setShowFormFor(showFormFor === category ? "" : category)}
            >
              {showFormFor === category ? "Cancel" : "Link Policy"}
            </button>
          )}
        </div>

        {canManage && showFormFor === category && (
          <div className="pol-card pol-form">
            <div className="pol-grid">
              <div>
                <label>Policy Name *</label>
                <input
                  value={policyName}
                  onChange={(e) => setPolicyName(e.target.value)}
                  placeholder="e.g. Leave Policy 2026"
                />
              </div>
              <div>
                <label>Version *</label>
                <input
                  value={policyVersion}
                  onChange={(e) => setPolicyVersion(e.target.value)}
                  placeholder="v1.0"
                />
              </div>
              <div>
                <label>Category *</label>
                <input
                  value={customCategory || category}
                  onChange={(e) => setCustomCategory(e.target.value)}
                  placeholder="Custom category"
                />
              </div>
              <div>
                <label>Effective Date</label>
                <input
                  type="date"
                  value={effectiveDate}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                />
              </div>
              <div>
                <label>Review Date</label>
                <input
                  type="date"
                  value={reviewDate}
                  onChange={(e) => setReviewDate(e.target.value)}
                />
              </div>
              <div className="full">
                <label>Google Drive URL or File URL *</label>
                <input
                  value={policyFileUrl}
                  onChange={(e) => setPolicyFileUrl(e.target.value)}
                  placeholder="https://drive.google.com/file/d/… or https://example.com/policy.pdf"
                />
                <div className="pol-url-hint">
                  Paste a Google Drive file sharing link or any direct file URL.
                  For Drive: open the file → Share → Copy link.
                </div>
              </div>
              <div className="full">
                <label>Changelog / Description</label>
                <textarea
                  value={changelog}
                  onChange={(e) => setChangelog(e.target.value)}
                  placeholder="What changed in this version?"
                />
              </div>
              <div className="full pol-ack-toggle">
                <label className="pol-toggle-label">
                  <input
                    type="checkbox"
                    checked={requiresAck}
                    onChange={(e) => setRequiresAck(e.target.checked)}
                  />
                  <span>Require employee acknowledgement</span>
                </label>
                <div className="pol-url-hint">
                  When enabled, employees will be prompted to acknowledge reading this policy.
                </div>
              </div>
            </div>
            <button
              type="button"
              className="pol-primary-btn"
              onClick={() => handleAddPolicy(category)}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save Policy"}
            </button>
          </div>
        )}

        <div className="pol-card">
          {loading ? (
            <div className="pol-loading">Loading policies…</div>
          ) : policies.length === 0 ? (
            <div className="pol-empty">No policies linked yet</div>
          ) : (
            <table className="pol-table">
              <thead>
                <tr>
                  <th>Policy Name</th>
                  <th>Version</th>
                  <th>Effective</th>
                  <th>Review</th>
                  <th>Acknowledgement</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => {
                  const acked       = acknowledgements.has(policy.id);
                  const reviewSoon  = policy.reviewDate &&
                    (new Date(policy.reviewDate) - Date.now()) / 86400000 <= 30 &&
                    (new Date(policy.reviewDate) - Date.now()) / 86400000 >= 0;
                  const counts      = ackCounts[policy.id];
                  const isSending   = reminderState[policy.id] === "sending";

                  return (
                    <tr key={policy.id}>
                      <td>
                        <div className="pol-name">{policy.displayName}</div>
                        <div className="pol-file">
                          {isDriveUrl(policy.fileUrl)
                            ? <span style={{ color: "#4285F4" }}>Google Drive</span>
                            : policy.fileUrl
                              ? policy.fileUrl.split("/").pop()
                              : "No file linked"}
                        </div>
                        {policy.requires_acknowledgement && (
                          <span className="pol-ack-required-badge">Ack required</span>
                        )}
                      </td>
                      <td>{policy.displayVersion}</td>
                      <td>{policy.effectiveDate ? toYMD(policy.effectiveDate) : "—"}</td>
                      <td>
                        {policy.reviewDate ? toYMD(policy.reviewDate) : "—"}
                        {reviewSoon && <span className="pol-pill">Review Due</span>}
                      </td>
                      <td>
                        {counts && totalEmployees > 0 ? (
                          <div>
                            <div className="pol-ack-count">
                              {counts.acknowledged} / {totalEmployees} employees
                            </div>
                            <div className="pol-ack-bar">
                              <div
                                className="pol-ack-bar-fill"
                                style={{ width: `${Math.round((counts.acknowledged / totalEmployees) * 100)}%` }}
                              />
                            </div>
                          </div>
                        ) : acked ? (
                          <span className="pol-ack yes">Read & Accepted</span>
                        ) : (
                          <button
                            type="button"
                            className="pol-ack-btn"
                            onClick={() => handleAcknowledge(policy.id)}
                          >
                            Acknowledge
                          </button>
                        )}
                      </td>
                      <td>
                        <div className="pol-actions">
                          <button
                            type="button"
                            className="pol-action-btn"
                            title="View policy"
                            onClick={() => setViewerPolicy(policy)}
                          >
                            <Eye size={13} /> View
                          </button>
                          {canManage && (
                            <>
                              <button
                                type="button"
                                className="pol-action-btn"
                                title="Create next version"
                                onClick={() => handleCreateNextVersion(policy)}
                              >
                                <BookOpen size={13} /> New Ver.
                              </button>
                              <button
                                type="button"
                                className="pol-action-btn"
                                title="View acknowledgement list"
                                onClick={() => handleViewAcks(policy)}
                              >
                                <Users size={13} /> Acks
                              </button>
                              <button
                                type="button"
                                className="pol-action-btn"
                                title="Send reminder to unacknowledged employees"
                                disabled={isSending}
                                onClick={() => handleSendReminder(policy)}
                              >
                                <Send size={13} /> {isSending ? "…" : "Remind"}
                              </button>
                              <button
                                type="button"
                                className="pol-danger-btn"
                                onClick={() => setPendingDelete(policy)}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="pol-page">
      <ResultDialog dialog={dialog} onClose={() => setDialog(null)} />

      <div className="pol-top">
        <h1>Policy Documents</h1>
        {dueForReview.length > 0 && (
          <div className="pol-review-alert">
            <Bell size={14} />
            {dueForReview.length} {dueForReview.length === 1 ? "policy" : "policies"} due for review in the next 30 days
          </div>
        )}
      </div>

      {categories.map((c) => renderPolicySection(`${c} Policy`, groupedByCategory[c] || [], c))}

      {/* ── Policy Viewer ── */}
      {viewerPolicy && (
        <div className="pol-view-backdrop" onClick={() => setViewerPolicy(null)}>
          <div className="pol-view-box" onClick={(e) => e.stopPropagation()}>
            <div className="pol-view-head">
              <h3>{viewerPolicy.displayName} ({viewerPolicy.displayVersion})</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {viewerPolicy.fileUrl && viewerPolicy.fileUrl !== "#" && (
                  <a
                    href={viewerPolicy.fileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="pol-action-btn"
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
                  >
                    <ExternalLink size={13} /> Open
                  </a>
                )}
                <button type="button" onClick={() => setViewerPolicy(null)}>Close</button>
              </div>
            </div>
            {renderViewer(viewerPolicy)}
            {!acknowledgements.has(viewerPolicy.id) && (
              <div style={{ marginTop: 10, textAlign: "center" }}>
                <button
                  type="button"
                  className="pol-primary-btn"
                  onClick={() => {
                    handleAcknowledge(viewerPolicy.id);
                    setViewerPolicy(null);
                  }}
                >
                  I have read and understood this policy — Acknowledge
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Acknowledgement list ── */}
      {viewingAcks && (
        <div className="pol-view-backdrop" onClick={() => setViewingAcks(null)}>
          <div className="pol-view-box" onClick={(e) => e.stopPropagation()}>
            <div className="pol-view-head">
              <h3>
                Acknowledgements — {viewingAcks.displayName} ({viewingAcks.displayVersion})
              </h3>
              <button type="button" onClick={() => setViewingAcks(null)}>Close</button>
            </div>
            {policyAcks.length === 0 ? (
              <div className="pol-empty">No employees have acknowledged this policy yet.</div>
            ) : (
              <table className="pol-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Acknowledged At</th>
                  </tr>
                </thead>
                <tbody>
                  {policyAcks.map((a) => (
                    <tr key={a.id}>
                      <td>{a.employee_name || `Employee #${a.employee_id}`}</td>
                      <td>
                        {a.acknowledged_at
                          ? new Date(a.acknowledged_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── Delete confirm ── */}
      {pendingDelete && (
        <div className="pol-view-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="pol-confirm-box" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Policy</h3>
            <p>
              Delete "{pendingDelete.displayName}" ({pendingDelete.displayVersion})?
              This cannot be undone.
            </p>
            <div className="pol-confirm-actions">
              <button type="button" onClick={() => setPendingDelete(null)}>Cancel</button>
              <button type="button" className="danger" onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
