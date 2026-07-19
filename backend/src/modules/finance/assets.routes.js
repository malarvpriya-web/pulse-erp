// backend/src/modules/finance/assets.routes.js
import express from 'express';
import pool from '../../config/db.js';
import journalRepo from './repositories/journal.repository.js';
import { nextAccountingJournalNumber } from '../../shared/docNumber.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = express.Router();

/* ── helper: company_id from request ── */
const cid = (req) => req.scope?.company_id ?? null;

/* ── helper: compute depreciation schedule ── */
function computeSchedule(asset) {
  const cost    = parseFloat(asset.purchase_cost);
  const salvage = parseFloat(asset.salvage_value || 0);
  const life    = parseFloat(asset.useful_life_years || 5);
  const method  = asset.depreciation_method || 'SLM';
  const wdvRate = parseFloat(asset.wdv_rate || 20) / 100;
  const purchaseYear = asset.purchase_date ? new Date(asset.purchase_date).getFullYear() : new Date().getFullYear();

  const schedule = [];
  let opening = cost;
  const years = Math.ceil(method === 'SLM' ? life : life * 1.5);

  for (let i = 0; i < years; i++) {
    if (opening <= salvage + 1) break;
    const fyStart = purchaseYear + i;
    const fy = `${fyStart}-${String(fyStart + 1).slice(-2)}`;
    let dep;
    if (method === 'SLM') {
      dep = (cost - salvage) / life;
    } else {
      dep = opening * wdvRate;
    }
    dep = Math.min(dep, opening - salvage);
    dep = Math.max(0, parseFloat(dep.toFixed(2)));
    const closing = parseFloat((opening - dep).toFixed(2));
    schedule.push({
      year: i + 1,
      fy,
      opening: parseFloat(opening.toFixed(2)),
      depreciation: dep,
      closing,
      accumulated: parseFloat((cost - closing).toFixed(2)),
    });
    opening = closing;
    if (closing <= salvage + 1) break;
  }
  return schedule;
}

