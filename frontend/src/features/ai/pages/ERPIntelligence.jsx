import React, { useState, useEffect, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area
} from 'recharts';
import {
  Brain, Cpu, Zap, Search, ArrowRight, TrendingUp, TrendingDown,
  IndianRupee, Lightbulb, Download, AlertTriangle, History,
  Users, Package, Calendar, ChevronRight, BarChart2,
  Send, Bot, User, Loader, Sparkles, RotateCcw, ThumbsUp, ThumbsDown, MessageSquare,
} from 'lucide-react';
import { aiIntelligenceService } from '../services/aiIntelligenceService';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';
import './ERPIntelligence.css';
import './AIAssistant.css';
import '../ai.css';

const MAX_HISTORY = 20;
const ROLE_CHIPS = {
  admin:   ['Show attrition trend', 'Pending approvals?', 'Revenue this month?', 'Any anomalies detected?'],
  hr:      ['Who is on leave today?', 'Show attrition trend', 'Pending leave approvals?', 'Headcount by department?'],
  manager: ['Show pending approvals', 'Team attendance this month?', 'Revenue status?', 'Any overdue invoices?'],
};
const DEFAULT_CHIPS = ["What's my leave balance?", 'How do I apply for leave?', "What's my payslip status?", 'How to raise a complaint?'];
const getChips = (role) => ROLE_CHIPS[role] ?? DEFAULT_CHIPS;

const SUGGESTED_QUERIES = {
  Revenue: [
    "What is this month's revenue trend?",
    'Which product has the highest revenue?',
    'Compare Q1 vs Q2 revenue',
  ],
  HR: [
    'Why is Engineering payroll higher?',
    'Which department has the most headcount?',
    'Show attendance trends this week',
  ],
  Inventory: [
    'Which items are below reorder level?',
    'Show top 5 fast-moving SKUs',
    'Predict stock-out risk for next 30 days',
  ],
  Finance: [
    'Predict next 30 days cash flow',
    'Show largest expense anomaly this month',
    'What is our current accounts payable?',
  ],
};

const PrescriptiveIcon = ({ iconKey }) => {
  const map = {
    dollar: <IndianRupee size={20} />,
    users: <Users size={20} />,
    package: <Package size={20} />,
    trending: <TrendingUp size={20} />,
    calendar: <Calendar size={20} />,
  };
  return map[iconKey] || <Lightbulb size={20} />;
};

function ChartEmptyState({ setPage }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 24, textAlign: 'center' }}>
      <BarChart2 size={32} style={{ color: 'rgba(255,255,255,0.3)', marginBottom: 12 }} />
      <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', margin: '0 0 4px' }}>No data available</p>
      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', margin: '0 0 16px' }}>Connect your data sources to enable AI predictions</p>
      <button
        onClick={() => setPage && setPage('IntegrationsHub')}
        style={{ padding: '6px 16px', background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 7, cursor: 'pointer', fontSize: 12 }}
      >
        Configure Integrations →
      </button>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

