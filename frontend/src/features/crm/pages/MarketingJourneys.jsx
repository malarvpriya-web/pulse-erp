/**
 * MarketingJourneys — operating email journeys.
 *
 * Reads /crm/journeys. The number that matters here is `emails_sent` (events
 * actually delivered), NOT the enrolment count: an enrolment can sit "active"
 * for weeks having received nothing, and the old sequences screen showed exactly
 * that number as though it meant engagement.
 *
 * When no SMTP transport is configured the page says so at the top rather than
 * showing a journey that quietly never runs.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  Send, Play, Pause, Ban, Mail, AlertTriangle, Users, Clock, ChevronDown, ChevronUp, Route,
} from 'lucide-react';
import { PageHero, PageShell } from '@/components/pulse-ui';

const STATES = {
  active:    { label: 'Active',    fg: '#047857', bg: '#d1fae5' },
  paused:    { label: 'Paused',    fg: '#b45309', bg: '#fef3c7' },
  completed: { label: 'Completed', fg: '#1d4ed8', bg: '#dbeafe' },
  stopped:   { label: 'Stopped',   fg: '#6b7280', bg: '#f3f4f6' },
  failed:    { label: 'Failed',    fg: '#b91c1c', bg: '#fee2e2' },
};

const EVENT_LABEL = {
  enrolled: 'Enrolled', sent: 'Email sent', skipped: 'Step skipped',
  condition_failed: 'Condition not met', paused: 'Paused', resumed: 'Resumed',
  completed: 'Journey finished', stopped: 'Stopped', failed: 'Send failed',
  exited_replied: 'Exited — replied', exited_goal: 'Exited — goal met',
};

const fmt = (d) => d ? new Date(d).toLocaleDateString('en-GB',
  { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const card = { background: '#fff', borderRadius: 10, border: '1px solid #f0f0f4' };
const btn = {
  padding: '7px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff',
  cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#374151',
  display: 'inline-flex', gap: 6, alignItems: 'center',
};

export default function MarketingJourneys() {
  const [journeys, setJourneys] = useState([]);
  const [delivery, setDelivery] = useState(null);
  const [open, setOpen] = useState(null);
  const [enrollments, setEnrollments] = useState({});
  const [events, setEvents] = useState({});
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const [running, setRunning] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    api.get('/crm/journeys')
      .then(r => {
        setJourneys(r.data?.data || []);
        setDelivery(r.data?.delivery || null);
        setDenied(false);
      })
      .catch(err => {
        if (err.response?.status === 403) { setDenied(true); setJourneys([]); }
        else toast.error(err.response?.data?.message || 'Could not load journeys');
      })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const loadEnrollments = async (id) => {
    try {
      const { data } = await api.get(`/crm/journeys/${id}/enrollments`, { params: { limit: 200 } });
      setEnrollments(e => ({ ...e, [id]: data?.data || [] }));
    } catch { setEnrollments(e => ({ ...e, [id]: [] })); }
  };

  const toggle = (id) => {
    const next = open === id ? null : id;
    setOpen(next);
    if (next && !enrollments[next]) loadEnrollments(next);
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const { data } = await api.post('/crm/journeys/run');
      const t = data?.data || {};
      // Report what actually happened, separately. One "processed" number would
      // let a run that delivered nothing read as a success.
      const parts = [];
      if (t.sent)      parts.push(`${t.sent} sent`);
      if (t.skipped)   parts.push(`${t.skipped} skipped`);
      if (t.completed) parts.push(`${t.completed} finished`);
      if (t.exited)    parts.push(`${t.exited} exited`);
      if (t.failed)    parts.push(`${t.failed} failed`);
      if (!t.due) toast.success('Nothing was due to send.');
      else if (t.failed) toast.error(`${parts.join(', ')} — ${t.errors?.[0]?.reason || 'see the timeline'}`);
      else toast.success(parts.join(', ') || 'Nothing to do');
      load();
      if (open) loadEnrollments(open);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Run failed');
    } finally { setRunning(false); }
  };

  const act = async (enrollment, verb) => {
    try {
      await api.post(`/crm/journeys/enrollments/${enrollment.id}/${verb}`,
        verb === 'stop' ? { reason: 'Stopped from the journeys workspace' } : {});
      toast.success(`${enrollment.subject_name || enrollment.email} — ${verb}d`);
      loadEnrollments(open); load();
    } catch (err) { toast.error(err.response?.data?.message || `${verb} failed`); }
  };

  const showEvents = async (enrollmentId) => {
    if (events[enrollmentId]) { setEvents(e => ({ ...e, [enrollmentId]: null })); return; }
    try {
      const { data } = await api.get(`/crm/journeys/enrollments/${enrollmentId}/events`);
      setEvents(e => ({ ...e, [enrollmentId]: data?.data || [] }));
    } catch { setEvents(e => ({ ...e, [enrollmentId]: [] })); }
  };

  return (
    <PageShell dock={
      <PageHero
        icon={Route}
        eyebrow="Marketing"
        title="Journeys"
        actions={
          <button className="plh-cta" onClick={runNow} disabled={running || denied}>
            <Play size={15} /> {running ? 'Running…' : 'Run due steps'}
          </button>
        }
      />
    }>
      {delivery && delivery.configured === false && (
        <div style={{ ...card, borderColor: '#fde68a', background: '#fffbeb', padding: '12px 16px',
                      marginBottom: 16, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <AlertTriangle size={16} color="#b45309" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#92400e' }}>
              No mail transport is configured
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#92400e' }}>
              {delivery.message} Enrolments stay exactly where they are — nothing is marked as sent
              that was not.
            </p>
          </div>
        </div>
      )}

      {denied ? (
        <div style={{ ...card, padding: 60, textAlign: 'center' }}>
          <Mail size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#6b7280', margin: 0, fontWeight: 600 }}>
            You do not have access to marketing journeys
          </p>
        </div>
      ) : loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : journeys.length === 0 ? (
        <div style={{ ...card, padding: 60, textAlign: 'center' }}>
          <Route size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af', margin: 0 }}>No journeys yet</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {journeys.map(j => {
            const isOpen = open === j.id;
            const rows = enrollments[j.id] || [];
            return (
              <div key={j.id} style={{ ...card, overflow: 'hidden' }}>
                <div onClick={() => toggle(j.id)}
                  style={{ padding: '14px 20px', cursor: 'pointer', display: 'flex',
                           justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <p style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>{j.name}</p>
                      {!j.is_active && (
                        <span style={{ background: '#f3f4f6', color: '#6b7280', padding: '2px 8px',
                                       borderRadius: 20, fontSize: 10, fontWeight: 700 }}>Inactive</span>
                      )}
                      <span style={{ color: '#9ca3af', fontSize: 11 }}>{j.step_count} steps</span>
                    </div>
                    <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap', fontSize: 11, color: '#6b7280' }}>
                      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <Users size={11} /> {j.active} active
                      </span>
                      {/* Delivered, not enrolled — the distinction the old screen lost. */}
                      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontWeight: 600, color: '#047857' }}>
                        <Send size={11} /> {j.emails_sent} sent
                      </span>
                      {j.due_now > 0 && (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', color: '#b45309', fontWeight: 600 }}>
                          <Clock size={11} /> {j.due_now} due now
                        </span>
                      )}
                      {j.failed > 0 && (
                        <span style={{ color: '#b91c1c', fontWeight: 600 }}>{j.failed} failed</span>
                      )}
                      <span>{j.completed} finished</span>
                      <span style={{ marginLeft: 'auto' }}>Last run {fmt(j.last_run_at)}</span>
                    </div>
                  </div>
                  {isOpen ? <ChevronUp size={16} color="#9ca3af" /> : <ChevronDown size={16} color="#9ca3af" />}
                </div>

                {isOpen && (
                  <div style={{ borderTop: '1px solid #f5f3ff', padding: '12px 20px 16px' }}>
                    {rows.length === 0 ? (
                      <p style={{ fontSize: 12, color: '#9ca3af', margin: 0 }}>Nobody is enrolled yet.</p>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                              <th style={{ padding: '6px 8px', fontWeight: 600 }}>Recipient</th>
                              <th style={{ padding: '6px 8px', fontWeight: 600 }}>State</th>
                              <th style={{ padding: '6px 8px', fontWeight: 600 }}>Step</th>
                              <th style={{ padding: '6px 8px', fontWeight: 600 }}>Received</th>
                              <th style={{ padding: '6px 8px', fontWeight: 600 }}>Next</th>
                              <th style={{ padding: '6px 8px', fontWeight: 600 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(e => {
                              const st = STATES[e.status] || STATES.stopped;
                              return (
                                <>
                                  <tr key={e.id} style={{ borderTop: '1px solid #f5f3ff' }}>
                                    <td style={{ padding: '8px' }}>
                                      <div style={{ fontWeight: 600, color: '#1f2937' }}>
                                        {e.subject_name || '—'}
                                      </div>
                                      <div style={{ color: '#9ca3af', fontSize: 11 }}>{e.email}</div>
                                    </td>
                                    <td style={{ padding: '8px' }}>
                                      <span style={{ background: st.bg, color: st.fg, padding: '2px 8px',
                                                     borderRadius: 20, fontSize: 10, fontWeight: 700 }}>
                                        {st.label}
                                      </span>
                                      {e.last_error && (
                                        <div style={{ color: '#b91c1c', fontSize: 10, marginTop: 3 }}>
                                          {e.last_error} ({e.attempts} tries)
                                        </div>
                                      )}
                                    </td>
                                    <td style={{ padding: '8px' }}>{e.current_step}</td>
                                    <td style={{ padding: '8px', fontWeight: 600 }}>{e.emails_received}</td>
                                    <td style={{ padding: '8px', color: '#6b7280' }}>{fmt(e.next_send_at)}</td>
                                    <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                      {e.status === 'active' && (
                                        <button style={{ ...btn, padding: '5px 9px' }} onClick={() => act(e, 'pause')}>
                                          <Pause size={12} /> Pause
                                        </button>
                                      )}
                                      {e.status === 'paused' && (
                                        <button style={{ ...btn, padding: '5px 9px' }} onClick={() => act(e, 'resume')}>
                                          <Play size={12} /> Resume
                                        </button>
                                      )}
                                      {['active', 'paused'].includes(e.status) && (
                                        <button style={{ ...btn, padding: '5px 9px', marginLeft: 6 }}
                                                onClick={() => act(e, 'stop')}>
                                          <Ban size={12} /> Stop
                                        </button>
                                      )}
                                      <button style={{ ...btn, padding: '5px 9px', marginLeft: 6 }}
                                              onClick={() => showEvents(e.id)}>
                                        Timeline
                                      </button>
                                    </td>
                                  </tr>
                                  {events[e.id] && (
                                    <tr key={`${e.id}-events`}>
                                      <td colSpan={6} style={{ padding: '4px 8px 12px', background: '#fafaff' }}>
                                        {events[e.id].length === 0
                                          ? <span style={{ fontSize: 11, color: '#9ca3af' }}>Nothing recorded yet.</span>
                                          : events[e.id].map(ev => (
                                            <div key={ev.id} style={{ display: 'flex', gap: 10, fontSize: 11,
                                                                      color: '#6b7280', padding: '2px 0' }}>
                                              <span style={{ minWidth: 130, fontWeight: 600, color: '#374151' }}>
                                                {EVENT_LABEL[ev.event] || ev.event}
                                              </span>
                                              {ev.step_order != null && <span>step {ev.step_order}</span>}
                                              <span style={{ flex: 1 }}>{ev.subject || ev.detail || ''}</span>
                                              <span>{fmt(ev.created_at)}</span>
                                            </div>
                                          ))}
                                      </td>
                                    </tr>
                                  )}
                                </>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
