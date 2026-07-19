import { useEffect, useMemo, useState } from "react";
import { CalendarDays, List, Upload, Pencil } from "lucide-react";
import api from "@/services/api/client";
import { useAuth } from "@/context/AuthContext";
import ResultDialog from "@/components/ResultDialog";
import "./HolidayCalendar.css";

// Mirrors the backend guard on POST/PATCH/DELETE /holidays — everyone else is view-only.
const HOLIDAY_EDITOR_ROLES = new Set(["super_admin", "admin", "hr", "hr_manager", "hr_exec"]);

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const HOLIDAY_TYPES = ["National", "Regional", "Optional", "Restricted", "Festival"];

const typeColor = (type = "Optional") => {
  const t = String(type).toLowerCase();
  if (t === "national")   return { bg: "#dcfce7", color: "#166534" };
  if (t === "regional")   return { bg: "#dbeafe", color: "#1e3a8a" };
  if (t === "restricted") return { bg: "#fee2e2", color: "#991b1b" };
  if (t === "festival")   return { bg: "#f3e8ff", color: "#6b21a8" };
  return { bg: "#fef3c7", color: "#92400e" };
};

const toYMD = (date) => {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idxName = headers.indexOf("name");
  const idxDate = headers.indexOf("date");
  const idxType = headers.indexOf("type");
  const idxDesc = headers.indexOf("description");
  if (idxName < 0 || idxDate < 0) return [];
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    return {
      name: cols[idxName] || "",
      date: cols[idxDate] || "",
      type: cols[idxType] || "Optional",
      description: cols[idxDesc] || "",
    };
  }).filter((r) => r.name && r.date);
}

const EMPTY_FORM = { name: "", date: "", type: "Optional", description: "", zone_id: "" };

