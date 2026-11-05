import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Megaphone, Pin, Settings2 } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { canRenderPage } from '@/config/menuCatalog';
import { MERGED_ROUTES } from '@/config/autoRouter';
import { PageHero, PageShell, LoadingState, LoadError, EmptyState } from '@/components/pulse-ui';
import { announcementHtml, announcementDate, markAnnouncementRead } from '../announcementFeed';
import './MyAnnouncements.css';

/**
 * My Announcements — the reader's side of HR Announcements.
 *
 * Open to every role by URL (PERSONAL_PAGES, no module). It is where the bell
 * sends an announcement notification: the HR administration page
 * (Announcements) is not, because employees cannot open it, so the bell used to
 * resolve to nothing for the people the announcement was written for.
 *
 *   - GET /announcements/active → the caller's company, audience and live
 *     announcements only (backend announcement.visibility.js). Nothing here
 *     widens that.
 *   - Opening an announcement — expanding it, or arriving from the bell with
 *     ?ref=<id> — is the deliberate action that records the read
 *     (POST /announcements/:id/read; the server takes the user from the token).
 *     Merely appearing in the list, here or in a dashboard widget, records nothing.
 *
 * ?ref of an announcement the caller cannot see (expired, archived, hidden, or
 * not addressed to them) shows a notice and nothing about it.
 */

const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

function AnnouncementCard({ ann, open, highlighted, onToggle }) {
  const ref = useRef(null);
  useEffect(() => {
    if (highlighted && ref.current?.scrollIntoView) ref.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [highlighted]);
  const bodyId = `myann-body-${ann.id}`;
  return (
    <article ref={ref} className={`myann-card${highlighted ? ' is-highlighted' : ''}${ann.is_read ? '' : ' is-unread'}`}>
      <button type="button" className="myann-head" aria-expanded={open} aria-controls={bodyId}
        onClick={() => onToggle(ann)}>
        <span className="myann-title">
          {ann.is_pinned && <Pin size={12} aria-label="Pinned" />}
          {ann.title}
        </span>
        <span className="myann-meta">
          {!ann.is_read && <span className="myann-new">New</span>}
          {ann.priority && ann.priority !== 'medium' && (
            <span className={`myann-pri is-${ann.priority}`}>{PRIORITY_LABEL[ann.priority] || ann.priority}</span>
          )}
          {ann.category && ann.category !== 'General' && <span className="myann-cat">{ann.category}</span>}
          <span className="myann-date">{announcementDate(ann)}</span>
        </span>
      </button>
      {open && (
        <div id={bodyId} className="myann-body"
          dangerouslySetInnerHTML={{ __html: announcementHtml(ann.message) }} />
      )}
    </article>
  );
}

export default function MyAnnouncements() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // This page is the READER. People who manage announcements land here from
  // the top-level menu and found only "No announcements right now", with nothing
  // pointing at the administration page (HR → Announcements). Offer the way
  // there — only to someone the server would let create (announcements:add) and
  // the route guard would let open it. It links to the existing page; it does
  // not turn this page into one.
  const auth = useAuth() || {};
  const canManage = typeof auth.hasPermission === 'function'
    && auth.hasPermission('announcements', 'add')
    && canRenderPage(auth.role, 'Announcements', {
      route: MERGED_ROUTES.Announcements, menuAccess: auth.menuAccess, hasPermission: auth.hasPermission,
    });
  const refId = searchParams.get('ref');
  const [state, setState] = useState({ phase: 'loading', items: [] });
  const [openIds, setOpenIds] = useState(() => new Set());

  const load = useCallback(async () => {
    setState((s) => ({ ...s, phase: 'loading' }));
    try {
      const { data } = await api.get('/announcements/active');
      setState({ phase: 'ready', items: Array.isArray(data) ? data : [] });
    } catch (err) {
      setState({ phase: 'error', items: [], message: err?.response?.data?.message || err?.message || 'Could not load announcements.' });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const markRead = useCallback((ann) => {
    if (ann.is_read) return;
    markAnnouncementRead(ann.id).then((ok) => {
      if (!ok) return;
      setState((s) => ({ ...s, items: s.items.map((a) => (a.id === ann.id ? { ...a, is_read: true } : a)) }));
    });
  }, []);

  const onToggle = (ann) => {
    const opening = !openIds.has(ann.id);
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (opening) next.add(ann.id); else next.delete(ann.id);
      return next;
    });
    if (opening) markRead(ann);   // outside the updater: StrictMode runs updaters twice
  };

  // Arriving from the bell is the deliberate open: expand it and record the read once.
  const refHandled = useRef(null);
  useEffect(() => {
    if (state.phase !== 'ready' || !refId || refHandled.current === refId) return;
    refHandled.current = refId;
    const ann = state.items.find((a) => String(a.id) === String(refId));
    if (!ann) return;
    setOpenIds((prev) => new Set(prev).add(ann.id));
    markRead(ann);
  }, [state.phase, state.items, refId, markRead]);

  const refUnavailable = refId && state.phase === 'ready'
    && !state.items.some((a) => String(a.id) === String(refId));

  return (
    <PageShell dock={
      <PageHero icon={Megaphone} eyebrow="Announcements" title="My Announcements"
        subtitle="Announcements from HR addressed to you. Open one to read it."
        actions={canManage ? (
          <button type="button" className="plh-cta" onClick={() => navigate('/Announcements')}>
            <Settings2 size={14} /> Manage announcements
          </button>
        ) : null} />
    }>
      <div className="myann-page">
        {refUnavailable && (
          <div role="alert" className="myann-unavailable">
            This announcement is no longer available to you. It may have expired or been withdrawn.
          </div>
        )}
        {state.phase === 'loading' && <LoadingState shape="lines" rows={5} />}
        {state.phase === 'error' && <LoadError message={state.message} onRetry={load} />}
        {state.phase === 'ready' && state.items.length === 0 && (
          <EmptyState title="No announcements right now"
            subtitle="When HR posts an announcement for you, it appears here." />
        )}
        {state.phase === 'ready' && state.items.length > 0 && (
          <div className="myann-list">
            {state.items.map((a) => (
              <AnnouncementCard key={a.id} ann={a} open={openIds.has(a.id)}
                highlighted={String(a.id) === String(refId)} onToggle={onToggle} />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
