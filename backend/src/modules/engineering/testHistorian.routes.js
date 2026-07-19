import { Router } from 'express';
import pool from '../../config/db.js';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { getHarmonicLimit, THD_I_LIMIT_PERCENT, THD_V_LIMIT_PERCENT } from '../quality/iecLimits.js';
import { nextTestRunNumber } from '../../shared/docNumber.js';

// pdfkit is a CommonJS package — use createRequire for ESM compatibility.
// Graceful degradation: if not yet installed, the /certificate endpoint returns 503.
let PDFDocument = null;
try {
  const _req = createRequire(import.meta.url);
  PDFDocument = _req('pdfkit');
} catch (_) {
  console.warn('[testHistorian] pdfkit not installed — GET /runs/:id/certificate will return 503. Fix: cd backend && npm install');
}

const router = Router();

// Extract optional company scope (null = no isolation, backward compat)
const cid = (req) => req.scope?.company_id ?? null;

const actor = (req) => ({
  id: req.user?.userId || req.user?.id || null,
  name: req.user?.name || req.user?.email || 'System',
});

async function recomputeRunResult(client, runId) {
  const agg = await client.query(
    `SELECT
       COUNT(*)::INT AS total,
       COUNT(*) FILTER (WHERE result = 'fail')::INT AS fail_count,
       COUNT(*) FILTER (WHERE result = 'pass')::INT AS pass_count
     FROM test_run_measurements
     WHERE test_run_id = $1`,
    [runId]
  );
  const row = agg.rows[0] || { total: 0, fail_count: 0, pass_count: 0 };
  let overall = 'in_progress';
  if (Number(row.fail_count) > 0) overall = 'fail';
  else if (Number(row.total) > 0 && Number(row.pass_count) === Number(row.total)) overall = 'pass';
  await client.query(`UPDATE test_runs SET overall_result = $1, updated_at = NOW() WHERE id = $2`, [overall, runId]);
  return overall;
}