/* ── GET /kpis ── */
router.get('/kpis', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    // Include rows with company_id IS NULL as a safety net for legacy/seed data
    const cidClause = companyId != null
      ? 'AND (company_id = $1 OR company_id IS NULL)'
      : '';
    const params    = companyId != null ? [companyId] : [];

    const [totals, expWarranty, fullyDep, byCategory, byDept] = await Promise.allSettled([
      pool.query(`
        SELECT
          COUNT(*) AS total_assets,
          COALESCE(SUM(purchase_cost),0) AS total_cost,
          COALESCE(SUM(current_book_value),0) AS net_book_value,
          COALESCE(SUM(accumulated_depreciation),0) AS total_accumulated_dep
        FROM fixed_assets WHERE LOWER(status)='active' ${cidClause}
      `, params),
      pool.query(`
        SELECT id, asset_code, name, warranty_expiry, department
        FROM fixed_assets
        WHERE warranty_expiry BETWEEN NOW() AND NOW()+INTERVAL '90 days'
          AND LOWER(status)='active' ${cidClause}
        ORDER BY warranty_expiry
      `, params),
      pool.query(`
        SELECT * FROM fixed_assets
        WHERE current_book_value <= salvage_value + 1 AND LOWER(status)='active' ${cidClause}
      `, params),
      pool.query(`
        SELECT COALESCE(category,'Uncategorised') AS category,
               COUNT(*) AS count,
               COALESCE(SUM(purchase_cost),0) AS cost
        FROM fixed_assets WHERE LOWER(status)='active' ${cidClause}
        GROUP BY category ORDER BY cost DESC
      `, params),
      pool.query(`
        SELECT COALESCE(department,'Unassigned') AS department,
               COUNT(*) AS count,
               COALESCE(SUM(current_book_value),0) AS book_value
        FROM fixed_assets WHERE LOWER(status)='active' ${cidClause}
        GROUP BY COALESCE(department,'Unassigned') ORDER BY count DESC
      `, params),
    ]);

    const t = totals.status === 'fulfilled' ? totals.value.rows[0] : {};
    res.json({
      total_assets:           parseInt(t.total_assets  || 0),
      total_cost:             parseFloat(t.total_cost  || 0),
      net_book_value:         parseFloat(t.net_book_value || 0),
      total_accumulated_dep:  parseFloat(t.total_accumulated_dep || 0),
      warranty_expiring_soon: expWarranty.status === 'fulfilled' ? expWarranty.value.rows : [],
      fully_depreciated:      fullyDep.status   === 'fulfilled' ? fullyDep.value.rows   : [],
      by_category:            byCategory.status === 'fulfilled' ? byCategory.value.rows : [],
      by_department:          byDept.status     === 'fulfilled' ? byDept.value.rows     : [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET / ── */
router.get('/', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, category, department } = req.query;

    let q = 'SELECT * FROM fixed_assets WHERE 1=1';
    const params = [];

    if (companyId != null) { params.push(companyId); q += ` AND (company_id=$${params.length} OR company_id IS NULL)`; }
    if (status)            { params.push(status);     q += ` AND LOWER(status)=LOWER($${params.length})`; }
    if (category)          { params.push(category);   q += ` AND category=$${params.length}`; }
    if (department)        { params.push(department); q += ` AND department=$${params.length}`; }
    q += ' ORDER BY asset_code';

    const { rows } = await pool.query(q, params);
    const now = new Date();
    res.json(rows.map(r => ({
      ...r,
      department: r.department || 'Unassigned',
      warranty_status: r.warranty_expiry
        ? (new Date(r.warranty_expiry) < now ? 'expired' : 'valid')
        : 'unknown',
      fully_depreciated: parseFloat(r.current_book_value) <= parseFloat(r.salvage_value) + 1,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST / ── */
router.post('/', requirePermission('finance', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req);
    const {
      asset_code, name, category, location, department,
      purchase_date, purchase_cost, salvage_value = 0,
      useful_life_years, depreciation_method = 'SLM', wdv_rate,
      vendor, invoice_number, serial_number, warranty_expiry, insurance_expiry, barcode, notes,
      payment_method = 'payable',
    } = req.body;

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO fixed_assets
         (asset_code, name, category, location, department,
          purchase_date, purchase_cost, salvage_value, useful_life_years,
          depreciation_method, wdv_rate, current_book_value, accumulated_depreciation,
          vendor, invoice_number, serial_number, warranty_expiry, insurance_expiry,
          barcode, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [asset_code, name, category, location, department,
       purchase_date, purchase_cost, salvage_value, useful_life_years,
       depreciation_method, wdv_rate, purchase_cost,
       vendor, invoice_number, serial_number, warranty_expiry, insurance_expiry,
       barcode, notes, companyId]
    );
    const asset = rows[0];
    const cost = parseFloat(purchase_cost) || 0;

    const categoryToAcct = {
      'Plant & Machinery': '1100', 'plant_machinery': '1100', 'Machinery': '1100',
      'Furniture & Fixtures': '1101', 'furniture': '1101', 'Furniture': '1101',
      'Computers & IT': '1102', 'computers': '1102', 'IT Equipment': '1102',
      'Vehicles': '1103', 'vehicles': '1103',
    };
    const assetAcctCode  = categoryToAcct[category] || '1100';
    const creditAcctCode = payment_method === 'cash' ? '1002' : '2001';

    if (cost > 0) {
      const { rows: accts } = await client.query(
        `SELECT id, code, name FROM chart_of_accounts WHERE code = ANY($1) AND is_active = true`,
        [[assetAcctCode, creditAcctCode]]
      );
      const acctMap = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});

      if (acctMap[assetAcctCode] && acctMap[creditAcctCode]) {
        const entryNumber = await nextAccountingJournalNumber(client);
        const { rows: [je] } = await client.query(
          `INSERT INTO journal_entries
             (entry_number, entry_date, entry_type, description, reference_type, reference_id,
              status, total_debit, total_credit, company_id, created_by)
           VALUES ($1,$2,'AssetPurchase',$3,'fixed_asset',$4,'posted',$5,$5,$6,$7) RETURNING id, entry_number`,
          [
            entryNumber,
            purchase_date || new Date().toISOString().split('T')[0],
            `Asset purchase — ${name} (${asset_code})`,
            asset.id, cost,
            companyId,
            req.user?.userId ?? req.user?.id ?? null,
          ]
        );
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration)
           VALUES ($1,$2,$3,$4,$5,0,$6),
                  ($1,$7,$8,$9,0,$5,$6)`,
          [
            je.id,
            acctMap[assetAcctCode].id, assetAcctCode, acctMap[assetAcctCode].name,
            cost,
            `Asset purchase — ${name}`,
            acctMap[creditAcctCode].id, creditAcctCode, acctMap[creditAcctCode].name,
          ]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json(asset);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── PUT /:id ── */
router.put('/:id', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const {
      name, category, location, department, purchase_date, purchase_cost, salvage_value,
      useful_life_years, depreciation_method, wdv_rate, vendor, invoice_number,
      serial_number, warranty_expiry, insurance_expiry, barcode, notes, status,
    } = req.body;

    const cidClause = companyId != null ? 'AND company_id=$20' : '';
    const params = [
      name, category, location, department, purchase_date, purchase_cost, salvage_value,
      useful_life_years, depreciation_method, wdv_rate, vendor, invoice_number,
      serial_number, warranty_expiry, insurance_expiry, barcode, notes, status,
      req.params.id,
    ];
    if (companyId != null) params.push(companyId);

    const { rows } = await pool.query(
      `UPDATE fixed_assets SET
         name=$1, category=$2, location=$3, department=$4, purchase_date=$5,
         purchase_cost=$6, salvage_value=$7, useful_life_years=$8,
         depreciation_method=$9, wdv_rate=$10, vendor=$11, invoice_number=$12,
         serial_number=$13, warranty_expiry=$14, insurance_expiry=$15, barcode=$16,
         notes=$17, status=$18, updated_at=NOW()
       WHERE id=$19 ${cidClause} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Asset not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── DELETE /:id — soft delete (status → archived) ── */
router.delete('/:id', requirePermission('finance', 'delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cidClause = companyId != null ? 'AND company_id=$2' : '';
    const params = companyId != null ? [req.params.id, companyId] : [req.params.id];

    const { rows } = await pool.query(
      `UPDATE fixed_assets SET status='archived', updated_at=NOW()
       WHERE id=$1 ${cidClause} RETURNING id, asset_code, name`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Asset not found' });
    res.json({ success: true, archived: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /:id/depreciation ── */
router.get('/:id/depreciation', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cidClause = companyId != null ? 'AND company_id=$2' : '';
    const params = companyId != null ? [req.params.id, companyId] : [req.params.id];

    const { rows: [asset] } = await pool.query(
      `SELECT * FROM fixed_assets WHERE id=$1 ${cidClause}`, params
    );
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    const schedule = computeSchedule(asset);
    res.json({ data: { asset, schedule } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /:id/dispose ── */
router.post('/:id/dispose', requirePermission('finance', 'approve'), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req);
    const { disposal_value, disposal_date, notes } = req.body;
    if (!disposal_value || !disposal_date) {
      return res.status(400).json({ error: 'disposal_value and disposal_date are required' });
    }

    const cidClause = companyId != null ? 'AND company_id=$2' : '';
    const lockParams = companyId != null ? [req.params.id, companyId] : [req.params.id];

    const { rows: [asset] } = await client.query(
      `SELECT * FROM fixed_assets WHERE id=$1 ${cidClause} FOR UPDATE`, lockParams
    );
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (asset.status === 'disposed') return res.status(400).json({ error: 'Asset is already disposed' });

    const dispVal  = parseFloat(disposal_value);
    const bookVal  = parseFloat(asset.current_book_value);
    const accumDep = parseFloat(asset.accumulated_depreciation || 0);
    const cost     = parseFloat(asset.purchase_cost);
    const gainLoss = dispVal - bookVal;
    const effDate  = disposal_date;

    await client.query('BEGIN');

    await client.query(
      `UPDATE fixed_assets SET status='disposed', current_book_value=0, updated_at=NOW(),
       notes=CONCAT(COALESCE(notes,''),$1)
       WHERE id=$2`,
      [` | Disposed on ${effDate} at ₹${dispVal.toLocaleString('en-IN')}${notes ? '. ' + notes : ''}`, req.params.id]
    );

    async function acctId(code) {
      const { rows } = await client.query(
        `SELECT id FROM chart_of_accounts WHERE account_code=$1 AND is_active=true LIMIT 1`, [code]
      );
      return rows[0]?.id ?? null;
    }
    const bankAcctId     = await acctId('1001');
    const accumDepAcctId = await acctId('1110');
    const assetAcctId    = await acctId('1100');
    const gainAcctId     = await acctId('4100');
    const lossAcctId     = await acctId('5800');

    const lines = [];
    if (dispVal  > 0) lines.push({ account_id: bankAcctId,     account_code: '1001', account_name: 'Bank / Cash Account',         debit: dispVal,           credit: 0 });
    if (accumDep > 0) lines.push({ account_id: accumDepAcctId, account_code: '1110', account_name: 'Accumulated Depreciation',      debit: accumDep,          credit: 0 });
    if (gainLoss < 0) lines.push({ account_id: lossAcctId,     account_code: '5800', account_name: 'Loss on Disposal of Asset',     debit: Math.abs(gainLoss), credit: 0 });
    if (cost     > 0) lines.push({ account_id: assetAcctId,    account_code: '1100', account_name: `Fixed Asset — ${asset.name}`,   debit: 0,                 credit: cost });
    if (gainLoss > 0) lines.push({ account_id: gainAcctId,     account_code: '4100', account_name: 'Gain on Disposal of Asset',     debit: 0,                 credit: gainLoss });

    const totalDebit  = lines.reduce((s, l) => s + l.debit,  0);
    const totalCredit = lines.reduce((s, l) => s + l.credit, 0);

    const entryNumber = await nextAccountingJournalNumber(client);
    const { rows: [jeRow] } = await client.query(
      `INSERT INTO journal_entries
         (entry_number, entry_date, description, reference_type, reference_id,
          status, total_debit, total_credit, company_id)
       VALUES ($1,$2,$3,'asset_disposal',$4,'draft',$5,$6,$7) RETURNING *`,
      [entryNumber, effDate, `Asset disposal — ${asset.name} (${asset.asset_code})`,
       asset.id, totalDebit, totalCredit, companyId]
    );

    for (const l of lines) {
      await client.query(
        `INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, narration)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [jeRow.id, l.account_id, l.account_code, l.account_name, l.debit, l.credit,
         `Asset disposal — ${asset.asset_code}`]
      );
    }

    await client.query('COMMIT');

    res.json({
      asset_id:       asset.id,
      asset_code:     asset.asset_code,
      disposal_value: dispVal,
      book_value:     bookVal,
      gain_loss:      gainLoss,
      gain_loss_type: gainLoss > 0 ? 'gain' : gainLoss < 0 ? 'loss' : 'nil',
      journal_entry:  { id: jeRow.id, entry_number: jeRow.entry_number, status: 'draft', lines },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── POST /run-depreciation ── */
router.post('/run-depreciation', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const companyId = cid(req);
    const now = new Date();
    const month = now.getMonth() + 1;
    const fyStart = month >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    const fy = `${fyStart}-${String(fyStart + 1).slice(-2)}`;

    const cidClause = companyId != null ? 'AND company_id=$1' : '';
    const params    = companyId != null ? [companyId] : [];

    const { rows: assets } = await pool.query(
      `SELECT * FROM fixed_assets
       WHERE status='active' AND current_book_value > salvage_value ${cidClause}`,
      params
    );

    let processed = 0;
    let totalDep  = 0;

    for (const asset of assets) {
      const { rows: existing } = await pool.query(
        `SELECT id FROM asset_depreciation_log WHERE asset_id=$1 AND financial_year=$2`,
        [asset.id, fy]
      );
      if (existing.length) continue;

      const schedule = computeSchedule(asset);
      const yearsElapsed = Math.floor(
        (now - new Date(asset.purchase_date)) / (365.25 * 86400000)
      );
      const currentYear = schedule[yearsElapsed];
      if (!currentYear) continue;

      await pool.query(
        `INSERT INTO asset_depreciation_log
           (asset_id, financial_year, opening_value, depreciation_amount, closing_value, method, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [asset.id, fy, currentYear.opening, currentYear.depreciation, currentYear.closing,
         asset.depreciation_method, companyId]
      );
      await pool.query(
        `UPDATE fixed_assets
         SET current_book_value=$1,
             accumulated_depreciation=accumulated_depreciation+$2,
             updated_at=NOW()
         WHERE id=$3`,
        [currentYear.closing, currentYear.depreciation, asset.id]
      );

      const accumAcctMap = {
        'Plant & Machinery': '1110', 'plant_machinery': '1110', 'Machinery': '1110',
        'Furniture & Fixtures': '1111', 'furniture': '1111', 'Furniture': '1111',
        'Computers & IT': '1112', 'computers': '1112', 'IT Equipment': '1112',
        'Vehicles': '1113', 'vehicles': '1113',
        'Land & Building': '1114', 'building': '1114',
      };
      const accumAcct = accumAcctMap[asset.category] || '1110';
      const depClient = await pool.connect();
      try {
        await depClient.query('BEGIN');
        const entryNumber = await journalRepo.getNextEntryNumber();
        const je = await journalRepo.createEntry(depClient, {
          entry_number:   entryNumber,
          entry_date:     `${now.getFullYear()}-03-31`,
          entry_type:     'Depreciation',
          reference_type: 'fixed_asset',
          reference_id:   asset.id,
          description:    `Depreciation — ${asset.name} (FY ${fy})`,
          created_by:     null,
        });
        await journalRepo.createLine(depClient, {
          journal_entry_id: je.id,
          account_code:     '5040',
          description:      `Dep expense — ${asset.name}`,
          debit:            currentYear.depreciation,
          credit:           0,
        });
        await journalRepo.createLine(depClient, {
          journal_entry_id: je.id,
          account_code:     accumAcct,
          description:      `Accum dep — ${asset.name}`,
          debit:            0,
          credit:           currentYear.depreciation,
        });
        await journalRepo.postEntry(depClient, je.id);
        await depClient.query('COMMIT');
      } catch (jeErr) {
        await depClient.query('ROLLBACK');
        console.error(`[assets] Depreciation JE failed for asset ${asset.id}:`, jeErr.message);
      } finally {
        depClient.release();
      }

      processed++;
      totalDep += currentYear.depreciation;
    }

    res.json({
      financial_year:     fy,
      assets_processed:   processed,
      total_depreciation: parseFloat(totalDep.toFixed(2)),
      message: processed > 0
        ? `Depreciation run complete for FY ${fy}`
        : `Depreciation already processed for FY ${fy} or no eligible assets`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /depreciation-log ── */
router.get('/depreciation-log', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { asset_id } = req.query;

    let q = `
      SELECT l.*, a.asset_code, a.name AS asset_name
      FROM asset_depreciation_log l
      JOIN fixed_assets a ON a.id = l.asset_id
      WHERE 1=1
    `;
    const params = [];
    if (companyId != null) { params.push(companyId); q += ` AND a.company_id=$${params.length}`; }
    if (asset_id)          { params.push(asset_id);  q += ` AND l.asset_id=$${params.length}`; }
    q += ' ORDER BY l.asset_id, l.financial_year';

    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
