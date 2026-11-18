// Finance's way into intern stipends (HR audit 2026-11-16): Finance holds
// payroll_payment:approve but not internships:view, so it cannot open the
// Internships page whose Stipends tab HR uses. Opened from the Approval Center
// (type `stip`) as /InternStipends. Same panel, same server checks.
import { Wallet } from 'lucide-react';
import { PageHero, PageShell } from '@/components/pulse-ui';
import InternStipendsPanel from './InternStipendsPanel';

export default function InternStipends() {
  return (
    <PageShell dock={<PageHero icon={Wallet} eyebrow="Internships" title="Intern Stipends"
      subtitle="Stipends raised by HR, and the payments Finance records" />}>
      <InternStipendsPanel />
    </PageShell>
  );
}
