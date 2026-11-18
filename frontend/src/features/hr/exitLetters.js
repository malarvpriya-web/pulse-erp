// Relieving / experience letters (§276): GET /exit/employee/:id/letter/:kind → PDF.
// Shared by Exit Management (Active Exits) and Ex-Employees.
import api from '@/services/api/client';

// The server's EXITED_STATUSES (backend/src/shared/employeeStatus.js).
const EXITED = new Set(['left', 'inactive', 'terminated', 'resigned', 'ex-employee', 'ex employee', 'exited', 'relieved', 'absconded']);

/** Has this exit's employee actually left? Letters are issued only then. */
export const hasLeft = (row) => EXITED.has(String(row?.employee_status ?? row?.status ?? '').trim().toLowerCase());

/** The server's reason, out of a JSON error that arrived as a Blob. */
async function blobError(err) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text())?.error; } catch { return null; }
  }
  return data?.error ?? null;
}

/**
 * Download the letter. `notify(message, 'error')` shows why it was refused
 * (still serving notice, absconded, no exit on record…).
 */
export async function downloadExitLetter(employeeId, kind, notify) {
  try {
    const res = await api.get(`/exit/employee/${employeeId}/letter/${kind}`, { responseType: 'blob' });
    const name = /filename="([^"]+)"/.exec(res.headers?.['content-disposition'] || '')?.[1] || `${kind}_letter.pdf`;
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (err) {
    notify?.((await blobError(err)) || `The ${kind} letter could not be created.`, 'error');
    return false;
  }
}
