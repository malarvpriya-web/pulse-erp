/**
 * 20260618000001_hr_recruitment_sequences.js
 *
 * Adds PostgreSQL sequences for HR / Recruitment document numbers
 * that were missing from the original document_sequences migration.
 *
 *  seq_emp   EMP-0001   employees.employee_code
 *  seq_req   REQ-0001   job_requisitions.requisition_number
 *  seq_job   JOB-0001   job_openings.job_number
 *  seq_bom   BOM-0001   bill_of_materials.bom_number
 *  seq_ofr   OFR-0001   job_offers.offer_number
 */

function extractNum(str, prefix) {
  if (!str) return 0;
  const raw = String(str).replace(prefix, '').replace(/^[-_]/, '');
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

async function safeMax(knex, table, col, prefix) {
  try {
    const r = await knex(table).max(`${col} as m`).first();
    return extractNum(r?.m, prefix);
  } catch (_) {
    return 0;
  }
}

export async function up(knex) {
  async function makeSeq(name, startVal) {
    const start = Math.max(startVal + 1, 1);
    await knex.raw(
      `CREATE SEQUENCE IF NOT EXISTS ${name} START WITH ${start} INCREMENT BY 1 NO CYCLE`
    );
  }

  const [maxEmp, maxReq, maxJob, maxBom, maxOfr] = await Promise.all([
    safeMax(knex, 'employees',          'employee_code',        'EMP-'),
    safeMax(knex, 'job_requisitions',   'requisition_number',   'REQ-'),
    safeMax(knex, 'job_openings',       'job_number',           'JOB-'),
    safeMax(knex, 'bill_of_materials',  'bom_number',           'BOM-'),
    safeMax(knex, 'job_offers',         'offer_number',         'OFR-'),
  ]);

  await makeSeq('seq_emp', maxEmp);
  await makeSeq('seq_req', maxReq);
  await makeSeq('seq_job', maxJob);
  await makeSeq('seq_bom', maxBom);
  await makeSeq('seq_ofr', maxOfr);
}

export async function down(knex) {
  for (const s of ['seq_emp', 'seq_req', 'seq_job', 'seq_bom', 'seq_ofr']) {
    await knex.raw(`DROP SEQUENCE IF EXISTS ${s}`);
  }
}
