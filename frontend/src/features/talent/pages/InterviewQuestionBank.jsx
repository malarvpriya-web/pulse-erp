import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  Plus, Search, X, HelpCircle, ChevronDown, ChevronUp,
  Pencil, Trash2, Copy, Check, BookOpen,
} from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const CATEGORIES = ['HR', 'Technical', 'Behavioural', 'Situational', 'Cultural Fit', 'Domain'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const DIFF_STYLE = {
  easy:   { bg: '#dcfce7', color: '#15803d', label: 'Easy' },
  medium: { bg: '#fef3c7', color: '#92400e', label: 'Medium' },
  hard:   { bg: '#fee2e2', color: '#b91c1c', label: 'Hard' },
};

const CAT_STYLE = {
  HR:           { bg: '#dbeafe', color: '#1d4ed8' },
  Technical:    { bg: '#ede9fe', color: '#6d28d9' },
  Behavioural:  { bg: '#fce7f3', color: '#9d174d' },
  Situational:  { bg: '#fef3c7', color: '#92400e' },
  'Cultural Fit': { bg: '#d1fae5', color: '#065f46' },
  Domain:       { bg: '#f0fdf4', color: '#15803d' },
};

const EMPTY_FORM = {
  question: '', category: 'HR', difficulty: 'medium',
  job_role: '', expected_answer: '', tags: [],
};

// ── Tag input ─────────────────────────────────────────────────────────────────
function TagInput({ value, onChange }) {
  const [input, setInput] = useState('');
  const tags = Array.isArray(value) ? value : [];
  const add = () => {
    const t = input.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setInput('');
  };
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 10px', minHeight: 38 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: tags.length ? 6 : 0 }}>
        {tags.map(t => (
          <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 3, background: '#ede9fe', color: '#6B3FDB', borderRadius: 20, padding: '2px 8px', fontSize: 11 }}>
            {t}
            <button onClick={() => onChange(tags.filter(x => x !== t))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B3FDB', padding: 0, lineHeight: 1 }}>×</button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
          placeholder="Add tag, press Enter"
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: 12, background: 'transparent' }}
        />
        {input.trim() && (
          <button onClick={add} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>Add</button>
        )}
      </div>
    </div>
  );
}

