// backend/src/modules/integrations/tally.routes.js
import express from 'express';
import pool    from '../../config/db.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();

function getTallyURL(configUrl) {
  return configUrl || process.env.TALLY_GATEWAY_URL || 'http://localhost:9000';
}

/* ── XML builder helpers ── */
function buildVoucherXML({ voucher_type, date, narration, ledger_entries, company_name }) {
  const company = company_name || process.env.TALLY_COMPANY || 'Manifest Technologies';
  const entries = ledger_entries.map(e =>
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${e.ledger_name}</LEDGERNAME><ISDEEMEDPOSITIVE>${e.amount >= 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${Math.abs(e.amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
  ).join('');
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${voucher_type}" ACTION="Create"><DATE>${date}</DATE><VOUCHERTYPENAME>${voucher_type}</VOUCHERTYPENAME><NARRATION>${narration}</NARRATION>${entries}</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

function parseLedgersXML(xml) {
  const regex = /<LEDGER NAME="([^"]+)">([\s\S]*?)<\/LEDGER>/g;
  const ledgers = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const name = m[1];
    const groupMatch   = m[2].match(/<PARENT>([^<]+)<\/PARENT>/);
    const balanceMatch = m[2].match(/<OPENINGBALANCE>([^<]+)<\/OPENINGBALANCE>/);
    ledgers.push({
      name,
      group_name:       groupMatch?.[1]  || '',
      opening_balance: parseFloat((balanceMatch?.[1] || '0').replace(/[^\d.-]/g, '')) || 0,
    });
  }
  return ledgers;
}

async function callTally(xmlBody, urlOverride, timeoutMs = 8000) {
  const url = getTallyURL(urlOverride);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=utf-8' },
      body: xmlBody,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: response.ok, text: await response.text(), status: response.status };
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === 'AbortError' ? 'Tally gateway timeout' : `Tally unreachable: ${err.message}`);
  }
}