const ERPIntelligence = ({ setPage }) => {
  const { role } = useAuth();

  // ── Intelligence (existing) state ─────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('agent');
  const [suggestCategory, setSuggestCategory] = useState('Revenue');

  const [forecastDays, setForecastDays] = useState(30);
  const [forecast,      setForecast]     = useState([]);
  const [attrition,     setAttrition]    = useState([]);
  const [salesForecast, setSalesForecast] = useState([]);
  const [inventory,     setInventory]    = useState([]);
  const [anomalies,     setAnomalies]    = useState([]);
  const [prescriptiveRecs, setPrescriptiveRecs] = useState([]);

  const [queryHistory, setQueryHistory] = useState([]);
  const inputRef = useRef(null);

  // ── AI Chat state ─────────────────────────────────────────────────────────
  const [chatMessages,  setChatMessages]  = useState([]);
  const [chatInput,     setChatInput]     = useState('');
  const [chatLoading,   setChatLoading]   = useState(false);
  const [chatError,     setChatError]     = useState(null);
  const [remaining,     setRemaining]     = useState(null);
  const [chatFeedback,  setChatFeedback]  = useState({});
  const chatBottomRef = useRef(null);
  const chatInputRef  = useRef(null);
  const isMounted     = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);
  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages, chatLoading]);

  const sendChatMessage = async (text) => {
    const userText = (text || chatInput).trim();
    if (!userText || chatLoading) return;
    const userMsg = { role: 'user', content: userText, ts: Date.now() };
    const history = [...chatMessages, userMsg].slice(-MAX_HISTORY);
    setChatMessages(history);
    setChatInput('');
    setChatLoading(true);
    setChatError(null);
    const apiMessages = history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
    try {
      const { data } = await api.post('/ai/llm-chat', { messages: apiMessages });
      if (!isMounted.current) return;
      setChatMessages(prev => [...prev, { role: 'assistant', content: data.reply, ts: Date.now() }]);
      if (data.remaining !== undefined) setRemaining(data.remaining);
    } catch (err) {
      if (!isMounted.current) return;
      const msg = err.response?.data?.error || err.message || 'Failed to reach AI.';
      const isRateLimit = err.response?.status === 429;
      setChatError(msg);
      if (isRateLimit) setRemaining(0);
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: isRateLimit ? "You've used all 20 messages for today. Resets tomorrow." : "Sorry, I'm having trouble connecting. Please try again.",
        ts: Date.now(), isError: true,
      }]);
    } finally {
      if (isMounted.current) setChatLoading(false);
    }
  };

  const sendChatFeedback = async (idx, vote) => {
    setChatFeedback(prev => ({ ...prev, [idx]: vote }));
    try { await api.post('/ai/feedback', { messageIndex: idx, feedback: vote }); } catch (_) {}
  };

  const handleChatKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  };

  const clearChat = () => { setChatMessages([]); setChatError(null); setChatInput(''); setChatFeedback({}); };

  const chips   = getChips(role);
  const canSend = remaining === null || remaining > 0;

  const fetchForecast = async (days) => {
    try {
      const { data } = await aiIntelligenceService.getCashFlowForecast(days);
      setForecast(Array.isArray(data) && data.length ? data : []);
    } catch {
      setForecast([]);
    }
  };

  useEffect(() => { fetchForecast(forecastDays); }, [forecastDays]);

  useEffect(() => {
    (async () => {
      const [atr, sal, inv, ano, presc] = await Promise.allSettled([
        aiIntelligenceService.getAttritionPrediction(),
        aiIntelligenceService.getSalesForecast(30),
        aiIntelligenceService.getInventoryDemand(),
        aiIntelligenceService.getAnomalies(),
        aiIntelligenceService.getPrescriptiveRecommendations?.(),
      ]);
      setAttrition(atr.status === 'fulfilled' && atr.value?.data?.length ? atr.value.data : []);
      setSalesForecast(sal.status === 'fulfilled' && sal.value?.data?.length ? sal.value.data : []);
      setInventory(inv.status === 'fulfilled' && inv.value?.data?.length ? inv.value.data : []);
      setAnomalies(ano.status === 'fulfilled' && ano.value?.data?.length ? ano.value.data : []);
      setPrescriptiveRecs(presc?.status === 'fulfilled' && presc.value?.data?.length ? presc.value.data : []);
    })();
  }, []);

  const handleQuery = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setResponse(null);
    const q = query.trim();
    try {
      const { data } = await aiIntelligenceService.queryERP(q);
      setResponse(data);
      setQueryHistory(prev => [{ q, res: data, ts: new Date() }, ...prev].slice(0, 10));
    } catch {
      const fallback = { answer: 'The AI backend is not yet configured on this server. Your administrator needs to connect an LLM provider to /api/ai/query.' };
      setResponse(fallback);
      setQueryHistory(prev => [{ q, res: fallback, ts: new Date() }, ...prev].slice(0, 10));
    }
    setLoading(false);
  };

  const loadHistoryItem = (item) => {
    setQuery(item.q);
    setResponse(item.res);
    inputRef.current?.focus();
  };

  const exportCSV = () => {
    if (!forecast.length) return;
    const rows = [['Date', 'Inflow', 'Outflow', 'Net'], ...forecast.map(r => [r.date, r.inflow, r.outflow, (r.inflow - r.outflow)])];
    const csv = rows.map(r => r.join(',')).join('\n');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: `cashflow_${forecastDays}d.csv`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const totalInflow  = forecast.reduce((s, r) => s + (r.inflow  || 0), 0);
  const totalOutflow = forecast.reduce((s, r) => s + (r.outflow || 0), 0);
  const netCash = totalInflow - totalOutflow;

  const tooltipStyle = {
    contentStyle: {
      backgroundColor: 'rgba(15,15,15,0.95)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '12px',
      color: '#f3f4f6',
    },
  };

  return (
    <div className="erp-intelligence-container">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="intelligence-header">
        <div className="title-section">
          <Brain className="icon-pulse" />
          <h1>ERP Intelligence Hub</h1>
          <p>AI-driven insights and predictive forecasting for your enterprise.</p>
        </div>
        <div className="tab-switcher">
          <button className={activeTab === 'agent' ? 'active' : ''} onClick={() => setActiveTab('agent')}>
            <Cpu size={18} /> LLM Agent
          </button>
          <button className={activeTab === 'predictive' ? 'active' : ''} onClick={() => setActiveTab('predictive')}>
            <Zap size={18} /> Predictive
          </button>
          <button className={activeTab === 'prescriptive' ? 'active' : ''} onClick={() => setActiveTab('prescriptive')}>
            <Lightbulb size={18} /> Prescriptive
          </button>
          <button className={activeTab === 'chat' ? 'active' : ''} onClick={() => setActiveTab('chat')}>
            <MessageSquare size={18} /> AI Chat
          </button>
        </div>
      </div>

      <div className="intelligence-content">

        {/* ── LLM Agent Tab ──────────────────────────────────────────────── */}
        {activeTab === 'agent' && (
          <div className="agent-layout">
            <div className="agent-layer glassmorphism">
              <div className="chat-interface">
                <div className="suggest-section">
                  <div className="suggest-tabs">
                    {Object.keys(SUGGESTED_QUERIES).map(cat => (
                      <button key={cat} className={suggestCategory === cat ? 'active' : ''} onClick={() => setSuggestCategory(cat)}>
                        {cat}
                      </button>
                    ))}
                  </div>
                  <div className="prompt-suggestions">
                    {SUGGESTED_QUERIES[suggestCategory].map(q => (
                      <button key={q} onClick={() => { setQuery(q); inputRef.current?.focus(); }}>
                        <ChevronRight size={12} /> {q}
                      </button>
                    ))}
                  </div>
                </div>

                <form onSubmit={handleQuery} className="query-box">
                  <Search size={20} className="search-icon" />
                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Ask anything about your business data..."
                  />
                  <button type="submit" disabled={loading}>
                    {loading ? <div className="spinner" /> : <ArrowRight />}
                  </button>
                </form>

                {response && (
                  <div className="agent-response fade-in">
                    <div className="response-header"><Cpu size={14} /> Agent Reply</div>
                    <div className="response-body">
                      <p>{response.answer}</p>
                      {response.analysis && (
                        <div className="data-deep-dive">
                          <h4>Analysis Reasoning</h4>
                          <ul>
                            {response.analysis.reasoning && <li>Reason: {response.analysis.reasoning}</li>}
                            {response.analysis.current_headcount && <li>Headcount: {response.analysis.current_headcount}</li>}
                            {response.analysis.avg_gross != null && <li>Avg salary: ₹{response.analysis.avg_gross.toLocaleString('en-IN')}</li>}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {queryHistory.length > 0 && (
              <div className="query-history glassmorphism">
                <div className="history-header"><History size={15} /> History</div>
                {queryHistory.map((item, i) => (
                  <div key={i} className="history-item" onClick={() => loadHistoryItem(item)}>
                    <div className="history-q">{item.q}</div>
                    <div className="history-ts">{item.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Predictive Tab ─────────────────────────────────────────────── */}
        {activeTab === 'predictive' && (
          <div className="predictive-layer">
            <div className="horizon-bar glassmorphism">
              <span className="horizon-label">Forecast Horizon:</span>
              <div className="horizon-pills">
                {[7, 30, 90, 180].map(d => (
                  <button key={d} className={forecastDays === d ? 'active' : ''} onClick={() => setForecastDays(d)}>
                    {d}d
                  </button>
                ))}
              </div>
              <button className="export-btn" onClick={exportCSV} disabled={forecast.length === 0}>
                <Download size={15} /> Export CSV
              </button>
            </div>

            {anomalies.length > 0 && (
              <div className="anomaly-row">
                {anomalies.map((a, i) => (
                  <div key={i} className={`alert-chip sev-${a.severity}`}>
                    <AlertTriangle size={13} /> {a.message}
                  </div>
                ))}
              </div>
            )}

            <div className="summary-cards">
              <div className="card glassmorphism">
                <div className="card-lbl">{forecastDays}-Day Inflow</div>
                <div className="card-val inflow-txt"><TrendingUp size={20} /> ₹{totalInflow.toLocaleString('en-IN')}</div>
              </div>
              <div className="card glassmorphism">
                <div className="card-lbl">{forecastDays}-Day Outflow</div>
                <div className="card-val outflow-txt"><TrendingDown size={20} /> ₹{totalOutflow.toLocaleString('en-IN')}</div>
              </div>
              <div className="card glassmorphism">
                <div className="card-lbl">Net Cash Position</div>
                <div className={`card-val ${netCash >= 0 ? 'inflow-txt' : 'outflow-txt'}`}>
                  <IndianRupee size={20} /> {netCash < 0 ? '-' : ''}₹{Math.abs(netCash).toLocaleString('en-IN')}
                </div>
              </div>
            </div>

            <div className="chart-panel glassmorphism">
              <h3>Cash Flow Forecast — {forecastDays} Days</h3>
              {forecast.length === 0 ? (
                <div style={{ height: 260 }}><ChartEmptyState setPage={setPage} /></div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={forecast}>
                    <defs>
                      <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.08)" />
                    <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" fontSize={11} />
                    <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} />
                    <Tooltip {...tooltipStyle} />
                    <Area type="monotone" dataKey="inflow" stroke="#10b981" fillOpacity={1} fill="url(#gIn)" name="Inflow" />
                    <Area type="monotone" dataKey="outflow" stroke="#ef4444" fillOpacity={1} fill="url(#gOut)" name="Outflow" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="predictive-row">
              <div className="chart-panel glassmorphism">
                <h3>Attrition Risk by Department</h3>
                {attrition.length === 0 ? (
                  <div style={{ height: 220 }}><ChartEmptyState setPage={setPage} /></div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={attrition}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.08)" />
                      <XAxis dataKey="department" stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} unit="%" />
                      <Tooltip {...tooltipStyle} formatter={v => [`${v}%`, 'Risk']} />
                      <Bar dataKey="attrition_pct" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Attrition Risk" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="chart-panel glassmorphism">
                <h3>Sales Forecast</h3>
                {salesForecast.length === 0 ? (
                  <div style={{ height: 220 }}><ChartEmptyState setPage={setPage} /></div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={salesForecast}>
                      <defs>
                        <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.08)" />
                      <XAxis dataKey="week" stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <YAxis stroke="rgba(255,255,255,0.4)" fontSize={11} />
                      <Tooltip {...tooltipStyle} formatter={v => [`₹${v.toLocaleString('en-IN')}`, 'Revenue']} />
                      <Area type="monotone" dataKey="revenue" stroke="#3b82f6" fillOpacity={1} fill="url(#gSales)" name="Revenue" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="chart-panel glassmorphism">
              <h3>Inventory Demand Forecast (Units)</h3>
              {inventory.length === 0 ? (
                <div style={{ height: 220 }}><ChartEmptyState setPage={setPage} /></div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={inventory} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="rgba(255,255,255,0.08)" />
                    <XAxis type="number" stroke="rgba(255,255,255,0.4)" fontSize={11} />
                    <YAxis dataKey="item_name" type="category" stroke="rgba(255,255,255,0.4)" fontSize={11} width={110} />
                    <Tooltip {...tooltipStyle} formatter={v => [v, 'In Stock']} />
                    <Bar dataKey="current_stock" fill="#6B3FDB" radius={[0, 4, 4, 0]} name="Current Stock" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {/* ── Prescriptive Tab ───────────────────────────────────────────── */}
        {activeTab === 'prescriptive' && (
          <div className="prescriptive-layer">
            <div className="prescriptive-intro glassmorphism">
              <Lightbulb size={26} className="icon-gold" />
              <div>
                <h3>Prescriptive Intelligence</h3>
                <p>Data-driven actions ranked by urgency, based on live ERP signals and forecasts.</p>
              </div>
            </div>

            <div className="prescriptive-grid">
              {prescriptiveRecs.length === 0 ? (
                <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '48px 24px' }}>
                  <Lightbulb size={40} style={{ marginBottom: 12, opacity: 0.4, color: 'rgba(255,255,255,0.5)' }} />
                  <p style={{ margin: 0, fontSize: 15, color: 'rgba(255,255,255,0.6)' }}>No prescriptive recommendations available yet.</p>
                  <p style={{ margin: '6px 0 16px', fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>Recommendations will appear once the AI backend analyses live ERP data.</p>
                  <button
                    onClick={() => setPage && setPage('IntegrationsHub')}
                    style={{ padding: '7px 18px', background: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}
                  >
                    Configure Integrations →
                  </button>
                </div>
              ) : prescriptiveRecs.map((rec, i) => (
                <div key={i} className={`prescriptive-card glassmorphism prio-${rec.priority}`}>
                  <div className="prec-icon-wrap">
                    <PrescriptiveIcon iconKey={rec.iconKey} />
                  </div>
                  <div className="prec-body">
                    <div className="prec-meta">
                      <span className="prec-category">{rec.category}</span>
                      <span className={`prec-badge prio-badge-${rec.priority}`}>{rec.priority}</span>
                    </div>
                    <h4 className="prec-action">{rec.action}</h4>
                    <p className="prec-rationale">{rec.rationale}</p>
                    <div className="prec-impact"><TrendingUp size={13} /> {rec.impact}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── AI Chat Tab ────────────────────────────────────────────────── */}
        {activeTab === 'chat' && (
          <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 280px)', maxWidth:760, margin:'0 auto', width:'100%' }}>
            {/* Chat header */}
            <div className="aia-header" style={{ paddingTop:0 }}>
              <div className="aia-header-left">
                <div className="aia-icon-box" style={{ background:'linear-gradient(135deg,#6366f1,#8b5cf6)' }}>
                  <Sparkles size={18} color="#fff" />
                </div>
                <div>
                  <h1 className="aia-title">AI Assistant</h1>
                  <p className="aia-tagline">
                    Powered by Claude · ERP expert
                    {remaining !== null && (
                      <span className="aia-rate-badge">{remaining} messages left today</span>
                    )}
                  </p>
                </div>
              </div>
              {chatMessages.length > 0 && (
                <button onClick={clearChat} className="aia-clear-btn">
                  <RotateCcw size={12} /> Clear
                </button>
              )}
            </div>

            {chatError && <div className="aia-error">{chatError}</div>}

            {/* Messages */}
            <div className="aia-messages" style={{ flex:1, overflowY:'auto' }}>
              {chatMessages.length === 0 && (
                <div className="aia-welcome-wrap">
                  <div className="aia-welcome-box" style={{ background:'linear-gradient(135deg,#1a1a2e,#16213e)' }}>
                    <Sparkles size={28} color="#6366f1" style={{ marginBottom:10 }} />
                    <p className="aia-welcome-heading" style={{ color:'#f3f4f6' }}>How can I help?</p>
                    <p className="aia-welcome-text" style={{ color:'rgba(255,255,255,0.6)' }}>Ask me about leave, payroll, projects, or anything in the ERP.</p>
                  </div>
                </div>
              )}

              {chatMessages.map((msg, i) => {
                const isUser      = msg.role === 'user';
                const hasFeedback = !isUser && !msg.isError;
                const vote        = chatFeedback[i];
                return (
                  <div key={i} className="aia-msg-group">
                    <div className="aia-msg-row" style={{ justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
                      {!isUser && (
                        <div className="aia-avatar" style={{ background:'linear-gradient(135deg,#6366f1,#8b5cf6)' }}>
                          <Bot size={14} color="#fff" />
                        </div>
                      )}
                      <div className="aia-bubble" style={{
                        borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                        background:   isUser ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : 'rgba(255,255,255,0.08)',
                        border:       isUser ? 'none' : '1px solid rgba(255,255,255,0.12)',
                        color:        '#f3f4f6',
                      }}>
                        {msg.content}
                      </div>
                      {isUser && (
                        <div className="aia-avatar aia-avatar--user">
                          <User size={14} color="#9ca3af" />
                        </div>
                      )}
                    </div>
                    {hasFeedback && (
                      <div className="aia-feedback-row">
                        <button className={`aia-feedback-btn${vote==='up'?' aia-feedback-btn--active':''}`} onClick={() => sendChatFeedback(i,'up')} disabled={!!vote}><ThumbsUp size={12} /></button>
                        <button className={`aia-feedback-btn${vote==='down'?' aia-feedback-btn--active aia-feedback-btn--down':''}`} onClick={() => sendChatFeedback(i,'down')} disabled={!!vote}><ThumbsDown size={12} /></button>
                        {vote && <span className="aia-feedback-thanks">Thanks for your feedback!</span>}
                      </div>
                    )}
                  </div>
                );
              })}

              {chatLoading && (
                <div className="aia-loading-row">
                  <div className="aia-avatar" style={{ background:'linear-gradient(135deg,#6366f1,#8b5cf6)' }}>
                    <Bot size={14} color="#fff" />
                  </div>
                  <div className="aia-loading-bubble">
                    <Loader size={13} color="#6366f1" style={{ animation:'spin 1s linear infinite' }} />
                    <span className="aia-thinking-text">Thinking…</span>
                  </div>
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Quick chips */}
            {chatMessages.length === 0 && (
              <div className="aia-chips">
                {chips.map((chip, i) => (
                  <button key={i} onClick={() => sendChatMessage(chip)} className="aia-chip" disabled={!canSend}>{chip}</button>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="aia-input-row">
              <textarea
                ref={chatInputRef}
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={handleChatKey}
                placeholder={canSend ? 'Ask a question… (Enter to send, Shift+Enter for new line)' : 'Daily message limit reached. Try again tomorrow.'}
                rows={2}
                className="aia-textarea"
                disabled={!canSend}
              />
              <button
                onClick={() => sendChatMessage()}
                disabled={!chatInput.trim() || chatLoading || !canSend}
                className="aia-send-btn"
                style={{
                  background: (!chatInput.trim() || chatLoading || !canSend) ? '#374151' : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                  cursor:     (!chatInput.trim() || chatLoading || !canSend) ? 'not-allowed' : 'pointer',
                }}
              >
                <Send size={16} color={(!chatInput.trim() || chatLoading || !canSend) ? '#6b7280' : '#fff'} />
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

export default ERPIntelligence;
