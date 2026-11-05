import api from '@/services/api/client';

/**
 * Download a succession report as CSV from the server (§210).
 *
 * The server is the only source: it enforces succession:export and
 * neutralises spreadsheet formulas. Both screens used to build the file in the
 * browser instead — Reports whenever the server refused (so a 403 still
 * produced the file), Planning's Bench Strength button always.
 *
 * Throws an Error carrying the server's message. With responseType 'blob' the
 * error body arrives as a Blob, so it is read back as JSON here.
 */
export async function downloadSuccessionCsv(reportId, filename = `${reportId}.csv`) {
  let response;
  try {
    response = await api.get(`/succession/reports/${reportId}`, { params: { format: 'csv' }, responseType: 'blob' });
  } catch (err) {
    let message = 'Export failed';
    const body = err?.response?.data;
    try {
      const parsed = JSON.parse(typeof body?.text === 'function' ? await body.text() : String(body ?? ''));
      if (parsed?.message) message = parsed.message;
    } catch { /* not JSON — keep the generic message */ }
    throw new Error(message);
  }
  const url = URL.createObjectURL(response.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
