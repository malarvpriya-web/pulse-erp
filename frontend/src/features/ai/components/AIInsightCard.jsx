import { useState, useEffect, useRef } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import '../ai.css';

export default function AIInsightCard({ dashboardData }) {
  const [insight, setInsight] = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const firedRef = useRef(false);

  const generateInsight = async () => {
    if (!dashboardData) return;

    setLoading(true);
    setError(null);
    try {
      const res = await api.post('/ai/ceo-insights', { dashboardData });
      setInsight(res.data?.reply || 'No insight generated.');
    } catch (err) {
      const msg = err.response?.data?.error || 'Could not load insights — please refresh.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Fire once on mount regardless of whether KPIs have data.
  // An empty kpis object still gives the AI context to say "no data configured yet."
  // Manual Refresh button re-fires regardless of firedRef.
  useEffect(() => {
    if (!firedRef.current) {
      firedRef.current = true;
      generateInsight();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      background: 'linear-gradient(135deg, #667eea22, #764ba222)',
      border: '1px solid #6366f133',
      borderRadius: 12, padding: '16px 20px',
      marginBottom: 20,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={16} color="#6366f1" />
          <span style={{ fontWeight: 600, fontSize: 14, color: '#4338ca' }}>AI Insights (GPT)</span>
        </div>
        <button
          onClick={generateInsight}
          disabled={loading}
          aria-label="Regenerate insight"
          style={{
            background: 'none', border: 'none',
            cursor: loading ? 'not-allowed' : 'pointer',
            color: '#6366f1', opacity: loading ? 0.5 : 1,
          }}
        >
          <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}/>
        </button>
      </div>

      {loading && (
        <div style={{ color: '#6b7280', fontSize: 13 }}>Analyzing dashboard data…</div>
      )}
      {error && !loading && (
        <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>
      )}
      {insight && !loading && (
        <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
          {insight}
        </div>
      )}
      {!insight && !loading && !error && (
        <div style={{ color: '#9ca3af', fontSize: 13 }}>No data available for analysis.</div>
      )}
    </div>
  );
}
