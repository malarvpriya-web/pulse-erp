/**
 * Export an array of objects to a CSV file download.
 * @param {Array}   rows      - data rows (array of plain objects)
 * @param {string}  filename  - download filename without extension
 * @param {Object}  colMap    - optional { key: 'Column Header' } mapping
 *                             If omitted, uses raw object keys as headers
 */
export function exportCSV(rows, filename, colMap) {
  if (!rows?.length) return;

  const keys    = colMap ? Object.keys(colMap)   : Object.keys(rows[0]);
  const headers = colMap ? Object.values(colMap) : keys;

  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csv = [
    headers.join(','),
    ...rows.map(row => keys.map(k => escape(row[k])).join(',')),
  ].join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${filename}_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export data as a JSON file download (useful for audit logs, configs).
 * @param {*}      data     - any JSON-serialisable value
 * @param {string} filename - download filename without extension
 */
export function exportJSON(data, filename) {
  const blob = new Blob(
    [JSON.stringify(data, null, 2)],
    { type: 'application/json' }
  );
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${filename}_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
