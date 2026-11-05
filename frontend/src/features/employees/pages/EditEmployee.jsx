import { useState, useEffect, useCallback } from "react";
import { Users } from 'lucide-react';
import api from "@/services/api/client";
import { PageHero, PageShell, LoadingState, LoadError } from '@/components/pulse-ui';
import AddEmployee from './AddEmployee';

/**
 * Edit Employee = the Add Employee form in edit mode. Nothing else.
 *
 * This file used to be an 841-line second copy of the form, and the two had
 * drifted: fields added to Add Employee (photo preview, compensation, grade,
 * band, location master, zone master, field-employee flag…) were missing or
 * different here. A field that exists on one form and not the other is a
 * field HR can enter once and never correct. Now there is ONE form, so
 * "Add Employee fields = Edit Employee fields" holds by construction.
 *
 * What this loader adds is the data that form needs at mount:
 *
 *  - The FULL employee record from GET /employees/:id. The `employee` handed
 *    over by All Employees is a LIST row, which is a projection — seeding the
 *    form from it would show blanks for fields the record really holds, and a
 *    blank in a field that is SENT now clears it.
 *  - The salary revisions, so the form can correct the revision in force by
 *    id. A role that may edit employees but not read salary history (or a
 *    failed fetch) gets `null`, and the form shows the salary read-only rather
 *    than guessing which revision to change.
 *
 * `key={record.id}` remounts the form per employee: its state seeds once from
 * props, so a stale form must never be reused for a different person.
 */
export default function EditEmployee({ employee, setPage, setSelectedEmployee }) {
  // Both entry points (All Employees, Employee Profile) write the id to
  // sessionStorage immediately before navigating here; it also survives a
  // page refresh, which the in-memory selection does not.
  const storedId = (() => {
    try { return sessionStorage.getItem('selectedEmployeeId'); } catch { return null; }
  })();
  const id = storedId || (employee?.id != null ? String(employee.id) : null);

  const [record, setRecord] = useState(null);
  const [revisions, setRevisions] = useState(undefined);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!id) { setError('No employee selected. Open Edit Employee from All Employees or an employee profile.'); return; }
    setError(null);
    setRecord(null);
    try {
      const [{ data: emp }, revs] = await Promise.all([
        api.get(`/employees/${id}`),
        api.get(`/employees/${id}/salary-revisions`).then(r => r.data).catch(() => null),
      ]);
      setRevisions(Array.isArray(revs) ? revs : null);
      setRecord(emp);
    } catch (e) {
      setError(e?.response?.status === 404
        ? 'That employee no longer exists, or is not in your company.'
        : (e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Could not load the employee.'));
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (record) {
    return (
      <AddEmployee
        key={record.id}
        employee={record}
        salaryRevisions={revisions}
        setPage={setPage}
        setSelectedEmployee={setSelectedEmployee}
      />
    );
  }

  return (
    <PageShell dock={<PageHero icon={Users} eyebrow="Employees" title="Edit Employee" subtitle="Loading the employee record…" />}>
      <div className="page-container">
        {error ? <LoadError message={error} onRetry={id ? load : undefined} /> : <LoadingState shape="lines" rows={8} />}
      </div>
    </PageShell>
  );
}
