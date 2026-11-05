/**
 * announcementFeed.js — how employee-facing widgets show an announcement.
 *
 * Shared by Home, the Employee Dashboard and Employee Self Service, which all
 * render rows from GET /announcements/active (or /home/summary — same backend
 * query, announcement.visibility.js). Those rows carry `title`, `message` (HTML
 * written by the HR rich-text editor), `published_at` / `from_date`, and the
 * caller's own `is_read`. Two widgets used to read `description` and `date`,
 * which the API never sent, so only the title ever showed; Home printed the
 * message's HTML tags as text.
 */
import DOMPurify from 'dompurify';
import api from '@/services/api/client';

/** The message HTML, sanitised the same way the HR Announcements page does. */
export const announcementHtml = (html) =>
  DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true } });

/**
 * The message as one line of plain text, for compact rows that clamp to a line
 * or two. Sanitised first, then reduced to its text — no markup reaches the DOM.
 */
export function announcementText(html) {
  // Block ends and <br> become spaces so "line one</p><p>line two" does not run together.
  const clean = announcementHtml(html).replace(/<\/(p|div|li)>|<br\s*\/?>/gi, ' ');
  if (typeof document === 'undefined') return clean.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  // A detached element: parsed for its text only, never attached to the page.
  const el = document.createElement('div');
  el.innerHTML = clean;
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

/** "21 Oct 26" — when it went live (scheduled time, else From date). */
export function announcementDate(ann) {
  const v = ann?.published_at || ann?.from_date || ann?.created_at;
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

/**
 * Record that the caller deliberately opened announcement `id` — call it from an
 * open action (My Announcements: expanding a card, or arriving from the bell),
 * never because a row was merely displayed. Widgets that only list titles must
 * not call it: an impression is not a read.
 *
 * The server takes the user from the token and refuses anything not addressed
 * to them, so this can only ever mark the caller's own read. Resolves true when
 * recorded, false otherwise; never rejects or throws, whatever the client does.
 */
export function markAnnouncementRead(id) {
  return Promise.resolve()
    .then(() => api.post(`/announcements/${id}/read`))
    .then(() => true, () => false);
}
