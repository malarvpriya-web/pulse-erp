// backend/src/modules/intelligence/projectHealthNarrator.js
// Automation Opportunity Audit §27.2 — "a one-paragraph 'is this project healthy'
// summary on top of the EVM/CPI/SPI numbers." Sibling to kpiNarrator.js: same
// GPT-optional-with-rule-based-fallback discipline, never fabricates numbers.
//
// Deliberately self-contained off `projects`' own always-populated columns
// (budget_amount, actual_cost, progress_percentage, start_date, end_date)
// rather than `project_cost_summary` (found empty — its EVM writer is
// on-demand/admin-triggered only, same "computed but never actually populated"
// shape as the Customer/Vendor Health engines elsewhere in this series) or
// project360.routes.js's health-score engine (found 3 of its ~28 source
// queries reference tables that don't exist — service_tickets, goods_receipts,
// lifecycle_events — silently swallowed by Promise.allSettled, so its
// commissioning/service scores are quietly wrong; flagged, not fixed here).

function add(drivers, points, factor) {
  if (points > 0) drivers.push({ factor, points: Math.round(points) });
}

// Higher score = more risk/concern (same convention as scoreDevice in ai.routes.js).
export function scoreProjectHealth(p, now = new Date()) {
  const drivers = [];
  const budget = parseFloat(p.budget_amount || p.budget || 0);
  const actualCost = parseFloat(p.actual_cost || 0);
  const progress = parseFloat(p.progress_percentage || 0);

  let plannedProgress = null;
  if (p.start_date && p.end_date) {
    const start = new Date(p.start_date);
    const end = new Date(p.end_date);
    const total = end - start;
    if (total > 0) plannedProgress = Math.max(0, Math.min(1, (now - start) / total)) * 100;
  }

  if (plannedProgress != null) {
    const gap = plannedProgress - progress; // positive = behind schedule
    if (gap > 30) add(drivers, 35, `${Math.round(gap)}pp behind planned schedule`);
    else if (gap > 15) add(drivers, 20, `${Math.round(gap)}pp behind planned schedule`);
    else if (gap > 5) add(drivers, 10, `${Math.round(gap)}pp behind planned schedule`);
  }

  if (p.end_date && new Date(p.end_date) < now && p.status !== 'completed') {
    const daysOverdue = Math.floor((now - new Date(p.end_date)) / 86400000);
    add(drivers, Math.min(30, 15 + daysOverdue / 10), `${daysOverdue}d past planned end date`);
  }

  if (budget > 0 && actualCost > 0 && progress > 0) {
    const costPct = (actualCost / budget) * 100;
    const variance = costPct - progress;
    if (variance > 20) add(drivers, 25, `spend at ${Math.round(costPct)}% of budget vs ${Math.round(progress)}% progress`);
    else if (variance > 10) add(drivers, 12, `spend at ${Math.round(costPct)}% of budget vs ${Math.round(progress)}% progress`);
  } else if (budget > 0 && actualCost > budget) {
    add(drivers, 30, 'actual cost has exceeded budget');
  }

  if (progress === 0 && p.start_date) {
    const daysSinceStart = Math.floor((now - new Date(p.start_date)) / 86400000);
    if (daysSinceStart > 14) add(drivers, 15, `0% progress ${daysSinceStart}d after start date`);
  }

  const score = Math.min(100, drivers.reduce((s, x) => s + x.points, 0));
  const band = score >= 60 ? 'critical' : score >= 30 ? 'watchlist' : 'healthy';
  drivers.sort((a, b) => b.points - a.points);
  return { score, band, drivers };
}

export async function narrateProjectHealth(project, scoreResult) {
  const apiKey = process.env.OPENAI_API_KEY;
  const keyMissing = !apiKey || apiKey === 'your-openai-api-key-here';

  const payload = {
    project_name: project.project_name,
    status: project.status,
    progress_percentage: parseFloat(project.progress_percentage || 0),
    budget_amount: parseFloat(project.budget_amount || project.budget || 0),
    actual_cost: parseFloat(project.actual_cost || 0),
    risk_band: scoreResult.band,
    risk_drivers: scoreResult.drivers.map((d) => d.factor),
  };

  if (!keyMissing) {
    try {
      const prompt =
        `You are a PMO analyst for an ERP platform. Summarize this project's health in exactly 3 ` +
        `concise, actionable bullet points. Be specific with the numbers given. Start each bullet with •.\n\n` +
        `Data: ${JSON.stringify(payload)}`;

      const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        const reply = data.choices?.[0]?.message?.content || '';
        if (reply) return { reply, source: 'openai' };
      }
    } catch (_) { /* fall through to rule-based */ }
  }

  const bullets = [];
  if (scoreResult.band === 'healthy') {
    bullets.push(scoreResult.drivers.length === 0
      ? `• ${project.project_name} is on track — no schedule, cost, or activity concerns detected.`
      : `• ${project.project_name} is on track overall — minor watch item: ${scoreResult.drivers[0].factor}.`);
  } else {
    const top = scoreResult.drivers[0];
    bullets.push(`• ${project.project_name} is ${scoreResult.band === 'critical' ? 'at critical risk' : 'on the watchlist'} — top concern: ${top.factor}.`);
    for (const d of scoreResult.drivers.slice(1, 3)) bullets.push(`• Also: ${d.factor}.`);
  }
  const progress = parseFloat(project.progress_percentage || 0);
  bullets.push(`• Currently ${progress}% complete, status "${project.status}".`);

  return { reply: bullets.slice(0, 3).join('\n'), source: 'rules' };
}
