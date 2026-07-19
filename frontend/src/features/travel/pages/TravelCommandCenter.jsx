import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { TrendingUp, Users, Building2, Briefcase, User, BarChart2 } from 'lucide-react';
import { fmt } from './travelUtils';

const COLORS = ['#6366f1','#6B3FDB','#8b5cf6','#a78bfa','#c4b5fd','#10b981','#f59e0b','#ef4444','#06b6d4','#f97316'];

function MiniBar({ value, max, color = '#6B3FDB' }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ flex: 1, height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width .4s' }} />
    </div>
  );
}

function Section({ title, icon: Icon, color = '#6B3FDB', children }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ background: color + '18', padding: 7, borderRadius: 8 }}>
          <Icon size={15} color={color} />
        </div>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: '#1f2937', margin: 0 }}>{title}</h3>
      </div>
      <div style={{ padding: 20 }}>{children}</div>
    </div>
  );
}

function RankTable({ rows, keyCol, labelCol = 'Name', amountCol, countCol, maxAmount }) {
  return (
    <div>
      {rows.slice(0, 8).map((row, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: i < rows.length - 1 ? '1px solid #f9fafb' : 'none' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af', width: 20, textAlign: 'center' }}>{i + 1}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row[keyCol] || '—'}
            </div>
            {countCol && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{row[countCol]} trips</div>}
          </div>
          <MiniBar value={Number(row[amountCol] || 0)} max={maxAmount} color={COLORS[i % COLORS.length]} />
          <div style={{ fontSize: 13, fontWeight: 600, color: '#6B3FDB', minWidth: 80, textAlign: 'right' }}>
            {fmt(row[amountCol] || 0)}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function TravelCommandCenter() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/travel/analytics/ceo-summary')
      .then(r => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading CEO Command Center...</div>
  );

  if (!data) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No data available</div>
  );

  const maxByEmp  = Math.max(...(data.by_employee?.map(r => Number(r.total_spend)) || [0]));
  const maxByDept = Math.max(...(data.by_department?.map(r => Number(r.total_spend)) || [0]));
  const maxByProj = Math.max(...(data.by_project?.map(r => Number(r.total_spend)) || [0]));
  const maxByCust = Math.max(...(data.by_customer?.map(r => Number(r.total_spend)) || [0]));

  const totalSpend = (data.trend || []).reduce((s, r) => s + Number(r.spend || 0), 0);
  const totalTrips = (data.trend || []).reduce((s, r) => s + Number(r.trips || 0), 0);
  const maxSpend   = Math.max(...(data.trend?.map(r => Number(r.spend)) || [0]));

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Travel Command Center</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>CEO-level travel cost analytics across all dimensions</p>
      </div>

      {/* KPI banner */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        {[
          { label: 'Total Travel Spend', value: fmt(totalSpend), icon: TrendingUp, color: '#6B3FDB' },
          { label: 'Total Trips',         value: totalTrips,      icon: Briefcase,  color: '#6366f1' },
          { label: 'Top Travellers',       value: data.by_employee?.length || 0, icon: Users, color: '#10b981' },
          { label: 'Projects with Travel', value: data.by_project?.filter(r => r.project_number !== 'Unlinked').length || 0, icon: BarChart2, color: '#f59e0b' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, padding: 20, border: '1px solid #f0f0f4', boxShadow: '0 1px 3px rgba(0,0,0,.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 8px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{k.label}</p>
                <p style={{ fontSize: typeof k.value === 'string' ? 20 : 28, fontWeight: 700, color: '#1f2937', margin: 0 }}>{k.value}</p>
              </div>
              <div style={{ background: k.color + '18', borderRadius: 10, padding: 10 }}>
                <k.icon size={18} color={k.color} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Trend chart (bar) */}
      <Section title="Travel Spend Trend — Last 12 Months" icon={TrendingUp} color="#6B3FDB">
        {data.trend?.length === 0 ? (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>No trend data</p>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140 }}>
            {data.trend?.map((r, i) => {
              const h = maxSpend > 0 ? Math.max(8, (Number(r.spend) / maxSpend) * 120) : 8;
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div title={`${r.month}: ${fmt(r.spend)} (${r.trips} trips)`}
                    style={{ width: '100%', height: h, background: COLORS[i % COLORS.length], borderRadius: '4px 4px 0 0', cursor: 'pointer', transition: 'opacity .15s' }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '0.75'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '1'} />
                  <span style={{ fontSize: 10, color: '#9ca3af', whiteSpace: 'nowrap' }}>{r.month?.slice(0,3)}</span>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: 20, marginTop: 12, fontSize: 12 }}>
          {data.trend?.slice(-3).map((r, i) => (
            <div key={i}>
              <span style={{ color: '#9ca3af' }}>{r.month}: </span>
              <span style={{ fontWeight: 600, color: '#6B3FDB' }}>{fmt(r.spend)}</span>
              <span style={{ color: '#9ca3af' }}> ({r.trips} trips)</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Four quadrant layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <Section title="Top Travellers by Spend" icon={User} color="#6366f1">
          <RankTable
            rows={data.by_employee || []}
            keyCol="employee_name"
            amountCol="total_spend"
            countCol="trip_count"
            maxAmount={maxByEmp}
          />
        </Section>

        <Section title="Department Travel Spend" icon={Building2} color="#10b981">
          <RankTable
            rows={data.by_department || []}
            keyCol="department"
            amountCol="total_spend"
            countCol="trips"
            maxAmount={maxByDept}
          />
        </Section>

        <Section title="Travel Cost by Project" icon={Briefcase} color="#6B3FDB">
          <RankTable
            rows={data.by_project?.filter(r => r.project_number !== 'Unlinked') || []}
            keyCol="project_number"
            amountCol="total_spend"
            countCol="trips"
            maxAmount={maxByProj}
          />
        </Section>

        <Section title="Travel Cost by Customer" icon={Users} color="#f59e0b">
          <RankTable
            rows={data.by_customer?.filter(r => r.customer_name !== 'Unlinked') || []}
            keyCol="customer_name"
            amountCol="total_spend"
            countCol="trips"
            maxAmount={maxByCust}
          />
        </Section>
      </div>

      {/* Travel type breakdown */}
      {data.by_employee?.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', marginTop: 16, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4' }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#1f2937', margin: 0 }}>Top Travel Spenders — Full Detail</h3>
          </div>
          <div style={{ padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['#', 'Employee', 'Designation', 'Department', 'Trips', 'Total Spend', 'Avg / Trip'].map(h => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: h === '#' ? 'center' : 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.by_employee?.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                    <td style={{ padding: '10px 16px', textAlign: 'center', fontWeight: 700, color: '#9ca3af', fontSize: 12 }}>{i + 1}</td>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#1f2937' }}>{r.employee_name}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>{r.designation}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>{r.department}</td>
                    <td style={{ padding: '10px 16px', color: '#374151', fontWeight: 500 }}>{r.trip_count}</td>
                    <td style={{ padding: '10px 16px', fontWeight: 700, color: '#6B3FDB' }}>{fmt(r.total_spend)}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>{fmt(r.avg_spend || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
