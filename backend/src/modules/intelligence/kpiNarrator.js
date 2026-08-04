// backend/src/modules/intelligence/kpiNarrator.js
// Shared narration logic for `dashboardData` KPI payloads — used by the
// POST /api/ai/ceo-insights route and by kpiDigest.cron.js so both produce
// the same GPT-or-rules narrative from one source of truth.
// No operational data is invented here — all numbers come from the caller's payload.

export async function narrateKpis(dashboardData = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const keyMissing = !apiKey || apiKey === 'your-openai-api-key-here';

  if (!keyMissing) {
    try {
      const prompt =
        `You are a CFO-level business analyst for an ERP platform. Analyze the following ` +
        `live dashboard metrics and provide exactly 3 concise, actionable bullet-point insights. ` +
        `Be specific with numbers. Start each bullet with •.\n\nData: ${JSON.stringify(dashboardData)}`;

      const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (apiRes.ok) {
        const data = await apiRes.json();
        const reply = data.choices?.[0]?.message?.content || '';
        if (reply) return { reply, source: 'openai' };
      }
    } catch (_) { /* fall through to rule-based */ }
  }

  // Rule-based fallback — derives from caller-provided payload, never invents data
  const kpis      = dashboardData.kpis      ?? {};
  const attrition = dashboardData.attrition ?? {};
  const salesKPI  = dashboardData.salesKPI  ?? {};
  const hc        = dashboardData.hc        ?? {};

  const bullets = [];
  const rev     = kpis.revenue?.value;
  const revGrow = kpis.revenue?.growth;
  const attr    = attrition.rate;
  const pipe    = salesKPI.pipelineValue;
  const conv    = salesKPI.conversionRate;
  const active  = hc.active;

  if (rev != null)
    bullets.push(`• Revenue YTD is ₹${rev >= 1e7 ? (rev/1e7).toFixed(1)+'Cr' : rev >= 1e5 ? (rev/1e5).toFixed(1)+'L' : rev.toLocaleString()}${revGrow != null ? ` with ${revGrow > 0 ? '+' : ''}${revGrow.toFixed(1)}% YoY growth` : ''}.`);
  if (attr != null)
    bullets.push(`• Attrition rate is ${attr.toFixed(1)}% — ${attr > 15 ? 'critical, immediate retention action needed' : attr > 10 ? 'above the 10–12% benchmark, review exit trends' : 'within the healthy 10–12% benchmark'}.`);
  if (pipe != null)
    bullets.push(`• Sales pipeline stands at ₹${pipe >= 1e7 ? (pipe/1e7).toFixed(1)+'Cr' : pipe >= 1e5 ? (pipe/1e5).toFixed(1)+'L' : pipe.toLocaleString()}${conv != null ? ` with a ${conv.toFixed(1)}% conversion rate${conv < 20 ? ' — consider pipeline acceleration initiatives' : ''}` : ''}.`);
  if (active != null && bullets.length < 3)
    bullets.push(`• Active headcount is ${active.toLocaleString('en-IN')} employees${hc.onLeave ? ` with ${hc.onLeave} on leave today` : ''}.`);

  if (bullets.length === 0)
    bullets.push('• Not enough data yet for a KPI summary this period.');

  return { reply: bullets.join('\n'), source: 'rules' };
}
