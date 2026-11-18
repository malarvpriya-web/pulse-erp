import { Network } from "lucide-react";
import { PageHero, PageShell } from '@/components/pulse-ui';
import DepartmentHeadsPanel from "../components/DepartmentHeadsPanel";
// The panel's table styles (prob-dh-*) live with the probation styles.
import "./Probation.css";

/**
 * HR › Department Heads — who heads each department.
 *
 * Its own page since 2026-11-11. It used to be a panel inside Probation
 * Management, but the head is used well beyond probation: probation reviewer,
 * first gate-pass approver (shared/gatePassApprover.js) and manager access to
 * the department's employee records (shared/employeeAccess.js). Access is
 * unchanged: hr:view to read, hr:edit to assign or remove (the server enforces
 * both on /department-heads).
 */
export default function DepartmentHeads() {
  return (
    <PageShell dock={
      <PageHero
        icon={Network}
        eyebrow="Human Resources"
        title="Department Heads"
        subtitle="The head of each department: probation reviewer, first gate-pass approver, manager access to its employees"
      />
    }>
      <DepartmentHeadsPanel />
    </PageShell>
  );
}