// ── Question modal ────────────────────────────────────────────────────────────
function QuestionModal({ question, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = !!question?.id;
  const [form, setForm] = useState(
    isEdit
      ? {
          question:        question.question || '',
          category:        question.category || 'HR',
          difficulty:      question.difficulty || 'medium',
          job_role:        question.job_role || '',
          expected_answer: question.expected_answer || '',
          tags:            Array.isArray(question.tags) ? question.tags : [],
        }
      : { ...EMPTY_FORM }
  );
  const [showAnswer, setShowAnswer] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSave = async () => {
    if (!form.question.trim()) return toast.error('Question text is required');
    if (!form.category)        return toast.error('Category is required');
    setSaving(true);
    try {
      if (isEdit) {
        await api.put(`/talent/questions/${question.id}`, form);
        toast.success('Question updated');
      } else {
        await api.post('/talent/questions', form);
        toast.success('Question added');
      }
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save question');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1f2937', margin: 0 }}>
            {isEdit ? 'Edit Question' : 'Add Question'}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Question text */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Question *</label>
            <textarea
              value={form.question}
              onChange={e => set('question', e.target.value)}
              placeholder="Enter interview question…"
              rows={3}
              style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }}
            />
          </div>

          {/* Category + Difficulty */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Category *</label>
              <select
                value={form.category}
                onChange={e => set('category', e.target.value)}
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', background: '#fff' }}
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Difficulty</label>
              <select
                value={form.difficulty}
                onChange={e => set('difficulty', e.target.value)}
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', background: '#fff' }}
              >
                {DIFFICULTIES.map(d => <option key={d} value={d} style={{ textTransform: 'capitalize' }}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>)}
              </select>
            </div>
          </div>

          {/* Job role */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Job Role</label>
            <input
              type="text"
              value={form.job_role}
              onChange={e => set('job_role', e.target.value)}
              placeholder="e.g. Software Engineer, Sales Manager"
              style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
            />
          </div>

          {/* Tags */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Tags</label>
            <TagInput value={form.tags} onChange={v => set('tags', v)} />
          </div>

          {/* Expected answer (collapsible) */}
          <div>
            <button
              onClick={() => setShowAnswer(v => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#6b7280', padding: 0 }}
            >
              {showAnswer ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              Expected Answer / Hints for Interviewer
            </button>
            {showAnswer && (
              <textarea
                value={form.expected_answer}
                onChange={e => set('expected_answer', e.target.value)}
                placeholder="Model answer or hints for the interviewer…"
                rows={4}
                style={{ marginTop: 8, width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit', background: '#fafafa' }}
              />
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || !form.question.trim()}
            style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: (saving || !form.question.trim()) ? 0.6 : 1 }}
          >
            {saving ? 'Saving…' : (isEdit ? 'Update' : 'Add Question')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Question row ──────────────────────────────────────────────────────────────
function QuestionRow({ q, onEdit, onDelete }) {
  const [expanded,  setExpanded]  = useState(false);
  const [copied,    setCopied]    = useState(false);
  const diff  = DIFF_STYLE[q.difficulty]  || DIFF_STYLE.medium;
  const cat   = CAT_STYLE[q.category]     || { bg: '#f3f4f6', color: '#374151' };
  const tags  = Array.isArray(q.tags) ? q.tags : [];

  const copyQuestion = () => {
    navigator.clipboard.writeText(q.question).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
      <div
        style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start' }}
        onClick={() => setExpanded(v => !v)}
      >
        <HelpCircle size={16} color="#6B3FDB" style={{ marginTop: 2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 13, color: '#1f2937', margin: '0 0 6px', lineHeight: 1.5 }}>{q.question}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ background: cat.bg, color: cat.color, borderRadius: 20, padding: '2px 8px', fontSize: 10, fontWeight: 600 }}>{q.category}</span>
            <span style={{ background: diff.bg, color: diff.color, borderRadius: 20, padding: '2px 8px', fontSize: 10, fontWeight: 600 }}>{diff.label}</span>
            {q.job_role && (
              <span style={{ background: '#f3f4f6', color: '#6b7280', borderRadius: 20, padding: '2px 8px', fontSize: 10 }}>{q.job_role}</span>
            )}
            {tags.map(t => (
              <span key={t} style={{ background: '#faf5ff', color: '#6B3FDB', borderRadius: 20, padding: '2px 7px', fontSize: 10 }}>{t}</span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            onClick={e => { e.stopPropagation(); copyQuestion(); }}
            title="Copy question"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? '#15803d' : '#9ca3af', padding: '4px 6px', borderRadius: 6 }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            onClick={e => { e.stopPropagation(); onEdit(q); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: '4px 6px', borderRadius: 6 }}
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(q); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f87171', padding: '4px 6px', borderRadius: 6 }}
          >
            <Trash2 size={14} />
          </button>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: '4px 6px', borderRadius: 6 }}>
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>
      {expanded && q.expected_answer && (
        <div style={{ padding: '10px 16px 14px 44px', background: '#fafafa', borderTop: '1px solid #f0f0f4' }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: .4 }}>Expected Answer</p>
          <p style={{ fontSize: 12, color: '#374151', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{q.expected_answer}</p>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function QuestionBank() {
  const toast = useToast();
  const [questions,     setQuestions]     = useState([]);
  const [stats,         setStats]         = useState(null);
  const [loading,       setLoading]       = useState(false);
  const [showModal,     setShowModal]     = useState(false);
  const [editingQ,      setEditingQ]      = useState(null);
  const [filters, setFilters] = useState({ search: '', category: '', difficulty: '' });
  const [pendingDeleteQ, setPendingDeleteQ] = useState(null);

  const loadStats = useCallback(() => {
    api.get('/talent/questions/stats')
      .then(r => setStats(r.data?.data ?? null))
      .catch(() => {});
  }, []);

  const loadQuestions = useCallback(() => {
    setLoading(true);
    api.get('/talent/questions', {
      params: {
        search:     filters.search,
        category:   filters.category,
        difficulty: filters.difficulty,
      },
    })
      .then(r => setQuestions(r.data?.data ?? []))
      .catch(() => setQuestions([]))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadQuestions(); }, [loadQuestions]);

  const handleDelete = async () => {
    if (!pendingDeleteQ) return;
    const q = pendingDeleteQ;
    setPendingDeleteQ(null);
    try {
      await api.delete(`/talent/questions/${q.id}`);
      toast.success('Question deleted');
      loadQuestions();
      loadStats();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete');
    }
  };

  const openAdd  = ()  => { setEditingQ(null); setShowModal(true); };
  const openEdit = (q) => { setEditingQ(q);    setShowModal(true); };
  const onSaved  = ()  => { setShowModal(false); setEditingQ(null); loadQuestions(); loadStats(); };

  const setFilter = (k, v) => setFilters(p => ({ ...p, [k]: v }));

  // Group by category for display
  const grouped = {};
  questions.forEach(q => {
    const c = q.category || 'General';
    if (!grouped[c]) grouped[c] = [];
    grouped[c].push(q);
  });

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingDeleteQ}
        title="Delete Question"
        message="Delete this question?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDeleteQ(null)}
      />
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Question Bank</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>Interview questions library for your hiring team</p>
        </div>
        <button
          onClick={openAdd}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
        >
          <Plus size={15} /> Add Question
        </button>
      </div>

      {/* Stats row */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: '10px 18px', border: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', gap: 8 }}>
            <BookOpen size={15} color="#6B3FDB" />
            <span style={{ fontSize: 20, fontWeight: 700, color: '#1f2937' }}>{stats.total}</span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Total</span>
          </div>
          {Object.entries(stats.by_category).filter(([, v]) => v > 0).map(([cat, count]) => {
            const cs = CAT_STYLE[cat] || { bg: '#f3f4f6', color: '#374151' };
            return (
              <div
                key={cat}
                onClick={() => setFilter('category', filters.category === cat ? '' : cat)}
                style={{ background: filters.category === cat ? cs.bg : '#fff', borderRadius: 10, padding: '10px 14px', border: `1px solid ${filters.category === cat ? cs.color + '40' : '#f0f0f4'}`, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span style={{ fontSize: 16, fontWeight: 700, color: cs.color }}>{count}</span>
                <span style={{ fontSize: 11, color: '#6b7280' }}>{cat}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 320 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input
            value={filters.search}
            onChange={e => setFilter('search', e.target.value)}
            placeholder="Search questions…"
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
        <select
          value={filters.category}
          onChange={e => setFilter('category', e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', background: '#fff', minWidth: 140 }}
        >
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={filters.difficulty}
          onChange={e => setFilter('difficulty', e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', background: '#fff', minWidth: 130 }}
        >
          <option value="">All Difficulties</option>
          {DIFFICULTIES.map(d => <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>)}
        </select>
        {(filters.search || filters.category || filters.difficulty) && (
          <button
            onClick={() => setFilters({ search: '', category: '', difficulty: '' })}
            style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading…</div>
      ) : questions.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', border: '1px solid #f0f0f4' }}>
          <BookOpen size={44} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#6b7280', fontWeight: 500, margin: '0 0 4px' }}>
            {filters.search || filters.category || filters.difficulty ? 'No questions match your filters' : 'No questions yet'}
          </p>
          <p style={{ color: '#9ca3af', fontSize: 13, margin: '0 0 20px' }}>
            {filters.search || filters.category || filters.difficulty ? 'Try adjusting your filters' : 'Build your interview question library'}
          </p>
          {!filters.search && !filters.category && !filters.difficulty && (
            <button
              onClick={openAdd}
              style={{ padding: '9px 22px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              Add First Question
            </button>
          )}
        </div>
      ) : filters.category ? (
        // Single-category flat list when filtering
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {questions.map(q => (
            <QuestionRow key={q.id} q={q} onEdit={openEdit} onDelete={setPendingDeleteQ} />
          ))}
        </div>
      ) : (
        // Grouped by category
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {Object.entries(grouped).map(([cat, qs]) => {
            const cs = CAT_STYLE[cat] || { bg: '#f3f4f6', color: '#374151' };
            return (
              <div key={cat}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ background: cs.bg, color: cs.color, borderRadius: 20, padding: '4px 12px', fontSize: 12, fontWeight: 600 }}>{cat}</span>
                  <span style={{ fontSize: 12, color: '#9ca3af' }}>{qs.length} question{qs.length !== 1 ? 's' : ''}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {qs.map(q => (
                    <QuestionRow key={q.id} q={q} onEdit={openEdit} onDelete={setPendingDeleteQ} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <QuestionModal question={editingQ} onClose={() => { setShowModal(false); setEditingQ(null); }} onSaved={onSaved} />
      )}
    </div>
  );
}
