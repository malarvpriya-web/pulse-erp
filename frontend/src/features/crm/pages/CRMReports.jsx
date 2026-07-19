import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line,
} from 'recharts';
import api from '@/services/api/client';

const COLORS = ['#0d6efd', '#20c997', '#fd7e14', '#6f42c1', '#e83e8c', '#6c757d'];

function StatCard({ label, value, sub, color = '#0d6efd', icon }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e9ecef', borderRadius: 10,
      padding: '18px 20px', boxShadow: '0 1px 4px rgba(0,0,0,.05)',
    }}>
      <div style={{ fontSize: 24, marginBottom: 6 }}>{icon}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#495057', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#6c757d', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <h3 style={{ fontSize: 16, fontWeight: 700, margin: '24px 0 12px', color: '#212529', borderBottom: '2px solid #e9ecef', paddingBottom: 8 }}>
      {children}
    </h3>
  );
}

export default function CRMReports() {
  const [data, setData]       = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const results = await Promise.allSettled([
        api.get('/crm/stats'),                           // 0 dashboard stats
        api.get('/crm/leads/stats'),                     // 1 lead stats
        api.get('/crm/opportunities/stats'),             // 2 opp stats
        api.get('/crm/analytics/leads-by-source'),       // 3 leads by source
        api.get('/crm/analytics/pipeline-value'),        // 4 pipeline by stage
        api.get('/crm/user-performance'),                // 5 rep performance
        api.get('/crm/win-loss-analysis'),               // 6 win/loss
        api.get('/sales/forecasts/summary'),             // 7 forecast summary
        api.get('/sales/forecasts/by-month'),            // 8 monthly forecast
        api.get('/sales/analytics/top-customers'),       // 9 top customers
        api.get('/crm/pursuit-list'),                    // 10 pursuit list
      ]);

      if (!isMounted.current) return;

      const g = i => results[i].status === 'fulfilled' ? results[i].value.data : null;

      setData({
        crmStats:       g(0),
        leadStats:      g(1)?.data || g(1),
        oppStats:       g(2),
        leadsBySource:  g(3) || [],
        pipelineByStage: g(4) || [],
        userPerformance: g(5) || [],
        winLoss:        g(6)?.data || {},
        forecastSummary: g(7),
        forecastMonthly: g(8) || [],
        topCustomers:   g(9) || [],
        pursuitList:    g(10) || [],
      });
    } catch (e) {
      if (isMounted.current) setError('Failed to load reports');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const fmt = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  const pct = n => (Number(n || 0).toFixed(1)) + '%';

  const exportCSV = type => {
    window.open(`/api/${type === 'leads' ? 'crm/leads/export' : type === 'opportunities' ? 'crm/opportunities/export' : 'sales/quotations/export'}`, '_blank');
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6c757d' }}>Loading reports...</div>;

  const { crmStats, leadStats, oppStats, leadsBySource, pipelineByStage, userPerformance, winLoss, forecastSummary, forecastMonthly, topCustomers, pursuitList } = data;

  return (
    <div style={{ padding: '24px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>CRM Reports</h2>
          <p style={{ margin: 0, color: '#6c757d', fontSize: 13 }}>Live analytics across leads, opportunities, pipeline and sales performance</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => exportCSV('leads')}
            style={{ border: '1px solid #dee2e6', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', background: '#fff', fontSize: 13 }}>
            ⬇ Leads CSV
          </button>
          <button onClick={() => exportCSV('opportunities')}
            style={{ border: '1px solid #dee2e6', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', background: '#fff', fontSize: 13 }}>
            ⬇ Opps CSV
          </button>
          <button onClick={() => exportCSV('quotations')}
            style={{ border: '1px solid #dee2e6', borderRadius: 6, padding: '7px 14px', cursor: 'pointer', background: '#fff', fontSize: 13 }}>
            ⬇ Quotes CSV
          </button>
          <button onClick={load}
            style={{ background: '#0d6efd', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', cursor: 'pointer', fontSize: 13 }}>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fff3f3', border: '1px solid #f5c2c7', borderRadius: 6, padding: 12, marginBottom: 16, color: '#842029' }}>
          {error}
        </div>
      )}

      {/* KPI Overview */}
      <SectionTitle>Pipeline Overview</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14, marginBottom: 8 }}>
        <StatCard icon="🎯" label="Total Leads"      value={crmStats?.total_leads     || 0} color="#0d6efd" />
        <StatCard icon="📊" label="Pipeline Value"   value={fmt(crmStats?.pipeline_value)} color="#20c997" />
        <StatCard icon="🏆" label="Won Deals"        value={crmStats?.won_deals        || 0} color="#198754" />
        <StatCard icon="🔄" label="Conversion Rate"  value={pct(crmStats?.conversion_rate)}  color="#6f42c1" />
        <StatCard icon="🏢" label="Total Accounts"   value={crmStats?.total_accounts   || 0} color="#fd7e14" />
        <StatCard icon="📈" label="Win Rate"         value={pct(oppStats?.win_rate)}    color="#0d6efd" />
        <StatCard icon="⚠️" label="Overdue Deals"   value={oppStats?.overdue_count     || 0} color="#dc3545" />
        <StatCard icon="💰" label="Avg Deal Size"    value={fmt(oppStats?.avg_deal_size)} color="#6c757d" />
      </div>

      {/* Lead Funnel */}
      <SectionTitle>Lead Funnel</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ background: '#fff', border: '1px solid #e9ecef', borderRadius: 10, padding: 20 }}>
          <h4 style={{ margin: '0 0 16px', fontSize: 14, color: '#6c757d' }}>Leads by Status</h4>
          {leadStats && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { k: 'new',         label: 'New',         color: '#0d6efd' },
                { k: 'contacted',   label: 'Contacted',   color: '#6f42c1' },
                { k: 'qualified',   label: 'Qualified',   color: '#20c997' },
                { k: 'unqualified', label: 'Unqualified', color: '#fd7e14' },
                { k: 'converted',   label: 'Converted',   color: '#198754' },
              ].map(s => {
                const v   = parseInt(leadStats[s.k]) || 0;
                const tot = parseInt(leadStats.total) || 1;
                return (
                  <div key={s.k}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                      <span style={{ fontWeight: 600, color: '#495057' }}>{s.label}</span>
                      <span style={{ fontWeight: 700, color: s.color }}>{v}</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: '#e9ecef', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${(v / tot) * 100}%`, background: s.color, borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ background: '#fff', border: '1px solid #e9ecef', borderRadius: 10, padding: 20 }}>
          <h4 style={{ margin: '0 0 16px', fontSize: 14, color: '#6c757d' }}>Leads by Source</h4>
          {leadsBySource.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={leadsBySource.slice(0, 6)} dataKey="count" nameKey="lead_source" cx="50%" cy="50%" outerRadius={80} label={({ lead_source, count }) => `${lead_source}: ${count}`}>
                  {leadsBySource.slice(0, 6).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ textAlign: 'center', color: '#6c757d', padding: 40 }}>No lead source data</div>
          )}
        </div>
      </div>

      {/* Pipeline by Stage */}
      <SectionTitle>Pipeline by Stage</SectionTitle>
      <div style={{ background: '#fff', border: '1px solid #e9ecef', borderRadius: 10, padding: 20 }}>
        {pipelineByStage.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={pipelineByStage} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="stage" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={v => '₹' + (v / 100000).toFixed(0) + 'L'} tick={{ fontSize: 11 }} />
              <Tooltip formatter={v => ['₹' + Number(v).toLocaleString('en-IN'), 'Pipeline Value']} />
              <Bar dataKey="total_value" fill="#0d6efd" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ textAlign: 'center', color: '#6c757d', padding: 40 }}>No pipeline data</div>
        )}
      </div>

      {/* Win/Loss Analysis */}
      {winLoss?.total > 0 && (
        <>
          <SectionTitle>Win / Loss Analysis</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div style={{ background: '#fff', border: '1px solid #e9ecef', borderRadius: 10, padding: 20 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#198754' }}>{winLoss.won || 0}</div>
                  <div style={{ fontSize: 12, color: '#6c757d' }}>Won</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#dc3545' }}>{winLoss.lost || 0}</div>
                  <div style={{ fontSize: 12, color: '#6c757d' }}>Lost</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#0d6efd' }}>
                    {winLoss.total > 0 ? Math.round((winLoss.won / winLoss.total) * 100) : 0}%
                  </div>
                  <div style={{ fontSize: 12, color: '#6c757d' }}>Win Rate</div>
                </div>
              </div>
              <div style={{ marginTop: 16, fontSize: 12, color: '#6c757d', display: 'flex', gap: 20 }}>
                <span>Avg Deal: {fmt(winLoss.avg_deal_size)}</span>
                <span>Avg Cycle: {winLoss.avg_cycle_days || 0} days</span>
              </div>
              {winLoss.loss_reasons?.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: '#495057' }}>Top Loss Reasons</div>
                  {winLoss.loss_reasons.slice(0, 5).map((r, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
                      <span>{r.reason}</span>
                      <span style={{ fontWeight: 600, color: '#dc3545' }}>{r.count} ({r.pct}%)</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ background: '#fff', border: '1px solid #e9ecef', borderRadius: 10, padding: 20 }}>
              <h4 style={{ margin: '0 0 12px', fontSize: 14, color: '#6c757d' }}>Monthly Win / Loss</h4>
              {winLoss.monthly?.length > 0 ? (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={winLoss.monthly}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="won"  fill="#198754" name="Won"  radius={[3, 3, 0, 0]} />
                    <Bar dataKey="lost" fill="#dc3545" name="Lost" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ textAlign: 'center', color: '#6c757d', padding: 40, fontSize: 13 }}>No monthly data yet</div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Forecast */}
      {forecastSummary && (
        <>
          <SectionTitle>Revenue Forecast</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
            <StatCard icon="📈" label="Forecasted"   value={fmt(forecastSummary.total_forecasted)} color="#6f42c1" />
            <StatCard icon="✅" label="Achieved"     value={fmt(forecastSummary.total_achieved)}   color="#198754" />
            <StatCard icon="🎯" label="Target"       value={fmt(forecastSummary.total_target)}     color="#0d6efd" />
            <StatCard icon="📊" label="Achievement"  value={pct(forecastSummary.achievement_pct)}  color="#fd7e14" />
          </div>
          {forecastMonthly.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e9ecef', borderRadius: 10, padding: 20 }}>
              <h4 style={{ margin: '0 0 12px', fontSize: 14, color: '#6c757d' }}>Monthly Forecast vs Achieved</h4>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={forecastMonthly} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={v => '₹' + (v / 100000).toFixed(0) + 'L'} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={v => ['₹' + Number(v).toLocaleString('en-IN')]} />
                  <Legend />
                  <Bar dataKey="forecasted" fill="#6f42c1" name="Forecasted" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="achieved"   fill="#198754" name="Achieved"   radius={[3, 3, 0, 0]} />
                  <Bar dataKey="target"     fill="#dee2e6" name="Target"     radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}

      {/* Sales Rep Performance */}
      {userPerformance.length > 0 && (
        <>
          <SectionTitle>Sales Rep Performance</SectionTitle>
          <div style={{ background: '#fff', border: '1px solid #e9ecef', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8f9fa' }}>
                  {['Sales Rep', 'Department', 'Total Opps', 'Won', 'Lost', 'Win Rate', 'Revenue Won', 'Active Pipeline'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Sales Rep' || h === 'Department' ? 'left' : 'right', fontWeight: 600, fontSize: 12, color: '#6c757d', borderBottom: '1px solid #e9ecef' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {userPerformance.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{r.name}</td>
                    <td style={{ padding: '10px 14px', color: '#6c757d' }}>{r.department || '—'}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>{r.total_opportunities}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#198754', fontWeight: 600 }}>{r.won}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#dc3545' }}>{r.lost || 0}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      <span style={{ fontWeight: 700, color: parseFloat(r.win_rate) >= 50 ? '#198754' : '#fd7e14' }}>
                        {r.win_rate || 0}%
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: '#0d6efd' }}>{fmt(r.revenue_won)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6c757d' }}>{fmt(r.active_pipeline)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Top Customers */}
      {topCustomers.length > 0 && (
        <>
          <SectionTitle>Top Customers</SectionTitle>
          <div style={{ background: '#fff', border: '1px solid #e9ecef', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8f9fa' }}>
                  {['Customer', 'Orders', 'Total Revenue'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Customer' ? 'left' : 'right', fontWeight: 600, fontSize: 12, color: '#6c757d', borderBottom: '1px solid #e9ecef' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topCustomers.slice(0, 10).map((c, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>
                      <span style={{ display: 'inline-block', width: 22, height: 22, borderRadius: '50%', background: '#e9ecef', textAlign: 'center', lineHeight: '22px', fontSize: 11, marginRight: 8, fontWeight: 700 }}>{i + 1}</span>
                      {c.customer_name || c.name}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6c757d' }}>{c.order_count || c.orders}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#0d6efd' }}>{fmt(c.total_revenue || c.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Pursuit List */}
      {pursuitList.length > 0 && (
        <>
          <SectionTitle>Active Pursuit List</SectionTitle>
          <div style={{ background: '#fff', border: '1px solid #e9ecef', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8f9fa' }}>
                  {['Opportunity', 'Customer', 'Stage', 'Probability', 'Expected Value', 'Close Date', 'Owner'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: h === 'Opportunity' || h === 'Customer' ? 'left' : 'right', fontWeight: 600, fontSize: 12, color: '#6c757d', borderBottom: '1px solid #e9ecef' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pursuitList.slice(0, 15).map((p, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{p.title}</td>
                    <td style={{ padding: '10px 14px', color: '#6c757d' }}>{p.customer_name || '—'}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, background: '#e9ecef', color: '#495057', fontWeight: 600 }}>{p.stage}</span>
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>{p.probability_percentage ? p.probability_percentage + '%' : '—'}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: '#0d6efd' }}>{fmt(p.value)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6c757d' }}>
                      {p.expected_closing_date ? new Date(p.expected_closing_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6c757d' }}>{p.owner_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
