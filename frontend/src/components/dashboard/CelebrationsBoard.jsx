/* CelebrationsBoard — interactive wishes wall for today's celebrations.
 * Self-contained: fetches today's celebrants + wishes, lets ANY logged-in
 * user react with an emoji (tap again to un-react) or post a message.
 * Endpoints: GET /dashboard/celebrations-today, GET/POST /dashboard/celebration-wishes
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PartyPopper, Send } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import './CelebrationsBoard.css';

const QUICK_EMOJIS = ['🎉', '❤️', '👏', '🎂', '🥳', '🌟'];

const TYPE_META = {
  'Birthday':            { icon: '🎂', label: 'Birthday',            cls: 'cb-type-birthday',  greeting: 'Happy Birthday' },
  'Work Anniversary':    { icon: '🏆', label: 'Work Anniversary',    cls: 'cb-type-work',      greeting: 'Happy Work Anniversary' },
  'Wedding Anniversary': { icon: '💍', label: 'Wedding Anniversary', cls: 'cb-type-wedding',   greeting: 'Happy Anniversary' },
};

const CONFETTI = Array.from({ length: 12 }, (_, i) => i);

const initialsOf = (name) =>
  (name || 'E').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();

const keyOf = (c) => `${c.employeeId}|${c.type}`;

export default function CelebrationsBoard() {
  const { user } = useAuth();
  const myId = user?.userId ?? user?.id ?? null;

  const [celebrants, setCelebrants] = useState([]);
  const [wishes,     setWishes]     = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [drafts,     setDrafts]     = useState({});   // key → composer text
  const [sending,    setSending]    = useState({});   // key → bool
  const ctrl = useRef(null);

  const loadWishes = useCallback(async (signal) => {
    try {
      const { data } = await api.get('/dashboard/celebration-wishes', { signal });
      setWishes(Array.isArray(data?.wishes) ? data.wishes : []);
    } catch { /* keep previous wishes on failure */ }
  }, []);

  useEffect(() => {
    ctrl.current = new AbortController();
    const { signal } = ctrl.current;
    (async () => {
      try {
        const { data } = await api.get('/dashboard/celebrations-today', { signal });
        setCelebrants(Array.isArray(data?.celebrants) ? data.celebrants : []);
      } catch { /* empty board on failure */ }
      await loadWishes(signal);
      if (!signal.aborted) setLoading(false);
    })();
    return () => ctrl.current?.abort();
  }, [loadWishes]);

  const wishesFor = (c) =>
    wishes.filter(w => w.employee_id === c.employeeId && w.celebration_type === c.type);

  async function sendWish(c, { emoji, message }) {
    const k = keyOf(c);
    setSending(p => ({ ...p, [k]: true }));
    try {
      await api.post('/dashboard/celebration-wishes', {
        employee_id: c.employeeId,
        celebration_type: c.type,
        emoji: emoji || undefined,
        message: message || undefined,
      });
      if (message) setDrafts(p => ({ ...p, [k]: '' }));
      await loadWishes();
    } catch { /* toast-free: board simply doesn't update */ }
    setSending(p => ({ ...p, [k]: false }));
  }

  if (loading) return <div className="cb-shimmer" />;

  if (celebrants.length === 0) {
    return (
      <div className="cb-empty">
        <PartyPopper size={28} />
        <p>No celebrations today — check back tomorrow! 🎈</p>
      </div>
    );
  }

  return (
    <div className="cb-board">
      {celebrants.map(c => {
        const meta = TYPE_META[c.type] || TYPE_META.Birthday;
        const k = keyOf(c);
        const list = wishesFor(c);
        const msgs = list.filter(w => w.message);
        const emojiCounts = {};
        const myEmojis = new Set();
        for (const w of list) {
          if (!w.emoji || w.message) continue;
          emojiCounts[w.emoji] = (emojiCounts[w.emoji] || 0) + 1;
          if (myId != null && w.sender_user_id === myId) myEmojis.add(w.emoji);
        }
        return (
          <div key={k} className={`cb-card ${meta.cls}`}>
            <div className="cb-hero">
              {CONFETTI.map(i => <span key={i} className={`cb-confetti cb-cf-${i}`} />)}
              <div className="cb-avatar">
                {initialsOf(c.name)}
                <span className="cb-avatar-badge">{meta.icon}</span>
              </div>
              <div className="cb-who">
                <div className="cb-greeting">{meta.greeting}{c.years ? ` · ${c.years} yr${c.years > 1 ? 's' : ''}` : ''}!</div>
                <div className="cb-name">{c.name}</div>
                {c.dept && <div className="cb-dept">{c.dept}</div>}
              </div>
            </div>

            <div className="cb-reactions">
              {QUICK_EMOJIS.map(e => (
                <button
                  key={e}
                  className={`cb-emoji-chip ${myEmojis.has(e) ? 'cb-emoji-mine' : ''}`}
                  disabled={!!sending[k]}
                  onClick={() => sendWish(c, { emoji: e })}
                  title={myEmojis.has(e) ? 'Tap to remove your reaction' : `React with ${e}`}
                >
                  <span className="cb-emoji">{e}</span>
                  {emojiCounts[e] > 0 && <span className="cb-emoji-count">{emojiCounts[e]}</span>}
                </button>
              ))}
            </div>

            {msgs.length > 0 && (
              <div className="cb-wish-feed">
                {msgs.slice(-4).map(w => (
                  <div key={w.id} className="cb-wish-row">
                    <span className="cb-wish-sender">{w.sender_name}</span>
                    <span className="cb-wish-msg">{w.message}</span>
                  </div>
                ))}
                {msgs.length > 4 && <div className="cb-wish-more">+{msgs.length - 4} more wishes</div>}
              </div>
            )}

            <form
              className="cb-composer"
              onSubmit={(e) => {
                e.preventDefault();
                const text = (drafts[k] || '').trim();
                if (text) sendWish(c, { message: text });
              }}
            >
              <input
                className="cb-input"
                placeholder={`Wish ${c.name.split(' ')[0]}…`}
                value={drafts[k] || ''}
                maxLength={300}
                onChange={e => setDrafts(p => ({ ...p, [k]: e.target.value }))}
              />
              <button className="cb-send" type="submit" disabled={!!sending[k] || !(drafts[k] || '').trim()} aria-label="Send wish">
                <Send size={14} />
              </button>
            </form>
          </div>
        );
      })}
    </div>
  );
}
