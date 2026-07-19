import { GitBranch, User, Loader } from 'lucide-react';

/**
 * Displays the live workflow state for a record row or card.
 *
 * Props:
 *   workflow  — object returned by GET /api/workflows/batch-status (or null if no workflow)
 *   loading   — boolean, shows a spinner while statuses are being fetched
 *   compact   — boolean, omit step/role lines (use on cards where space is tight)
 */

const STATUS_CFG = {
  pending:   { bg: '#fef3c7', color: '#92400e', label: 'Pending Approval' },
  approved:  { bg: '#dcfce7', color: '#15803d', label: 'Approved'         },
  rejected:  { bg: '#fee2e2', color: '#b91c1c', label: 'Rejected'         },
  cancelled: { bg: '#f3f4f6', color: '#6b7280', label: 'Cancelled'        },
  escalated: { bg: '#ede9fe', color: '#5b21b6', label: 'Escalated'        },
};

const ROLE_LABELS = {
  manager:        'Manager',
  finance_head:   'Finance Head',
  hr:             'HR',
  hr_manager:     'HR Manager',
  department_head:'Dept. Head',
  super_admin:    'Admin',
  admin:          'Admin',
  director:       'Director',
};

function roleLabel(role) {
  if (!role) return null;
  return ROLE_LABELS[role] || role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function WorkflowBadge({ workflow, loading = false, compact = false }) {
  if (loading) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#9ca3af', fontSize: 11 }}>
        <Loader size={11} style={{ animation: 'wf-spin 1s linear infinite' }} /> Loading…
      </span>
    );
  }

  if (!workflow) {
    return <span style={{ fontSize: 11, color: '#d1d5db' }}>—</span>;
  }

  const cfg = STATUS_CFG[workflow.status] || STATUS_CFG.pending;
  const rl  = roleLabel(workflow.current_step_role);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 100 }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', borderRadius: 12,
        fontSize: 11, fontWeight: 600,
        background: cfg.bg, color: cfg.color,
        width: 'fit-content',
      }}>
        <GitBranch size={10} />
        {cfg.label}
      </span>

      {!compact && workflow.current_step_name && (
        <span style={{ fontSize: 11, color: '#6b7280', paddingLeft: 2 }}>
          Step: {workflow.current_step_name}
        </span>
      )}

      {!compact && rl && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          fontSize: 11, color: '#9ca3af', paddingLeft: 2,
        }}>
          <User size={9} /> {rl}
        </span>
      )}

      <style>{`@keyframes wf-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
