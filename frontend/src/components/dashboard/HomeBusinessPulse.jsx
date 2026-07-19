/* HomeBusinessPulse — live analytics band for the Home page.
 * Lazy-loaded (wave 3) so it never delays the hero KPIs.
 * Every chart reads a real /dashboard endpoint; no fallback data.
 */
import { useEffect, useRef, useState } from 'react';
import {
  TrendingUp, Users, Filter, Landmark, Crown, ReceiptText, Truck, CalendarDays,
} from 'lucide-react';
import api from '@/services/api/client';
import {
  VizCard, TrendArea, RoundBars, Donut, DonutLegend, HBarList, fmtINRShort,
} from '@/components/charts/PulseViz';
import './HomeBusinessPulse.css';

const STAGE_LABELS = {
  prospecting: 'Prospecting', qualification: 'Qualification',
  proposal: 'Proposal', negotiation: 'Negotiation',
  closed_won: 'Won', closed_lost: 'Lost',
};

export default function HomeBusinessPulse() {
  const [revenue,   setRevenue]   = useState(null);
  const [workforce, setWorkforce] = useState(null);
  const [pipeline,  setPipeline]  = useState(null);
  const [cash,      setCash]      = useState(null);
  const [customers, setCustomers] = useState(null);
  const [vendors,   setVendors]   = useState(null);
  const [leaveMix,  setLeaveMix]  = useState(null);
  const [expenses,  setExpenses]  = useState(null);
  const [loading,   setLoading]   = useState(true);
  const ctrl = useRef(null);

  useEffect(() => {
    ctrl.current = new AbortController();
    const { signal } = ctrl.current;
    (async () => {
      const [rev, wf, pipe, cashRes, cust, exp, vend, lv] = await Promise.allSettled([
        api.get('/dashboard/revenue?period=6m&compare=true', { signal }),
        api.get('/dashboard/workforce',      { signal }),
        api.get('/dashboard/sales',          { signal }),
        api.get('/dashboard/cash',           { signal }),
        api.get('/dashboard/top-customers',  { signal }),
        api.get('/dashboard/expenses',       { signal }),
        api.get('/dashboard/top-vendors',    { signal }),
        api.get('/dashboard/leave-summary',  { signal }),
      ]);
      if (signal.aborted) return;
      if (rev.status     === 'fulfilled') setRevenue(rev.value.data);
      if (wf.status      === 'fulfilled') setWorkforce(wf.value.data);
      if (pipe.status    === 'fulfilled') setPipeline(pipe.value.data);
      if (cashRes.status === 'fulfilled') setCash(cashRes.value.data);
      if (cust.status    === 'fulfilled') setCustomers(cust.value.data);
      if (exp.status     === 'fulfilled') setExpenses(exp.value.data);
      if (vend.status    === 'fulfilled') setVendors(vend.value.data);
      if (lv.status      === 'fulfilled') setLeaveMix(lv.value.data);
      setLoading(false);
    })();
    return () => ctrl.current?.abort();
  }, []);

  const revSeries = (revenue?.shortMonths || revenue?.months || []).map((m, i) => ({
    label: m,
    value: revenue?.values?.[i] ?? 0,
    prev:  revenue?.prevValues?.[i],
  }));
  const hasCompare = Array.isArray(revenue?.prevValues) && revenue.prevValues.some(v => v > 0);

  const deptData = (workforce?.byDepartment || []).map(d => ({ name: d.department, value: d.count }));

  const pipeData = (pipeline?.stages || [])
    .filter(s => s.stage !== 'closed_lost')
    .map(s => ({ label: STAGE_LABELS[s.stage] || s.stage, value: s.value, count: s.count }));

  const arData = (cash?.arAging || []).map(b => ({ label: b.bucket, value: b.amount }));

  const custData = (customers?.customers || []).map(c => ({ name: c.name, value: c.revenue }));

  const expData = (expenses?.labels || []).map((l, i) => ({ name: l, value: expenses?.values?.[i] ?? 0 }));

  const vendData = (vendors?.vendors || []).map(v => ({ name: v.name, value: v.spend }));

  const leaveData = (leaveMix?.byType || []).map(t => ({ name: t.type, value: t.count }));

  return (
    <div className="hbp-band">
      <div className="hbp-hd">
        <span className="hbp-title">Business Pulse</span>
        <span className="hbp-sub">Live insights from your data</span>
      </div>

      <div className="hbp-grid">
        <VizCard
          className="hbp-span2"
          title="Revenue Trend"
          subtitle={revenue ? `YTD ${fmtINRShort(revenue.ytd)} · this month ${fmtINRShort(revenue.thisMonth)}` : 'Paid invoices, last 6 months'}
          icon={<TrendingUp size={15} />}
          loading={loading}
          empty={!loading && revSeries.every(d => !d.value)}
          emptyText="No paid invoices in the last 6 months"
        >
          <TrendArea data={revSeries} yKey="value" name="Revenue" currency height={210}
            compareKey={hasCompare ? 'prev' : undefined} compareName="Prior period" />
        </VizCard>

        <VizCard
          title="Headcount by Department"
          subtitle={workforce ? `${workforce.total} active employees` : undefined}
          icon={<Users size={15} />}
          loading={loading}
          empty={!loading && deptData.length === 0}
          emptyText="No department data"
        >
          <Donut data={deptData} height={150} centerLabel="People" centerValue={workforce?.total} />
          <DonutLegend data={deptData} max={5} />
        </VizCard>

        <VizCard
          title="Sales Pipeline"
          subtitle="Opportunity value by stage"
          icon={<Filter size={15} />}
          loading={loading}
          empty={!loading && pipeData.every(d => !d.value && !d.count)}
          emptyText="No open opportunities"
        >
          <RoundBars data={pipeData} name="Pipeline value" currency height={190} multiColor />
        </VizCard>

        <VizCard
          title="Receivables Aging"
          subtitle={cash ? `Outstanding ${fmtINRShort(cash.accountsReceivable)}` : 'Unpaid invoices by age'}
          icon={<Landmark size={15} />}
          loading={loading}
          empty={!loading && arData.every(d => !d.value)}
          emptyText="Nothing outstanding — great!"
        >
          <RoundBars data={arData} name="Receivable" currency height={190} color="#f59e0b" />
        </VizCard>

        <VizCard
          title="Top Customers"
          subtitle="By paid revenue, last 12 months"
          icon={<Crown size={15} />}
          loading={loading}
          empty={!loading && custData.length === 0}
          emptyText="No customer revenue yet"
        >
          <HBarList data={custData} currency max={5} />
        </VizCard>

        <VizCard
          title="Expenses This Month"
          subtitle="Claims by category"
          icon={<ReceiptText size={15} />}
          loading={loading}
          empty={!loading && expData.every(d => !d.value)}
          emptyText="No expense claims this month"
        >
          <Donut data={expData} height={150} centerLabel="Total" currency />
          <DonutLegend data={expData} currency max={4} />
        </VizCard>

        <VizCard
          title="Top Vendors"
          subtitle="By paid spend, last 12 months"
          icon={<Truck size={15} />}
          loading={loading}
          empty={!loading && vendData.length === 0}
          emptyText="No vendor spend yet"
        >
          <HBarList data={vendData} currency max={5} color="#14b8a6" />
        </VizCard>

        <VizCard
          title="Leave Mix This Month"
          subtitle={leaveMix ? `${leaveMix.onLeave} on leave today · ${leaveMix.pending} pending` : 'Approved leaves by type'}
          icon={<CalendarDays size={15} />}
          loading={loading}
          empty={!loading && leaveData.length === 0}
          emptyText="No approved leaves this month"
        >
          <Donut data={leaveData} height={150} centerLabel="Leaves" />
          <DonutLegend data={leaveData} max={4} />
        </VizCard>
      </div>
    </div>
  );
}
