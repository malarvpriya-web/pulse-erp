/* CelebrationSpotlight — full-screen, once-a-day login highlight of today's
 * celebrations (Birthday 🎂 · Work Anniversary 🏆 · Wedding Anniversary 💍).
 * Mounted globally in Layout so it greets every role on whatever page they
 * land on after login. One celebrant in the spotlight at a time (arrows/dots
 * to move between them); anyone can tap an emoji (tap again to remove) or
 * send a message without leaving the overlay. If the logged-in user is a
 * celebrant, their card leads with a personalised "your day" banner and
 * shows the wishes the team has sent them.
 * Shown once per user per day via localStorage; the persistent wishes wall
 * on Home/EmployeeDashboard (CelebrationsBoard) stays available all day.
 * Endpoints: GET /dashboard/celebrations-today, GET/POST /dashboard/celebration-wishes
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Send, X } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './CelebrationSpotlight.css';

const QUICK_EMOJIS = ['🎉', '❤️', '👏', '🥳', '🌟', '🎁'];

const TYPE_META = {
  'Birthday': {
    icon: '🎂', label: 'Birthday', cls: 'cs-type-birthday',
    greeting: 'Happy Birthday', selfGreeting: 'Happy Birthday to YOU',
  },
  'Work Anniversary': {
    icon: '🏆', label: 'Work Anniversary', cls: 'cs-type-work',
    greeting: 'Happy Work Anniversary', selfGreeting: 'Congratulations on your work anniversary',
  },
  'Wedding Anniversary': {
    icon: '💍', label: 'Wedding Anniversary', cls: 'cs-type-wedding',
    greeting: 'Happy Wedding Anniversary', selfGreeting: 'Happy Wedding Anniversary to you',
  },
};

const CONFETTI = Array.from({ length: 18 }, (_, i) => i);

const initialsOf = (name) =>
  (name || 'E').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();

const keyOf = (c) => `${c.employeeId}|${c.type}`;

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function CelebrationSpotlight() {
  const { user } = useAuth();
  const myUserId = user?.userId ?? user?.id ?? null;
  const myEmpId  = user?.employee_id ?? user?.employeeId ?? null;

  const [open,       setOpen]       = useState(false);
  const [celebrants, setCelebrants] = useState([]);
  const [wishes,     setWishes]     = useState([]);
  const [idx,        setIdx]        = useState(0);
  const [drafts,     setDrafts]     = useState({});   // key → composer text
  const [sending,    setSending]    = useState({});   // key → bool
  const [flyers,     setFlyers]     = useState([]);   // floating emoji bursts
  const flyerSeq = useRef(0);

  const loadWishes = useCallback(async () => {
    try {
      const { data } = await api.get('/dashboard/celebration-wishes');
      setWishes(Array.isArray(data?.wishes) ? data.wishes : []);
    } catch { /* keep previous wishes on failure */ }
  }, []);

  // Decide once per user per day whether to raise the spotlight.
  useEffect(() => {
    if (myUserId == null) return;
    const seenKey = `pulse_celeb_spotlight_${myUserId}_${todayKey()}`;
    if (localStorage.getItem(seenKey)) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const { data } = await api.get('/dashboard/celebrations-today', { signal: ctrl.signal });
        const list = Array.isArray(data?.celebrants) ? data.celebrants : [];
        if (list.length === 0) return;
        // The logged-in user's own celebration always leads the deck.
        list.sort((a, b) => (b.employeeId === myEmpId) - (a.employeeId === myEmpId));
        localStorage.setItem(seenKey, '1');   // strictly once a day, even if refreshed mid-view
        setCelebrants(list);
        setOpen(true);
        await loadWishes();
      } catch { /* no spotlight on failure */ }
    })();
    return () => ctrl.abort();
  }, [myUserId, myEmpId, loadWishes]);

  // Keyboard: Esc closes, arrows move between celebrants.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'ArrowRight') setIdx(i => Math.min(i + 1, celebrants.length - 1));
      if (e.key === 'ArrowLeft')  setIdx(i => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, celebrants.length]);

  if (!open || celebrants.length === 0) return null;

  const c    = celebrants[Math.min(idx, celebrants.length - 1)];
  const meta = TYPE_META[c.type] || TYPE_META.Birthday;
  const k    = keyOf(c);
  const isMe = myEmpId != null && c.employeeId === myEmpId;

  const list = wishes.filter(w => w.employee_id === c.employeeId && w.celebration_type === c.type);
  const msgs = list.filter(w => w.message);
  const emojiCounts = {};
  const myEmojis = new Set();
  for (const w of list) {
    if (!w.emoji || w.message) continue;
    emojiCounts[w.emoji] = (emojiCounts[w.emoji] || 0) + 1;
    if (myUserId != null && w.sender_user_id === myUserId) myEmojis.add(w.emoji);
  }
  const emojiBar = QUICK_EMOJIS.includes(meta.icon) ? QUICK_EMOJIS : [meta.icon, ...QUICK_EMOJIS.slice(0, 5)];

  async function sendWish({ emoji, message }) {
    setSending(p => ({ ...p, [k]: true }));
    try {
      const { data } = await api.post('/dashboard/celebration-wishes', {
        employee_id: c.employeeId,
        celebration_type: c.type,
        emoji: emoji || undefined,
        message: message || undefined,
      });
      if (message) setDrafts(p => ({ ...p, [k]: '' }));
      if (emoji && !data?.removed) {
        const id = ++flyerSeq.current;
        setFlyers(f => [...f, { id, emoji, left: 20 + Math.random() * 60 }]);
        setTimeout(() => setFlyers(f => f.filter(x => x.id !== id)), 1400);
      }
      await loadWishes();
    } catch { /* spotlight simply doesn't update */ }
    setSending(p => ({ ...p, [k]: false }));
  }

  return (
    <div className="cs-backdrop" onClick={() => setOpen(false)}>
      {CONFETTI.map(i => <span key={i} className={`cs-confetti cs-cf-${i}`} />)}

      <div className={`cs-card ${meta.cls}`} onClick={e => e.stopPropagation()}>
        <button className="cs-close" onClick={() => setOpen(false)} aria-label="Close">
          <X size={18} />
        </button>

        <div className="cs-count-pill">
          🎊 {celebrants.length === 1 ? 'A celebration today' : `${celebrants.length} celebrations today`}
        </div>

        <div className="cs-hero">
          <div className="cs-avatar">
            {initialsOf(c.name)}
            <span className="cs-avatar-badge">{meta.icon}</span>
          </div>
          <div className="cs-greeting">
            {isMe ? meta.selfGreeting : meta.greeting}
            {c.years ? ` · ${c.years} year${c.years > 1 ? 's' : ''}` : ''}!
          </div>
          <div className="cs-name">{isMe ? `${c.name} — that's you! 🎈` : c.name}</div>
          {c.dept && <div className="cs-dept">{c.dept}</div>}
          {isMe && <div className="cs-self-banner">The whole team can send you wishes today</div>}
        </div>

        <div className="cs-reactions">
          {emojiBar.map(e => (
            <button
              key={e}
              className={`cs-emoji-chip ${myEmojis.has(e) ? 'cs-emoji-mine' : ''}`}
              disabled={!!sending[k] || isMe}
              onClick={() => sendWish({ emoji: e })}
              title={isMe ? 'Reactions from your teammates show up here'
                          : myEmojis.has(e) ? 'Tap to remove your reaction' : `React with ${e}`}
            >
              <span className="cs-emoji">{e}</span>
              {emojiCounts[e] > 0 && <span className="cs-emoji-count">{emojiCounts[e]}</span>}
            </button>
          ))}
        </div>

        {msgs.length > 0 && (
          <div className="cs-wish-feed">
            {msgs.slice(-3).map(w => (
              <div key={w.id} className="cs-wish-row">
                <span className="cs-wish-sender">{w.sender_name}</span>
                <span className="cs-wish-msg">{w.message}</span>
              </div>
            ))}
            {msgs.length > 3 && <div className="cs-wish-more">+{msgs.length - 3} more wishes on the dashboard wall</div>}
          </div>
        )}

        {!isMe && (
          <form
            className="cs-composer"
            onSubmit={(e) => {
              e.preventDefault();
              const text = (drafts[k] || '').trim();
              if (text) sendWish({ message: text });
            }}
          >
            <input
              className="cs-input"
              placeholder={`Send ${c.name.split(' ')[0]} a wish…`}
              value={drafts[k] || ''}
              maxLength={300}
              onChange={e => setDrafts(p => ({ ...p, [k]: e.target.value }))}
            />
            <button className="cs-send" type="submit" disabled={!!sending[k] || !(drafts[k] || '').trim()} aria-label="Send wish">
              <Send size={15} />
            </button>
          </form>
        )}

        {celebrants.length > 1 && (
          <div className="cs-nav">
            <button className="cs-nav-btn" disabled={idx === 0} onClick={() => setIdx(i => i - 1)} aria-label="Previous celebrant">
              <ChevronLeft size={18} />
            </button>
            <div className="cs-dots">
              {celebrants.map((cc, i) => (
                <button
                  key={keyOf(cc)}
                  className={`cs-dot ${i === idx ? 'cs-dot-active' : ''}`}
                  onClick={() => setIdx(i)}
                  aria-label={`${cc.name} — ${cc.type}`}
                  title={`${cc.name} — ${cc.type}`}
                />
              ))}
            </div>
            <button className="cs-nav-btn" disabled={idx === celebrants.length - 1} onClick={() => setIdx(i => i + 1)} aria-label="Next celebrant">
              <ChevronRight size={18} />
            </button>
          </div>
        )}

        <div className="cs-flyers" aria-hidden="true">
          {flyers.map(f => (
            <span key={f.id} className="cs-flyer" style={{ left: `${f.left}%` }}>{f.emoji}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
