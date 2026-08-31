// frontend/src/components/ai/DraftAssistButton.jsx
// Automation Opportunity Audit §27.2 — in-context drafting assist. A "draft
// this" button next to a free-text field, calling the existing /ai/llm-chat
// infrastructure with a task-specific prompt. Human stays in the loop: the
// draft fills the field via onDraft, the user edits/approves before saving —
// this component never submits anything itself.
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import api from '@/services/api/client';

export default function DraftAssistButton({ prompt, onDraft, label = 'Draft with AI', disabled }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const draft = async () => {
    if (!prompt || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.post('/ai/llm-chat', { messages: [{ role: 'user', content: prompt }] });
      onDraft?.(data.reply);
    } catch (e) {
      setError(
        e?.response?.status === 503
          ? 'AI drafting is not configured on this server.'
          : e?.response?.data?.error || 'Could not generate a draft.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        onClick={draft}
        disabled={disabled || loading || !prompt}
        title={disabled ? 'Fill in the fields above first' : 'Generate a draft with AI'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px',
          fontSize: 11, fontWeight: 600, color: '#6B3FDB', background: '#f5f3ff',
          border: '1px solid #ddd6fe', borderRadius: 6,
          cursor: (disabled || loading || !prompt) ? 'default' : 'pointer',
          opacity: (disabled || loading || !prompt) ? 0.6 : 1,
        }}
      >
        <Sparkles size={12} />
        {loading ? 'Drafting…' : label}
      </button>
      {error && <span style={{ fontSize: 11, color: '#dc2626' }}>{error}</span>}
    </span>
  );
}
