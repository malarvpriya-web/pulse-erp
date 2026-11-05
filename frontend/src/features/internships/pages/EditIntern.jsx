import { useState, useEffect, useCallback } from 'react';
import { GraduationCap } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell, LoadingState, LoadError } from '@/components/pulse-ui';
import AddIntern from './AddIntern';

/**
 * Edit Intern = the Add Intern form in edit mode. Nothing else.
 *
 * This loader fetches the FULL record (documents included) by the `id` in the
 * URL — which survives a refresh — and mounts the one form with it.
 * `key={record.id}` remounts the form per intern: its state seeds once from
 * props, so a form must never be reused for a different person.
 */
export default function EditIntern({ setPage, urlParams }) {
  const id = urlParams?.id || null;
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!id) { setError('No intern selected. Open Edit from the internship register or an intern record.'); return; }
    setError(null);
    setRecord(null);
    try {
      const { data } = await api.get(`/interns/${encodeURIComponent(id)}`);
      setRecord(data);
    } catch (e) {
      setError(e?.response?.status === 404
        ? 'That intern does not exist, or is not in your company.'
        : (e?.response?.data?.error || e?.message || 'Could not load the intern.'));
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (record) return <AddIntern key={record.id} intern={record} setPage={setPage} />;

  return (
    <PageShell dock={<PageHero icon={GraduationCap} eyebrow="Internships" title="Edit Intern" subtitle="Loading the intern record…" />}>
      <div className="page-container">
        {error ? <LoadError message={error} onRetry={id ? load : undefined} /> : <LoadingState shape="lines" rows={8} />}
      </div>
    </PageShell>
  );
}
