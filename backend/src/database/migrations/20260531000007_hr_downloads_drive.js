/**
 * HR Downloads — Google Drive redesign
 *
 * 1. Adds visible_to (role-based visibility) and file_type columns to hr_downloads.
 * 2. Seeds 26 standard HR document entries pointing to the Drive root folder
 *    so employees see useful content immediately after go-live.
 *
 * Drive subfolder IDs can be updated later via the Register Document UI once
 * HR has organised the folders in Drive.
 */

const DRIVE_ROOT = 'https://drive.google.com/drive/folders/1SeJEpixtJTrFiqtVSYhk24iS_YpfzgYH';

const SEED_DOCS = [
  // Letters
  { title: 'Offer Letter Template',             category: 'Letters',    file_type: 'DOCX', visible_to: 'hr_only' },
  { title: 'Appointment Letter Template',        category: 'Letters',    file_type: 'DOCX', visible_to: 'hr_only' },
  { title: 'Confirmation Letter Template',       category: 'Letters',    file_type: 'DOCX', visible_to: 'hr_only' },
  { title: 'Experience Letter Template',         category: 'Letters',    file_type: 'DOCX', visible_to: 'all'     },
  { title: 'Relieving Letter Template',          category: 'Letters',    file_type: 'DOCX', visible_to: 'all'     },
  { title: 'Salary Revision Letter Template',    category: 'Letters',    file_type: 'DOCX', visible_to: 'hr_only' },
  { title: 'Warning Letter Template',            category: 'Letters',    file_type: 'DOCX', visible_to: 'hr_only' },
  { title: 'Show Cause Notice Template',         category: 'Letters',    file_type: 'DOCX', visible_to: 'hr_only' },
  { title: 'Termination Letter Template',        category: 'Letters',    file_type: 'DOCX', visible_to: 'hr_only' },
  // Forms
  { title: 'Leave Application Form',             category: 'Forms',      file_type: 'PDF',  visible_to: 'all'     },
  { title: 'Expense Claim Form',                 category: 'Forms',      file_type: 'XLSX', visible_to: 'all'     },
  { title: 'Asset Request Form',                 category: 'Forms',      file_type: 'PDF',  visible_to: 'all'     },
  { title: 'Employee Feedback Form',             category: 'Forms',      file_type: 'PDF',  visible_to: 'all'     },
  { title: 'Exit Interview Form',                category: 'Forms',      file_type: 'PDF',  visible_to: 'all'     },
  { title: 'Loan / Advance Request Form',        category: 'Forms',      file_type: 'PDF',  visible_to: 'all'     },
  // Onboarding
  { title: 'New Employee Checklist',             category: 'Onboarding', file_type: 'PDF',  visible_to: 'all'     },
  { title: 'IT Asset Handover Form',             category: 'Onboarding', file_type: 'PDF',  visible_to: 'all'     },
  { title: 'Non-Disclosure Agreement (NDA)',     category: 'Onboarding', file_type: 'DOCX', visible_to: 'all'     },
  { title: 'Employee Data Form',                 category: 'Onboarding', file_type: 'PDF',  visible_to: 'all'     },
  // Templates
  { title: 'Monthly Attendance Report Template', category: 'Templates',  file_type: 'XLSX', visible_to: 'managers' },
  { title: 'Performance Review Template',        category: 'Templates',  file_type: 'DOCX', visible_to: 'managers' },
  { title: 'KPI Scorecard Template',             category: 'Templates',  file_type: 'XLSX', visible_to: 'managers' },
  // Policies
  { title: 'HR Policy Manual 2026',              category: 'Policies',   file_type: 'PDF',  visible_to: 'all'     },
  { title: 'Code of Conduct',                    category: 'Policies',   file_type: 'PDF',  visible_to: 'all'     },
  { title: 'Work From Home Policy',              category: 'Policies',   file_type: 'PDF',  visible_to: 'all'     },
  { title: 'Anti-Harassment Policy',             category: 'Policies',   file_type: 'PDF',  visible_to: 'all'     },
];

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params = []) => {
    const name = `sp_hrd_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!err.message?.includes('already exists') && !err.message?.includes('does not exist')) throw err;
    }
  };

  await safe(`ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS visible_to VARCHAR(50) NOT NULL DEFAULT 'all'`);
  await safe(`ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS file_type  VARCHAR(20)`);

  // Seed standard HR documents (company_id = NULL → visible to all tenants).
  // ON CONFLICT on (title, company_id) so re-running is safe.
  await safe(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_downloads_title_cid
    ON hr_downloads (title, COALESCE(company_id, -1))
  `);

  for (const doc of SEED_DOCS) {
    await safe(
      `INSERT INTO hr_downloads (title, category, file_url, file_type, visible_to, description, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT DO NOTHING`,
      [
        doc.title,
        doc.category,
        DRIVE_ROOT,
        doc.file_type,
        doc.visible_to,
        'Standard HR document — update Drive URL via Register Document.',
      ],
    );
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE hr_downloads DROP COLUMN IF EXISTS visible_to`);
  await knex.raw(`ALTER TABLE hr_downloads DROP COLUMN IF EXISTS file_type`);
  await knex.raw(`DROP INDEX IF EXISTS uq_hr_downloads_title_cid`);
}
