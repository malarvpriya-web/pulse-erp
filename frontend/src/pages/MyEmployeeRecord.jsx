import React, { useState, useEffect } from 'react';
import { IdCard } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '../services/api/client';
import { PageShell, PageHero } from '@/components/pulse-ui';
import EmployeeProfile from '@/features/employees/pages/EmployeeProfile';

/*
 * HR > Self Service > My Details (2026-11-11) — the SAME View Employee page HR
 * uses (Overview · Personal · Job · Payroll · Documents · Assets ·
 * History), opened on the signed-in employee's OWN record in self view:
 * read-only, no Offboard / Edit Employee, and a "Request change" button that
 * raises a Record correction ticket to HR or Finance.
 *
 * GET /employees/:own leaves the statutory and bank numbers out for an
 * employee, so the masked values from /home/my-record are laid over it — the
 * employee can check them without the full numbers ever reaching the page.
 */
export default function MyEmployeeRecord({ setPage }) {
  const { user } = useAuth();
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data: mine } = await api.get('/home/my-record');
        if (!live) return;
        if (!mine?.linked) { setState({ loading: false, unlinked: true }); return; }
        const ownId = mine.employee_id ?? user?.employee_id;
        const res = ownId ? await api.get(`/employees/${ownId}`) : null;
        const row = res?.data?.employee || res?.data;
        if (!live) return;
        if (!row?.id) { setState({ loading: false, error: true }); return; }
        setState({ loading: false, employee: { ...row, ...(mine.masked || {}) } });
      } catch {
        if (live) setState({ loading: false, error: true });
      }
    })();
    return () => { live = false; };
  }, [user?.employee_id]);

  if (state.employee) return <EmployeeProfile employee={state.employee} setPage={setPage} selfView />;

  return (
    <PageShell dock={<PageHero icon={IdCard} eyebrow="Self Service" title="My Details" />}>
      <div style={{ padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 14 }}>
        {state.loading ? 'Loading your record…'
          : state.unlinked ? 'Your login is not linked to an employee record, so there is nothing to show. Ask HR to link your account.'
          : "Couldn't load your record. Please try again."}
      </div>
    </PageShell>
  );
}
