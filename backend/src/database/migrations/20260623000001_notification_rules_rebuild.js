/**
 * 20260623000001_notification_rules_rebuild.js
 *
 * Rebuilds notification_rules table with:
 *  - UUID primary key
 *  - company_id scoping (INTEGER FK to companies)
 *  - New column names: event_key, title, channel (CSV string), recipient_roles (TEXT[]), enabled
 *  - is_system_default flag to protect built-in rules from deletion
 *  - Unique constraint on (company_id, event_key)
 * Seeds 22 default rules for every existing company.
 */

const DEFAULT_RULES = [
  // HR — Leaves
  { event_key: 'leave.applied',       title: 'Leave Application Submitted',   channel: 'in_app,email',  recipient_roles: ['manager','hr'],      enabled: true  },
  { event_key: 'leave.approved',      title: 'Leave Approved',                channel: 'in_app,email',  recipient_roles: ['employee'],          enabled: true  },
  { event_key: 'leave.rejected',      title: 'Leave Rejected',                channel: 'in_app,email',  recipient_roles: ['employee'],          enabled: true  },
  { event_key: 'leave.balance_low',   title: 'Low Leave Balance Alert',       channel: 'in_app',        recipient_roles: ['employee'],          enabled: true  },
  // HR — Attendance
  { event_key: 'attendance.absent',   title: 'Absent Without Leave Alert',    channel: 'in_app,email',  recipient_roles: ['manager','hr'],      enabled: true  },
  { event_key: 'attendance.late',     title: 'Late Arrival Notification',     channel: 'in_app',        recipient_roles: ['manager'],           enabled: false },
  // HR — Recruitment
  { event_key: 'recruitment.applied', title: 'New Job Application Received',  channel: 'in_app,email',  recipient_roles: ['hr','manager'],      enabled: true  },
  { event_key: 'recruitment.hired',   title: 'Candidate Hired',               channel: 'in_app,email',  recipient_roles: ['hr','admin'],        enabled: true  },
  { event_key: 'recruitment.offer',   title: 'Offer Letter Ready to Send',    channel: 'in_app',        recipient_roles: ['hr'],                enabled: true  },
  // Approvals
  { event_key: 'approval.pending',    title: 'Approval Request Waiting',      channel: 'in_app,email',  recipient_roles: ['approver'],          enabled: true  },
  { event_key: 'approval.approved',   title: 'Your Request Was Approved',     channel: 'in_app,email',  recipient_roles: ['employee'],          enabled: true  },
  { event_key: 'approval.rejected',   title: 'Your Request Was Rejected',     channel: 'in_app,email',  recipient_roles: ['employee'],          enabled: true  },
  // Finance
  { event_key: 'invoice.due',         title: 'Invoice Payment Due',           channel: 'in_app,email',  recipient_roles: ['finance','admin'],   enabled: true  },
  { event_key: 'invoice.overdue',     title: 'Invoice Overdue Alert',         channel: 'in_app,email',  recipient_roles: ['finance','admin'],   enabled: true  },
  { event_key: 'expense.submitted',   title: 'Expense Claim Submitted',       channel: 'in_app',        recipient_roles: ['manager','finance'], enabled: true  },
  { event_key: 'expense.approved',    title: 'Expense Claim Approved',        channel: 'in_app,email',  recipient_roles: ['employee'],          enabled: true  },
  // CRM / Sales
  { event_key: 'crm.lead_assigned',   title: 'New Lead Assigned to You',      channel: 'in_app,email',  recipient_roles: ['employee'],          enabled: true  },
  { event_key: 'sales.order_created', title: 'New Sales Order Created',       channel: 'in_app',        recipient_roles: ['manager','finance'], enabled: true  },
  // Service Desk
  { event_key: 'ticket.created',      title: 'New Support Ticket Created',    channel: 'in_app,email',  recipient_roles: ['service_desk'],      enabled: true  },
  { event_key: 'ticket.resolved',     title: 'Support Ticket Resolved',       channel: 'in_app,email',  recipient_roles: ['employee'],          enabled: true  },
  // System
  { event_key: 'user.created',        title: 'New User Account Created',      channel: 'in_app,email',  recipient_roles: ['admin'],             enabled: true  },
  { event_key: 'security.login_new',  title: 'New Login from Unknown Device', channel: 'in_app,email',  recipient_roles: ['self'],              enabled: true  },
];

export async function up(knex) {
  // Drop old schema (no company_id, wrong column names) and recreate
  await knex.raw(`DROP TABLE IF EXISTS notification_rules CASCADE`);

  await knex.raw(`
    CREATE TABLE notification_rules (
      id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id        INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      event_key         VARCHAR(100) NOT NULL,
      title             VARCHAR(200) NOT NULL,
      channel           VARCHAR(100) NOT NULL DEFAULT 'in_app',
      recipient_roles   TEXT[]       NOT NULL DEFAULT ARRAY['employee'],
      template          TEXT,
      enabled           BOOLEAN      NOT NULL DEFAULT TRUE,
      is_system_default BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE(company_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS idx_notif_rules_company ON notification_rules(company_id);
    CREATE INDEX IF NOT EXISTS idx_notif_rules_enabled ON notification_rules(company_id, enabled);
  `);

  // Seed default rules for every existing company
  const { rows: companies } = await knex.raw(`SELECT id FROM companies WHERE is_active = TRUE`);

  for (const company of companies) {
    const values = DEFAULT_RULES.map(r =>
      `(gen_random_uuid(), ${company.id}, '${r.event_key}', '${r.title}', '${r.channel}', ARRAY[${r.recipient_roles.map(x => `'${x}'`).join(',')}], ${r.enabled}, TRUE)`
    ).join(',\n      ');

    await knex.raw(`
      INSERT INTO notification_rules
        (id, company_id, event_key, title, channel, recipient_roles, enabled, is_system_default)
      VALUES
        ${values}
      ON CONFLICT (company_id, event_key) DO NOTHING
    `);
  }
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS notification_rules CASCADE`);
}