router.get('/runs', async (req, res) => {
  try {
    const { production_order_id, serial_number, test_stage, overall_result } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    const where = [`($1::int IS NULL OR r.company_id = $1)`];
    if (production_order_id) { params.push(production_order_id); where.push(`r.production_order_id = $${params.length}`); }
    if (serial_number) { params.push(serial_number); where.push(`r.serial_number = $${params.length}`); }
    if (test_stage) { params.push(test_stage); where.push(`r.test_stage = $${params.length}`); }
    if (overall_result) { params.push(overall_result); where.push(`r.overall_result = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT r.*,
          (SELECT COUNT(*) FROM test_run_measurements m WHERE m.test_run_id = r.id) AS measurement_count,
          (SELECT COUNT(*) FROM test_run_measurements m WHERE m.test_run_id = r.id AND m.result = 'fail') AS fail_count
       FROM test_runs r
       WHERE ${where.join(' AND ')}
       ORDER BY r.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/runs', async (req, res) => {
  try {
    const {
      production_order_id,
      product_id,
      product_name,
      serial_number,
      test_stage = 'FAT',
      test_type,
      test_spec_revision,
      station_name,
      started_at,
      remarks,
    } = req.body;
    if (!test_type) return res.status(400).json({ error: 'test_type is required' });
    const companyId = cid(req);
    const runNo = await nextTestRunNumber();
    const a = actor(req);
    const { rows } = await pool.query(
      `INSERT INTO test_runs
       (run_number, production_order_id, product_id, product_name, serial_number, test_stage, test_type, test_spec_revision,
        station_name, started_at, overall_result, remarks, executed_by, executed_by_name, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'in_progress',$11,$12,$13,$14)
       RETURNING *`,
      [runNo, production_order_id || null, product_id || null, product_name || null, serial_number || null, test_stage, test_type, test_spec_revision || null, station_name || null, started_at || new Date().toISOString(), remarks || null, a.id, a.name, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/runs/:id', async (req, res) => {
  try {
    const [run, measurements, attachments] = await Promise.all([
      pool.query(`SELECT * FROM test_runs WHERE id = $1`, [req.params.id]),
      pool.query(`SELECT * FROM test_run_measurements WHERE test_run_id = $1 ORDER BY id`, [req.params.id]),
      pool.query(`SELECT * FROM test_run_attachments WHERE test_run_id = $1 ORDER BY id DESC`, [req.params.id]),
    ]);
    if (!run.rows.length) return res.status(404).json({ error: 'Test run not found' });
    res.json({ ...run.rows[0], measurements: measurements.rows, attachments: attachments.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/runs/:id/measurements', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      parameter_code,
      parameter_name,
      unit,
      measured_value,
      min_limit,
      max_limit,
      target_value,
      channel_ref,
      waveform_ref,
      notes,
    } = req.body;
    if (!parameter_name) return res.status(400).json({ error: 'parameter_name is required' });
    let result = 'pass';
    const mv = measured_value !== undefined && measured_value !== null ? Number(measured_value) : null;
    const min = min_limit !== undefined && min_limit !== null ? Number(min_limit) : null;
    const max = max_limit !== undefined && max_limit !== null ? Number(max_limit) : null;
    if (mv === null || Number.isNaN(mv)) result = 'na';
    else if ((min !== null && mv < min) || (max !== null && mv > max)) result = 'fail';
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO test_run_measurements
        (test_run_id, parameter_code, parameter_name, unit, measured_value, min_limit, max_limit, target_value, result, channel_ref, waveform_ref, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [req.params.id, parameter_code || null, parameter_name, unit || null, mv, min, max, target_value || null, result, channel_ref || null, waveform_ref || null, notes || null]
    );
    await recomputeRunResult(client, req.params.id);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/runs/:id/attachments', async (req, res) => {
  try {
    const { file_name, file_path, file_type } = req.body;
    if (!file_name) return res.status(400).json({ error: 'file_name is required' });
    const a = actor(req);
    const { rows } = await pool.query(
      `INSERT INTO test_run_attachments
        (test_run_id, file_name, file_path, file_type, uploaded_by, uploaded_by_name)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [req.params.id, file_name, file_path || null, file_type || null, a.id, a.name]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/runs/:id/complete', async (req, res) => {
  const client = await pool.connect();
  try {
    const { remarks } = req.body;
    await client.query('BEGIN');
    const overall = await recomputeRunResult(client, req.params.id);
    const a = actor(req);
    const { rows } = await client.query(
      `UPDATE test_runs
       SET completed_at = NOW(),
           remarks = COALESCE($1, remarks),
           approved_by = $2,
           approved_by_name = $3,
           approved_at = NOW(),
           overall_result = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [remarks || null, a.id, a.name, overall, req.params.id]
    );
    await client.query('COMMIT');
    if (!rows.length) return res.status(404).json({ error: 'Test run not found' });
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── Schema migration: extend test_runs with Phase 29 columns ────────────────
   Runs on startup; ADD COLUMN IF NOT EXISTS is safe and idempotent.         */
(async () => {
  for (const sql of [
    `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS compliance_class TEXT DEFAULT 'class_a'`,
    `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS bom_header_id INT`,
    `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS bom_revision INT`,
    `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS report_generated_at TIMESTAMPTZ`,
    `ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS report_hash TEXT`,
  ]) { await pool.query(sql).catch(() => {}); }
})();

/* ── GET /runs/:id/compliance-score ──────────────────────────────────────────
   IEC 61000-3-2:2018 compliance check derived entirely from persisted DB
   measurements. Compares THD-I, THD-V, and per-harmonic values (H3, H5 …)
   against Class A/B/C/D limits from iecLimits.js.
   All limit values are fixed IEC constants — no runtime estimation.         */
router.get('/runs/:id/compliance-score', async (req, res) => {
  try {
    const [runRes, measRes] = await Promise.all([
      pool.query(
        `SELECT id, run_number, product_name, serial_number, test_stage, overall_result,
                COALESCE(compliance_class, 'class_a') AS compliance_class
         FROM test_runs WHERE id = $1`,
        [req.params.id]
      ),
      pool.query(
        `SELECT parameter_code, parameter_name, measured_value, unit
         FROM test_run_measurements
         WHERE test_run_id = $1 AND measured_value IS NOT NULL`,
        [req.params.id]
      ),
    ]);

    if (!runRes.rows.length) return res.status(404).json({ error: 'Test run not found' });

    const run        = runRes.rows[0];
    const cc         = run.compliance_class;
    const violations = [];

    for (const m of measRes.rows) {
      const val = parseFloat(m.measured_value);
      if (!Number.isFinite(val)) continue;

      if (m.parameter_code === 'THD_I') {
        const lim = THD_I_LIMIT_PERCENT[cc] ?? 5.0;
        if (val > lim) violations.push({
          parameter: 'THD-I', code: 'THD_I',
          measured: val, limit: lim, unit: '%',
          margin: +(val - lim).toFixed(3),
          standard: 'Practical PQ commissioning limit',
        });
      } else if (m.parameter_code === 'THD_V') {
        const lim = THD_V_LIMIT_PERCENT[cc] ?? 5.0;
        if (val > lim) violations.push({
          parameter: 'THD-V', code: 'THD_V',
          measured: val, limit: lim, unit: '%',
          margin: +(val - lim).toFixed(3),
          standard: 'Practical PQ commissioning limit',
        });
      } else {
        // Per-harmonic check — parameter_code format: H3, H5, H7 … H39
        const hm = /^H(\d+)$/i.exec(m.parameter_code);
        if (hm) {
          const order = parseInt(hm[1]);
          const lim   = getHarmonicLimit(order, cc);
          if (lim !== null && val > lim) violations.push({
            parameter: m.parameter_name || `H${order}`,
            code:           m.parameter_code,
            harmonic_order: order,
            measured:       val,
            limit:          lim,
            unit:           m.unit || 'A',
            margin:         +(val - lim).toFixed(4),
            standard:       `IEC 61000-3-2:2018 ${cc.replace('_', ' ').toUpperCase()} H${order}`,
          });
        }
      }
    }

    res.json({
      run_id:               run.id,
      run_number:           run.run_number,
      product_name:         run.product_name,
      serial_number:        run.serial_number,
      test_stage:           run.test_stage,
      compliance_class:     cc,
      overall:              violations.length === 0 ? 'pass' : 'fail',
      violation_count:      violations.length,
      violations,
      measurements_checked: measRes.rows.length,
      standard:             'IEC 61000-3-2:2018',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /runs/:id/certificate ────────────────────────────────────────────────
   Generates a reproducible, branded PDF FAT/SAT certificate from live DB data.
   The SHA-256 hash of the measurement snapshot is embedded in the footer and
   stored back on the test_run row for future audit verification.
   Requires: npm install pdfkit (in backend/).                               */
router.get('/runs/:id/certificate', async (req, res) => {
  if (!PDFDocument) {
    return res.status(503).json({
      error: 'PDF generation not available.',
      fix: 'Run: cd backend && npm install',
    });
  }

  try {
    const [runRes, measRes] = await Promise.all([
      pool.query(`SELECT * FROM test_runs WHERE id = $1`, [req.params.id]),
      pool.query(
        `SELECT * FROM test_run_measurements WHERE test_run_id = $1 ORDER BY id`,
        [req.params.id]
      ),
    ]);

    if (!runRes.rows.length) return res.status(404).json({ error: 'Test run not found' });
    const run          = runRes.rows[0];
    const measurements = measRes.rows;

    // Reproducibility hash — same DB state always produces same hash
    const hashInput = JSON.stringify({
      id: run.id, run_number: run.run_number, overall_result: run.overall_result,
      measurements: measurements.map(m => ({
        code: m.parameter_code, name: m.parameter_name,
        value: m.measured_value, min: m.min_limit, max: m.max_limit, result: m.result,
      })),
    });
    const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 24).toUpperCase();

    const toIST = (d) => {
      if (!d) return 'N/A';
      return new Date(d).toLocaleString('en-GB', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
        year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).replace(',', '') + ' IST';
    };

    const STAGE_LABELS = { FAT: 'Factory Acceptance Test', SAT: 'Site Acceptance Test' };
    const stageLabel  = STAGE_LABELS[run.test_stage] || run.test_stage;
    const overallPass = run.overall_result === 'pass';
    const generatedAt = toIST(new Date());
    const safeFile    = `${run.test_stage}-${run.run_number}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '_');

    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
    doc.pipe(res);

    const PW = 495; // usable width (595 - 2×50)
    const LM = 50;  // left margin

    // ── Purple header banner ────────────────────────────────────────────────
    doc.rect(0, 0, 595, 78).fill('#7c3aed');
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff')
       .text('MANIFEST TECHNOLOGIES', LM, 18, { width: PW });
    doc.font('Helvetica').fontSize(9).fillColor('#e9e4ff')
       .text('Pulse ERP — Industrial Engineering Platform', LM, 44, { width: PW });
    doc.font('Helvetica').fontSize(8).fillColor('#e9e4ff')
       .text(generatedAt, LM, 62, { width: PW, align: 'right' });

    // ── Certificate title ───────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1a2e')
       .text(stageLabel.toUpperCase() + ' CERTIFICATE', LM, 98, { width: PW, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#6b7280')
       .text(`Run Number: ${run.run_number}`, LM, 120, { width: PW, align: 'center' });

    // Purple divider
    doc.moveTo(LM, 140).lineTo(595 - LM, 140).strokeColor('#7c3aed').lineWidth(1.5).stroke();

    // ── Product info grid (2-column) ────────────────────────────────────────
    let y = 154;
    const infoRows = [
      ['Product Name',   run.product_name       || 'N/A', 'Serial Number',  run.serial_number      || 'N/A'],
      ['Test Stage',     run.test_stage,                   'Test Type',      run.test_type          || 'N/A'],
      ['Test Station',   run.station_name        || 'N/A', 'Spec Revision',  run.test_spec_revision || 'N/A'],
      ['Started (IST)',  toIST(run.started_at),            'Completed (IST)',toIST(run.completed_at)],
      ['Executed By',    run.executed_by_name    || 'N/A', 'Approved By',    run.approved_by_name   || 'N/A'],
    ];

    infoRows.forEach(([l1, v1, l2, v2]) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text(l1, LM, y);
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(v1, LM + 88, y, { width: 150 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text(l2, LM + 258, y);
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(v2, LM + 346, y, { width: 149 });
      y += 17;
    });

    y += 6;
    doc.moveTo(LM, y).lineTo(595 - LM, y).strokeColor('#e9e4ff').lineWidth(0.5).stroke();
    y += 12;

    // ── Measurements table ──────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#7c3aed').text('TEST MEASUREMENTS', LM, y);
    y += 16;

    // Header row
    const COL_X = [LM, LM + 168, LM + 218, LM + 278, LM + 338, LM + 393];
    doc.rect(LM, y, PW, 16).fill('#f5f3ff');
    ['Parameter', 'Unit', 'Min', 'Measured', 'Max', 'Result'].forEach((h, i) => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#7c3aed')
         .text(h, COL_X[i] + 3, y + 4, { width: i === 0 ? 162 : 54 });
    });
    y += 16;

    let alt = false;
    for (const m of measurements) {
      // Page overflow guard
      if (y > 740) { doc.addPage(); y = 50; }

      if (alt) doc.rect(LM, y, PW, 16).fill('#fafafa');
      alt = !alt;

      const rPass  = m.result === 'pass';
      const rNA    = m.result === 'na';
      const rColor = rPass ? '#15803d' : rNA ? '#6b7280' : '#dc2626';
      const rLabel = rPass ? 'PASS' : rNA ? 'N/A' : 'FAIL';

      doc.font('Helvetica').fontSize(7.5).fillColor('#111827')
         .text(m.parameter_name, COL_X[0] + 3, y + 4, { width: 162 });
      doc.font('Helvetica').fontSize(7.5).fillColor('#6b7280')
         .text(m.unit || '', COL_X[1] + 3, y + 4, { width: 54 });
      doc.font('Helvetica').fontSize(7.5).fillColor('#6b7280')
         .text(m.min_limit != null ? String(m.min_limit) : '—', COL_X[2] + 3, y + 4, { width: 54 });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#111827')
         .text(m.measured_value != null ? String(m.measured_value) : '—', COL_X[3] + 3, y + 4, { width: 54 });
      doc.font('Helvetica').fontSize(7.5).fillColor('#6b7280')
         .text(m.max_limit != null ? String(m.max_limit) : '—', COL_X[4] + 3, y + 4, { width: 54 });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(rColor)
         .text(rLabel, COL_X[5] + 3, y + 4, { width: 54 });
      y += 16;
    }

    // Table outer border
    const tableTop    = y - measurements.length * 16 - 16;
    const tableHeight = measurements.length * 16 + 16;
    doc.rect(LM, tableTop, PW, tableHeight).strokeColor('#e9e4ff').lineWidth(0.5).stroke();

    y += 12;
    if (y > 720) { doc.addPage(); y = 50; }

    // ── Overall result ──────────────────────────────────────────────────────
    doc.rect(LM, y, PW, 30)
       .fill(overallPass ? '#dcfce7' : '#fee2e2');
    doc.font('Helvetica-Bold').fontSize(13)
       .fillColor(overallPass ? '#15803d' : '#dc2626')
       .text(
         `OVERALL RESULT: ${overallPass ? '✓  PASS' : '✗  FAIL'}`,
         LM, y + 9, { width: PW, align: 'center' }
       );
    y += 42;

    // ── Signature section ───────────────────────────────────────────────────
    if (y > 660) { doc.addPage(); y = 50; }
    y += 8;
    const sigY = y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280')
       .text('EXECUTED BY', LM, sigY)
       .text('APPROVED BY', LM + 260, sigY);
    doc.font('Helvetica').fontSize(9).fillColor('#111827')
       .text(run.executed_by_name || '—', LM, sigY + 14)
       .text(run.approved_by_name || '—', LM + 260, sigY + 14);
    doc.font('Helvetica').fontSize(8).fillColor('#9ca3af')
       .text('Signature: ___________________________', LM, sigY + 28)
       .text('Signature: ___________________________', LM + 260, sigY + 28)
       .text(`Date: ${toIST(run.approved_at)}`, LM, sigY + 42)
       .text(`Date: ${toIST(run.approved_at)}`, LM + 260, sigY + 42);

    // ── Footer ──────────────────────────────────────────────────────────────
    doc.moveTo(LM, 778).lineTo(595 - LM, 778).strokeColor('#e9e4ff').lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(6.5).fillColor('#9ca3af')
       .text(
         `Generated: ${generatedAt}  |  SHA-256: ${hash}  |  Source: Pulse ERP live DB — test_runs#${run.id}`,
         LM, 782, { width: PW, align: 'center' }
       );

    doc.end();

    // Store hash non-blocking — audit trail for reproducibility verification
    pool.query(
      `UPDATE test_runs SET report_generated_at = NOW(), report_hash = $1 WHERE id = $2`,
      [hash, run.id]
    ).catch(() => {});

  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

export default router;
