import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

/**
 * Headcount by department.
 *
 * This chart used to be titled "Dept Headcount vs Target" and drew a grey
 * "Target" bar behind each department. That target was `Math.ceil(headcount * 1.1)`,
 * computed in metricsEngine.js — i.e. the headcount itself, restated. Every
 * department therefore rendered at exactly 91% "fill", forever, and the colour
 * coding that keyed off that percentage was meaningless. There is no
 * approved-headcount or establishment column anywhere in this schema, so the
 * target series has been removed rather than approximated.
 *
 * If a budgeted-headcount field is added later, emit it as `target` from
 * computeDeptWorkforce and restore the second <Bar> plus the fill-rate colouring.
 */
export default function DepartmentStrengthChart({ data = [], loading }) {
  const rows = [...data].sort((a, b) => (b.headcount || 0) - (a.headcount || 0));
  const total = rows.reduce((s, d) => s + (d.headcount || 0), 0);

  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>Headcount by Department</span>
        {total > 0 && (
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {total} employee{total === 1 ? '' : 's'} across {rows.length} department{rows.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ height: 200, borderRadius: 8, background: '#f9fafb' }} />
      ) : rows.length === 0 ? (
        <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13 }}>
          No employees match the selected filters
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10, fill: '#9ca3af' }} allowDecimals={false} />
            <YAxis dataKey="dept" type="category" tick={{ fontSize: 11, fill: '#374151' }} width={60} />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
              formatter={v => [`${v} employee${v === 1 ? '' : 's'}`, 'Headcount']}
            />
            <Bar dataKey="headcount" fill="#6366f1" radius={[0, 3, 3, 0]} name="Headcount" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
