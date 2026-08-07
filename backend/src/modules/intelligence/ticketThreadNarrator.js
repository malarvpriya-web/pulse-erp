// backend/src/modules/intelligence/ticketThreadNarrator.js
// Automation Opportunity Audit §27.2 — ticket/complaint thread summarization
// for Service Desk handoffs: "what's the actual unresolved issue and what's
// been tried" for an engineer picking up someone else's ticket.
//
// GPT-optional/rule-based-fallback, same discipline as kpiNarrator.js and
// projectHealthNarrator.js — but free-text thread compression is a
// fundamentally different problem from numeric KPI narration: a rule engine
// cannot reliably *summarize* prose. So the fallback doesn't attempt to (that
// would risk misrepresenting what was actually said); it surfaces the real
// thread structure instead — latest comment verbatim, comment count, ticket
// age/SLA state — never a fabricated paraphrase.

const fmtDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

export async function narrateTicketThread(ticket, comments) {
  const apiKey = process.env.OPENAI_API_KEY;
  const keyMissing = !apiKey || apiKey === 'your-openai-api-key-here';

  const payload = {
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    status: ticket.status,
    sla_breached: ticket.sla_breached,
    thread: comments.map((c) => ({ author: c.author, body: c.body, at: c.created_at })),
  };

  if (!keyMissing) {
    try {
      const prompt =
        `You are a Service Desk analyst helping an engineer pick up a ticket someone else started. ` +
        `Summarize in exactly 3 concise bullets: (1) what the actual unresolved issue is, (2) what has ` +
        `already been tried per the comment thread, (3) a suggested next step. Never invent details not ` +
        `present in the data. Start each bullet with •.\n\nTicket + thread: ${JSON.stringify(payload)}`;

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
  bullets.push(
    `• ${ticket.title} — ${ticket.priority} priority, currently ${ticket.status}` +
    `${ticket.sla_breached ? ' (SLA BREACHED)' : ''}.`
  );
  if (comments.length === 0) {
    const desc = (ticket.description || '').slice(0, 150);
    bullets.push(`• No comments logged yet. Original issue as reported: "${desc}"`);
  } else {
    const last = comments[comments.length - 1];
    const snippet = (last.body || '').slice(0, 150);
    bullets.push(
      `• ${comments.length} comment(s) logged. Most recent by ${last.author} ` +
      `(${fmtDate(last.created_at)}): "${snippet}"`
    );
  }
  const ageDays = Math.floor((Date.now() - new Date(ticket.created_at)) / 86400000);
  bullets.push(
    `• Open for ${ageDays} day(s)` +
    `${ticket.resolved_at ? `, resolved ${fmtDate(ticket.resolved_at)}` : ''}.`
  );

  return { reply: bullets.join('\n'), source: 'rules' };
}
