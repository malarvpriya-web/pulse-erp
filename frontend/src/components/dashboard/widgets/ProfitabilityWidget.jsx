import { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';
import api from '@/services/api/client';

const fmt = n => {
  if (!n && n !== 0) return '₹0';
  const v = parseFloat(n);
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(1)}Cr`;
  if (v >= 100_000)    return `₹${(v / 100_000).toFixed(1)}L`;
  if (v >= 1_000)      return `₹${(v / 1_000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

export function ProfitabilityWidget({ data: propData }) {
  const [d,       setD]       = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (propData?.revenue != null) {
      setD(propData);
      setLoading(false);
      return;
    }
    Promise.allSettled([
      api.get('/dashboard/revenue'),
      api.get('/dashboard/expenses'),
    ]).then(([rR, eR]) => {
      const rev      = rR.status === 'fulfilled' ? rR.value.data : {};
      const exp      = eR.status === 'fulfilled' ? eR.value.data : {};
      const revenue  = rev?.thisMonth  || 0;
      const expenses = (exp?.values || []).reduce((s, v) => s + (parseFloat(v) || 0), 0);
      const net      = revenue - expenses;
      const margin   = revenue > 0 ? Math.round((net / revenue) * 100) : 0;
      setD({ revenue, expenses, net_profit: net, margin });
    }).catch(() => {}).finally(() => setLoading(false));
  }, [propData]);

  if (!d)      return <div className="widget-data"><p style={{ color:'#9ca3af', fontSize:13, textAlign:'center', padding:'16px 0' }}>No data</p></div>;

  const { revenue = 0, expenses = 0, net_profit, margin = 0 } = d;
  const net      = net_profit != null ? net_profit : (revenue - expenses);
  const isProfit = net >= 0;
  const Icon     = isProfit ? TrendingUp : TrendingDown;
  const color    = isProfit ? '#10b981' : '#ef4444';

  return (
    <div className="widget-data">
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {[
          { label:'Revenue (MTD)',  val: fmt(revenue),       color:'#3b82f6' },
          { label:'Expenses (MTD)', val: fmt(expenses),      color:'#ef4444' },
          { label:'Net Profit',     val: fmt(Math.abs(net)), color },
        ].map((it, i) => (
          <div key={i} className="kpi-card"
            style={{ background: i === 2 ? `${color}0d` : undefined, borderLeft: i === 2 ? `3px solid ${color}` : undefined }}>
            <span className="kpi-label">{it.label}</span>
            <span className="kpi-value" style={{ color: it.color, fontSize:16 }}>
              {i === 2 && !isProfit ? '−' : ''}{it.val}
            </span>
          </div>
        ))}
      </div>

      <div style={{
        display:'flex', alignItems:'center', gap:8, padding:'9px 12px',
        borderRadius:8, background:`${color}10`, marginTop:2,
      }}>
        <Icon size={14} color={color}/>
        <span style={{ fontSize:12, fontWeight:700, color }}>
          {isProfit ? '+' : '−'}{Math.abs(margin)}% net margin this month
        </span>
      </div>
    </div>
  );
}

export default ProfitabilityWidget;