// Extracted so it is stable across renders (no remount on parent re-render)
function HolidayFormFields({ values, onChange, zones }) {
  return (
    <div className="holiday-form-grid">
      <div>
        <label>Holiday Name *</label>
        <input
          value={values.name}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          placeholder="e.g. Republic Day"
          maxLength={100}
        />
      </div>
      <div>
        <label>Date *</label>
        <input
          type="date"
          value={values.date}
          onChange={(e) => onChange({ ...values, date: e.target.value })}
        />
      </div>
      <div>
        <label>Type *</label>
        <select value={values.type} onChange={(e) => onChange({ ...values, type: e.target.value })}>
          {HOLIDAY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label>Description</label>
        <input
          value={values.description}
          onChange={(e) => onChange({ ...values, description: e.target.value })}
          placeholder="Optional notes"
        />
      </div>
      <div>
        <label>Zone / Region</label>
        <select value={values.zone_id} onChange={(e) => onChange({ ...values, zone_id: e.target.value })}>
          <option value="">All Zones (National)</option>
          {zones.map((z) => <option key={z.id} value={String(z.id)}>{z.name}</option>)}
        </select>
      </div>
    </div>
  );
}

export default function HolidayCalendar() {
  const currentYear = new Date().getFullYear();
  const { role } = useAuth();
  const canEdit = HOLIDAY_EDITOR_ROLES.has(String(role || "").toLowerCase());
  const [holidays, setHolidays]       = useState([]);
  const [zones, setZones]             = useState([]);
  const [viewMode, setViewMode]       = useState("list");
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [filterZone, setFilterZone]   = useState("");

  // Add form
  const [showForm, setShowForm]       = useState(false);
  const [form, setForm]               = useState(EMPTY_FORM);
  const [saving, setSaving]           = useState(false);

  // Edit modal
  const [editHoliday, setEditHoliday] = useState(null);
  const [editForm, setEditForm]       = useState(EMPTY_FORM);

  // Delete confirm
  const [pendingDelete, setPendingDelete] = useState(null);

  const [dialog, setDialog]           = useState(null);
  const [importing, setImporting]     = useState(false);

  const showNotAllowed = () => setDialog({
    type: "warning",
    title: "Editing Not Allowed",
    message: "You are logged in as an employee — you are not allowed to edit the holiday calendar. Please contact HR/Admin for any changes.",
  });

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchHolidays = async () => {
    try {
      const res = await api.get(`/holidays?year=${selectedYear}`);
      setHolidays(Array.isArray(res.data) ? res.data : []);
    } catch {
      setDialog({ type: "error", title: "Failed", message: "Could not load holidays." });
    }
  };

  useEffect(() => { fetchHolidays(); }, [selectedYear]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get("/master/zones")
      .then((r) => setZones(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────
  const years = useMemo(
    () => [currentYear - 1, currentYear, currentYear + 1],
    [currentYear],
  );

  const filtered = useMemo(() => {
    if (!filterZone) return holidays;
    return holidays.filter((h) => !h.zone_id || String(h.zone_id) === filterZone);
  }, [holidays, filterZone]);

  const byMonth = useMemo(() => {
    const out = Array.from({ length: 12 }, () => []);
    filtered.forEach((h) => {
      const d = new Date(h.date);
      if (!Number.isNaN(d.getTime())) out[d.getMonth()].push(h);
    });
    out.forEach((arr) => arr.sort((a, b) => new Date(a.date) - new Date(b.date)));
    return out;
  }, [filtered]);

  // ── Duplicate check ────────────────────────────────────────────────────────
  const isDuplicate = (name, date, excludeId = null) =>
    holidays.some(
      (h) =>
        h.name.trim().toLowerCase() === name.trim().toLowerCase() &&
        toYMD(h.date) === date &&
        (excludeId == null || h.id !== excludeId),
    );

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleAdd = async () => {
    if (!form.name || !form.date) {
      setDialog({ type: "warning", title: "Required", message: "Please fill holiday name and date." });
      return;
    }
    if (isDuplicate(form.name, form.date)) {
      setDialog({ type: "warning", title: "Duplicate", message: `"${form.name}" already exists on ${form.date}.` });
      return;
    }
    setSaving(true);
    try {
      await api.post("/holidays", {
        name: form.name,
        date: form.date,
        type: form.type,
        description: form.description,
        zone_id: form.zone_id || null,
      });
      await fetchHolidays();
      setForm(EMPTY_FORM);
      setShowForm(false);
      setDialog({ type: "success", title: "Saved", message: "Holiday added successfully.", autoClose: 1800 });
    } catch (err) {
      const msg = err?.response?.data?.error || "Error adding holiday.";
      setDialog({ type: "error", title: "Failed", message: msg });
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (holiday) => {
    if (!canEdit) { showNotAllowed(); return; }
    setEditHoliday(holiday);
    setEditForm({
      name:        holiday.name || "",
      date:        toYMD(holiday.date),
      type:        holiday.type || "Optional",
      description: holiday.description || "",
      zone_id:     holiday.zone_id ? String(holiday.zone_id) : "",
    });
  };

  const handleEditSave = async () => {
    if (!editForm.name || !editForm.date) {
      setDialog({ type: "warning", title: "Required", message: "Please fill holiday name and date." });
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/holidays/${editHoliday.id}`, {
        name:        editForm.name,
        date:        editForm.date,
        type:        editForm.type,
        description: editForm.description,
        zone_id:     editForm.zone_id || null,
      });
      await fetchHolidays();
      setEditHoliday(null);
      setDialog({ type: "success", title: "Updated", message: "Holiday updated successfully.", autoClose: 1800 });
    } catch (err) {
      const msg = err?.response?.data?.error || "Error updating holiday.";
      setDialog({ type: "error", title: "Failed", message: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.delete(`/holidays/${pendingDelete.id}`);
      await fetchHolidays();
      setDialog({ type: "success", title: "Deleted", message: "Holiday deleted.", autoClose: 1500 });
    } catch {
      setDialog({ type: "error", title: "Failed", message: "Error deleting holiday." });
    } finally {
      setPendingDelete(null);
    }
  };

  const handleImportCsv = async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (!rows.length) {
        setDialog({ type: "warning", title: "No Data", message: "CSV must include name,date columns." });
        return;
      }
      let imported = 0;
      let skipped = 0;
      for (const row of rows) {
        try {
          await api.post("/holidays", {
            name:        row.name,
            date:        row.date,
            type:        HOLIDAY_TYPES.includes(row.type) ? row.type : "Optional",
            description: row.description || "",
          });
          imported++;
        } catch {
          skipped++;
        }
      }
      await fetchHolidays();
      const msg = skipped > 0
        ? `${imported} imported, ${skipped} skipped (duplicates or invalid rows).`
        : `${imported} holidays imported.`;
      setDialog({ type: "success", title: "Imported", message: msg, autoClose: 2500 });
    } catch {
      setDialog({ type: "error", title: "Import Failed", message: "Could not import CSV." });
    } finally {
      setImporting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const activeZoneName = filterZone
    ? zones.find((z) => String(z.id) === filterZone)?.name
    : null;

  return (
    <div className="holiday-page">
      <ResultDialog dialog={dialog} onClose={() => setDialog(null)} />

      {/* Header */}
      <div className="holiday-header">
        <div>
          <h1>Holiday Calendar</h1>
          <p>Manage national, regional, optional and restricted holidays</p>
        </div>
        <div className="holiday-actions">
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(Number(e.target.value))}
            className="holiday-year-select"
          >
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>

          {zones.length > 0 && (
            <select
              value={filterZone}
              onChange={(e) => setFilterZone(e.target.value)}
              className="holiday-year-select"
              title="Filter by zone"
            >
              <option value="">All Zones</option>
              {zones.map((z) => <option key={z.id} value={String(z.id)}>{z.name}</option>)}
            </select>
          )}

          <button
            className="holiday-view-btn"
            onClick={() => setViewMode(viewMode === "list" ? "calendar" : "list")}
          >
            {viewMode === "list" ? <CalendarDays size={14} /> : <List size={14} />}
            {viewMode === "list" ? "Calendar View" : "List View"}
          </button>

          {canEdit && (
            <label
              className={`holiday-import-btn${importing ? " disabled" : ""}`}
            >
              <Upload size={14} />
              {importing ? "Importing..." : "Import CSV"}
              <input
                type="file"
                accept=".csv"
                style={{ display: "none" }}
                disabled={importing}
                onChange={(e) => handleImportCsv(e.target.files?.[0])}
              />
            </label>
          )}

          {canEdit && (
            <button
              className="holiday-primary-btn"
              onClick={() => setShowForm(!showForm)}
            >
              {showForm ? "Cancel" : "Add Holiday"}
            </button>
          )}
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="holiday-card">
          <HolidayFormFields values={form} onChange={setForm} zones={zones} />
          <div className="holiday-form-actions">
            <button className="holiday-primary-btn" onClick={handleAdd} disabled={saving}>
              {saving ? "Saving..." : "Save Holiday"}
            </button>
          </div>
        </div>
      )}

      <div className="holiday-note">
        Leave integration: holidays are fetched by leave/employee views and treated as non-working days.
        {activeZoneName && (
          <> &nbsp;·&nbsp; Showing: national + <strong>{activeZoneName}</strong> holidays</>
        )}
      </div>

      {/* List view */}
      {viewMode === "list" ? (
        <div className="holiday-card">
          {filtered.length === 0 ? (
            <div className="holiday-empty">
              No holidays in {selectedYear}{filterZone ? " for selected zone" : ""}
            </div>
          ) : (
            <table className="holiday-table">
              <thead>
                <tr>
                  <th>Holiday Name</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Zone</th>
                  <th>Description</th>
                  {canEdit && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((holiday) => {
                  const tc = typeColor(holiday.type);
                  return (
                    <tr key={holiday.id}>
                      <td>{holiday.name}</td>
                      <td>{toYMD(holiday.date)}</td>
                      <td>
                        <span className="holiday-type-pill" style={{ background: tc.bg, color: tc.color }}>
                          {holiday.type || "Optional"}
                        </span>
                      </td>
                      <td>
                        {holiday.zone_name
                          ? <span className="holiday-zone-pill">{holiday.zone_name}</span>
                          : <span className="holiday-zone-all">All Zones</span>}
                      </td>
                      <td>{holiday.description || "-"}</td>
                      {canEdit && (
                        <td className="holiday-action-cell">
                          <button className="holiday-edit-btn" onClick={() => openEdit(holiday)} title="Edit holiday">
                            <Pencil size={12} /> Edit
                          </button>
                          <button
                            className="holiday-delete-btn"
                            onClick={() => setPendingDelete(holiday)}
                          >
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        /* Calendar view */
        <div className="holiday-calendar-grid">
          {MONTHS.map((m, i) => (
            <div key={m} className="holiday-month-card">
              <div className="holiday-month-head">
                <h3>{m}</h3>
                <span>{byMonth[i].length}</span>
              </div>
              {byMonth[i].length === 0 ? (
                <div className="holiday-month-empty">No holidays</div>
              ) : (
                <div className="holiday-month-list">
                  {byMonth[i].map((h) => {
                    const tc = typeColor(h.type);
                    return (
                      <div key={h.id} className="holiday-month-item">
                        <div className="holiday-dot" style={{ background: tc.color }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="holiday-month-date">{toYMD(h.date).slice(8, 10)} {m}</div>
                          <div className="holiday-month-name">{h.name}</div>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
                            <span className="holiday-type-pill" style={{ background: tc.bg, color: tc.color }}>
                              {h.type || "Optional"}
                            </span>
                            {h.zone_name && (
                              <span className="holiday-zone-pill">{h.zone_name}</span>
                            )}
                          </div>
                        </div>
                        {canEdit && (
                          <button
                            className="holiday-cal-edit-btn"
                            onClick={() => openEdit(h)}
                            title="Edit"
                          >
                            <Pencil size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Edit modal */}
      {editHoliday && (
        <div className="holiday-confirm-backdrop" onClick={() => setEditHoliday(null)}>
          <div className="holiday-edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="holiday-edit-modal-header">
              <h3>Edit Holiday</h3>
              <button className="holiday-modal-close" onClick={() => setEditHoliday(null)} aria-label="Close">×</button>
            </div>
            <HolidayFormFields values={editForm} onChange={setEditForm} zones={zones} />
            <div className="holiday-form-actions">
              <button className="holiday-cancel-btn" onClick={() => setEditHoliday(null)}>Cancel</button>
              <button className="holiday-primary-btn" onClick={handleEditSave} disabled={saving}>
                {saving ? "Saving..." : "Update Holiday"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {pendingDelete && (
        <div className="holiday-confirm-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="holiday-confirm-box" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Holiday</h3>
            <p>Delete &quot;{pendingDelete.name}&quot; on {toYMD(pendingDelete.date)}?</p>
            <div className="holiday-confirm-actions">
              <button onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="danger" onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
