import {
  getPayrollTrends,
  getDepartmentCostAnalysis,
  getAnomalyFlags,
  getPredictiveCashFlow,
  queryERPIntelligence,
  buildQueryContext,
} from './aiPayroll.service.js';

// ── Rate limiter for /ai/query (30 queries/day per user, in-memory) ────────────
const _queryRL = new Map();
const QUERY_RL_MAX = 30;

function getQueryRLEntry(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = _queryRL.get(userId) ?? { date: today, count: 0 };
  if (entry.date !== today) { entry.date = today; entry.count = 0; }
  return entry;
}

// ── In-memory cache (60 s TTL) ────────────────────────────────────────────────
const cache = new Map();
const TTL   = 60 * 1000;

function fromCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTL) { cache.delete(key); return null; }
  return hit.data;
}

function toCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

export const payrollTrends = async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const key    = `trends:${months}`;
    const cached = fromCache(key);
    if (cached) return res.json({ success: true, data: cached, message: 'Payroll trends retrieved (cached)' });
    const data = await getPayrollTrends(months);
    toCache(key, data);
    res.json({ success: true, data, message: 'Payroll trends retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const departmentCosts = async (req, res) => {
  try {
    const key    = 'departments';
    const cached = fromCache(key);
    if (cached) return res.json({ success: true, data: cached, message: 'Department costs retrieved (cached)' });
    const data = await getDepartmentCostAnalysis();
    toCache(key, data);
    res.json({ success: true, data, message: 'Department costs retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const anomalyFlags = async (req, res) => {
  try {
    const threshold = parseFloat(req.query.threshold) || 0.20;
    const key       = `anomalies:${threshold}`;
    const cached    = fromCache(key);
    if (cached) return res.json({ success: true, data: cached, message: 'Anomaly flags retrieved (cached)' });
    const data = await getAnomalyFlags(threshold);
    toCache(key, data);
    res.json({ success: true, data, message: 'Anomaly flags retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const cashflowForecast = async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const key = `cashflow:${days}`;
    const cached = fromCache(key);
    if (cached) return res.json({ success: true, data: cached, message: 'Cash flow forecast (cached)' });
    const data = await getPredictiveCashFlow(days);
    toCache(key, data);
    res.json({ success: true, data, message: 'Cash flow forecast retrieved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const erpQuery = async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string')
      return res.status(400).json({ success: false, message: 'Missing query in request body' });

    const userId = req.user?.userId;

    // Rate limit — 30 queries/day per user
    if (userId) {
      const entry = getQueryRLEntry(userId);
      if (entry.count >= QUERY_RL_MAX) {
        return res.status(429).json({
          success: false,
          message: `Daily query limit of ${QUERY_RL_MAX} reached. Try again tomorrow.`,
        });
      }
    }

    const apiKey = process.env.OPENAI_API_KEY;
    const keyMissing = !apiKey || apiKey === 'your-openai-api-key-here';

    // ── LLM path (when API key is configured) ──────────────────────────────────
    if (!keyMissing) {
      try {
        const erpContext = await buildQueryContext(query);

        const systemPrompt =
          `You are an ERP business intelligence analyst for Pulse ERP.\n` +
          `Answer questions using ONLY the data provided below — do not invent figures.\n` +
          `Be concise and specific. Use Indian number format (Lakhs/Crores).\n` +
          `If the data is insufficient to answer, say so explicitly.\n` +
          `Current date: ${new Date().toISOString().slice(0, 10)}.\n\n` +
          erpContext;

        const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 512,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: query.slice(0, 500) },
            ],
          }),
        });

        if (apiRes.ok) {
          const llmData = await apiRes.json();
          const answer = llmData.choices?.[0]?.message?.content?.trim();
          if (answer) {
            if (userId) {
              const entry = getQueryRLEntry(userId);
              entry.count += 1;
              _queryRL.set(userId, entry);
            }
            return res.json({ success: true, data: { answer, source: 'llm' }, message: 'ERP Intelligence response' });
          }
        }
      } catch (_) { /* fall through to rule-based */ }
    }

    // ── Rule-based fallback (no API key, or LLM call failed) ──────────────────
    const data = await queryERPIntelligence(query);
    if (userId) {
      const entry = getQueryRLEntry(userId);
      entry.count += 1;
      _queryRL.set(userId, entry);
    }
    res.json({ success: true, data, message: 'ERP Intelligence response' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