async function getTallyConfig(company_id) {
  const { rows } = await pool.query(
    `SELECT * FROM tally_config WHERE company_id = $1`, [company_id]
  ).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

/* ── GET /api/integrations/tally/config ─────────────────────────── */
router.get('/config', async (req, res) => {
  try {
    const cfg = await getTallyConfig(companyOf(req));
    res.json({
      tally_url:    cfg?.tally_url    || process.env.TALLY_GATEWAY_URL || 'http://localhost:9000',
      company_name: cfg?.company_name || process.env.TALLY_COMPANY     || '',
      fy_start:     cfg?.fy_start     || null,
      fy_end:       cfg?.fy_end       || null,
      sync_ledgers:  cfg?.sync_ledgers  ?? true,
      sync_invoices: cfg?.sync_invoices ?? true,
      sync_payments: cfg?.sync_payments ?? true,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ── PUT /api/integrations/tally/config ─────────────────────────── */
router.put('/config', async (req, res) => {
  try {
    const { tally_url, company_name, fy_start, fy_end, sync_ledgers, sync_invoices, sync_payments } = req.body;
    const company_id = companyOf(req);

    await pool.query(`
      INSERT INTO tally_config
        (company_id, tally_url, company_name, fy_start, fy_end, sync_ledgers, sync_invoices, sync_payments, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (company_id) DO UPDATE SET
        tally_url    = EXCLUDED.tally_url,
        company_name = EXCLUDED.company_name,
        fy_start     = EXCLUDED.fy_start,
        fy_end       = EXCLUDED.fy_end,
        sync_ledgers  = EXCLUDED.sync_ledgers,
        sync_invoices = EXCLUDED.sync_invoices,
        sync_payments = EXCLUDED.sync_payments,
        updated_at   = NOW()
    `, [
      company_id,
      tally_url    || 'http://localhost:9000',
      company_name || null,
      fy_start     || null,
      fy_end       || null,
      sync_ledgers  ?? true,
      sync_invoices ?? true,
      sync_payments ?? true,
    ]);

    res.json({ success: true, message: 'Tally configuration saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ── GET /api/integrations/tally/sync-status ─────────────────────── */
router.get('/sync-status', async (req, res) => {
  const company_id = companyOf(req);

  const { rows: logs } = await pool.query(
    `SELECT * FROM tally_sync_log WHERE company_id = $1 ORDER BY started_at DESC LIMIT 5`, [company_id]
  ).catch(() => ({ rows: [] }));

  const { rows: led } = await pool.query(
    `SELECT COUNT(*) AS n, MAX(synced_at) AS last FROM tally_ledgers WHERE company_id = $1`, [company_id]
  ).catch(() => ({ rows: [{ n: 0, last: null }] }));

  const { rows: syncedInv } = await pool.query(
    `SELECT COUNT(*) AS n FROM invoices WHERE tally_synced = TRUE AND company_id = $1`, [company_id]
  ).catch(() => ({ rows: [{ n: 0 }] }));

  const { rows: unsyncedInv } = await pool.query(
    `SELECT COUNT(*) AS n FROM invoices WHERE tally_synced IS NOT TRUE AND company_id = $1`, [company_id]
  ).catch(() => ({ rows: [{ n: 0 }] }));

  const { rows: totalVouchers } = await pool.query(
    `SELECT COALESCE(SUM(records_synced),0) AS n FROM tally_sync_log WHERE status='completed' AND company_id = $1`, [company_id]
  ).catch(() => ({ rows: [{ n: 0 }] }));

  const { rows: lastLog } = await pool.query(
    `SELECT errors FROM tally_sync_log WHERE company_id = $1 ORDER BY started_at DESC LIMIT 1`, [company_id]
  ).catch(() => ({ rows: [] }));

  const cfg = await getTallyConfig(company_id);

  let connected = false;
  let connectionError = null;
  try {
    const { ok } = await callTally(
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Company</ID></HEADER><BODY></BODY></ENVELOPE>',
      cfg?.tally_url,
      3000
    );
    connected = ok;
  } catch (e) {
    connectionError = e.message;
  }

  res.json({
    connected,
    connection_error: connectionError,
    tally_url:    cfg?.tally_url || getTallyURL(),
    tally_version: null,
    ledger_count:  parseInt(led[0]?.n  || 0),
    last_sync:     led[0]?.last || null,
    unsynced_vouchers: parseInt(unsyncedInv[0]?.n || 0),
    recent_logs: logs,
    stats: {
      total_vouchers:    parseInt(totalVouchers[0]?.n || 0),
      synced_invoices:   parseInt(syncedInv[0]?.n    || 0),
      synced_payments:   0,
      last_error_count:  parseInt(lastLog[0]?.errors || 0),
    },
  });
});

/* ── GET /api/integrations/tally/unsynced ─────────────────────────── */
router.get('/unsynced', async (req, res) => {
  try {
    const company_id = companyOf(req);
    const { rows } = await pool.query(`
      SELECT
        id,
        invoice_number  AS reference,
        client_name     AS party,
        total_amount    AS amount,
        invoice_date    AS date,
        'Invoice'       AS type,
        CASE WHEN tally_synced IS NOT TRUE THEN 'pending' ELSE 'synced' END AS status,
        NULL::TEXT AS error
      FROM invoices
      WHERE company_id = $1
        AND (tally_synced IS NOT TRUE OR tally_synced IS NULL)
      ORDER BY invoice_date DESC
      LIMIT 100
    `, [company_id]).catch(() => ({ rows: [] }));

    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

/* ── GET /api/integrations/tally/errors ─────────────────────────────── */
router.get('/errors', async (req, res) => {
  try {
    const company_id = companyOf(req);
    const { rows } = await pool.query(`
      SELECT
        id,
        sync_type         AS voucher_type,
        sync_type         AS reference,
        detail->>'error'  AS message,
        started_at        AS created_at
      FROM tally_sync_log
      WHERE company_id = $1
        AND status = 'error'
      ORDER BY started_at DESC
      LIMIT 50
    `, [company_id]).catch(() => ({ rows: [] }));

    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

/* ── POST /api/integrations/tally/sync-ledgers ─────────────────────── */
router.post('/sync-ledgers', async (req, res) => {
  const company_id = companyOf(req);
  const cfg = await getTallyConfig(company_id);
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Ledger</ID></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Accounts</REPORTNAME></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
  let synced = 0, errors = 0;
  const logId = await pool.query(
    `INSERT INTO tally_sync_log (sync_type,status,company_id) VALUES('ledger_sync','running',$1) RETURNING id`, [company_id]
  ).then(r => r.rows[0]?.id).catch(() => null);

  try {
    const { text } = await callTally(xml, cfg?.tally_url);
    const ledgers = parseLedgersXML(text);

    if (!ledgers.length) throw new Error('No ledgers parsed from Tally response (check Tally is running)');

    for (const l of ledgers) {
      try {
        await pool.query(
          `INSERT INTO tally_ledgers (name,group_name,opening_balance,synced_at,company_id)
           VALUES($1,$2,$3,NOW(),$4)
           ON CONFLICT (name) DO UPDATE SET group_name=$2,opening_balance=$3,synced_at=NOW()`,
          [l.name, l.group_name, l.opening_balance, company_id]
        );
        synced++;
      } catch { errors++; }
    }

    await pool.query(`UPDATE tally_sync_log SET status='completed',records_synced=$1,errors=$2,completed_at=NOW() WHERE id=$3`, [synced, errors, logId]).catch(() => {});
    res.json({ success: true, synced, errors, message: `${synced} ledgers synced from Tally` });
  } catch (err) {
    await pool.query(`UPDATE tally_sync_log SET status='error',detail=$1,completed_at=NOW() WHERE id=$2`, [JSON.stringify({ error: err.message }), logId]).catch(() => {});
    res.json({
      success: false,
      simulated: true,
      message: err.message,
      hint: 'Ensure Tally is running and the gateway URL is configured',
      synced: 0,
    });
  }
});

/* ── POST /api/integrations/tally/push-voucher ─────────────────────── */
router.post('/push-voucher', async (req, res) => {
  const { voucher_type = 'Journal', date, narration = '', ledger_entries = [], company_name } = req.body;
  if (!date || !ledger_entries.length) return res.status(400).json({ success: false, message: 'date and ledger_entries required' });

  const cfg = await getTallyConfig(companyOf(req));
  const xml = buildVoucherXML({ voucher_type, date, narration, ledger_entries, company_name: company_name || cfg?.company_name });
  try {
    const { text, ok } = await callTally(xml, cfg?.tally_url);
    const success = ok && !text.includes('LINEERROR');
    res.json({ success, tally_response: text.slice(0, 500), voucher_type, date });
  } catch (err) {
    res.json({
      success: false,
      simulated: true,
      message: err.message,
      xml_preview: xml.slice(0, 400) + '…',
    });
  }
});

/* ── POST /api/integrations/tally/sync-voucher ──────────────────────── */
router.post('/sync-voucher', async (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) return res.status(400).json({ success: false, message: 'type and id are required' });

  const company_id = companyOf(req);
  const cfg = await getTallyConfig(company_id);

  try {
    let row = null;
    if (type === 'invoice') {
      const { rows } = await pool.query(
        `SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [id, company_id]
      );
      row = rows[0];
    }

    if (!row) return res.status(404).json({ success: false, message: `${type} not found` });

    const xml = buildVoucherXML({
      voucher_type: 'Receipt',
      date: (row.invoice_date || new Date()).toString().split('T')[0].replace(/-/g, ''),
      narration: `${row.invoice_number || id} — ${row.client_name || ''}`,
      ledger_entries: [
        { ledger_name: 'Bank Account',            amount:  parseFloat(row.total_amount) },
        { ledger_name: row.client_name || 'Sundry Debtors', amount: -parseFloat(row.total_amount) },
      ],
      company_name: cfg?.company_name,
    });

    await callTally(xml, cfg?.tally_url);

    if (type === 'invoice') {
      await pool.query(`UPDATE invoices SET tally_synced=TRUE WHERE id=$1`, [id]).catch(() => {});
    }

    res.json({ success: true, message: `${type} ${id} synced to Tally` });
  } catch (err) {
    res.json({
      success: false,
      simulated: true,
      message: err.message,
      hint: 'Ensure Tally is running and configured',
    });
  }
});

/* ── POST /api/integrations/tally/sync-all ─────────────────────── */
router.post('/sync-all', async (req, res) => {
  const company_id = companyOf(req);
  const { rows: log } = await pool.query(
    `INSERT INTO tally_sync_log (sync_type,status,company_id) VALUES('full_sync','running',$1) RETURNING id`, [company_id]
  ).catch(() => ({ rows: [{ id: null }] }));
  const jobId = log[0]?.id;

  res.json({ success: true, job_id: jobId, message: 'Full sync started. Poll GET /api/integrations/tally/sync-status' });

  setImmediate(async () => {
    let synced = 0, errors = 0;
    try {
      const cfg = await getTallyConfig(company_id);
      const { rows: invoices } = await pool.query(
        `SELECT * FROM invoices WHERE company_id=$1 AND (tally_synced IS NOT TRUE) AND status='paid' LIMIT 50`, [company_id]
      ).catch(() => ({ rows: [] }));

      for (const inv of invoices) {
        try {
          const xml = buildVoucherXML({
            voucher_type: 'Receipt',
            date: (inv.invoice_date || new Date()).toString().split('T')[0].replace(/-/g, ''),
            narration: `${inv.invoice_number} — ${inv.client_name}`,
            ledger_entries: [
              { ledger_name: 'Bank Account',                     amount:  parseFloat(inv.total_amount) },
              { ledger_name: inv.client_name || 'Sundry Debtors', amount: -parseFloat(inv.total_amount) },
            ],
            company_name: cfg?.company_name,
          });
          await callTally(xml, cfg?.tally_url);
          await pool.query(`UPDATE invoices SET tally_synced=TRUE WHERE id=$1`, [inv.id]).catch(() => {});
          synced++;
        } catch { errors++; }
      }

      await pool.query(
        `UPDATE tally_sync_log SET status='completed',records_synced=$1,errors=$2,completed_at=NOW() WHERE id=$3`,
        [synced, errors, jobId]
      ).catch(() => {});
    } catch (err) {
      await pool.query(
        `UPDATE tally_sync_log SET status='error',detail=$1,completed_at=NOW() WHERE id=$2`,
        [JSON.stringify({ error: err.message }), jobId]
      ).catch(() => {});
    }
  });
});

/* ── GET /api/integrations/tally/job/:id ─────────────────────────── */
router.get('/job/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM tally_sync_log WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Job not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
