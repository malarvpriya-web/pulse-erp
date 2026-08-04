// Case-insensitive substring search across one or more fields of a record.
// Each entry in `fields` is either a property key on `record`, or a getter
// function `(record) => value` for derived/fallback-chained values (e.g.
// `r => r.name || r.full_name`). Extracted from the near-identical
// `(x || '').toLowerCase().includes(search.toLowerCase())` chains that were
// duplicated (with different field lists) across several Recruitment pages.
export const matchesSearch = (record, fields, search) => {
  if (!search) return true;
  const needle = search.toLowerCase();
  return fields.some((f) => {
    const value = typeof f === 'function' ? f(record) : record[f];
    return String(value || '').toLowerCase().includes(needle);
  });
};
