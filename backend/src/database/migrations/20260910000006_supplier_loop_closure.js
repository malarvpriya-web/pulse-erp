/**
 * Close the supplier loop: one NCR/CAPA system of record, and a promised
 * delivery date that says whether anyone actually promised it.
 *
 * -- PROBLEM 1: TWO NCR/CAPA TABLE FAMILIES, AND THE RATING READ THE DEAD ONE --
 *
 * Incoming QC raises an NCR automatically (quality_settings.iqc_auto_ncr_on_fail
 * defaults TRUE) and writes it to ncr_reports + capa_actions. That is the pair
 * the Quality module, Vendor 360, the CEO dashboards and the supply-chain risk
 * panels all read.
 *
 * vendorHealth.service.js -- the engine behind the supplier scorecard, the
 * supplier rating, and therefore the vendor ranking that RFx scoring and
 * sourcing strategy both join to -- read vendor_ncr + vendor_capa instead.
 * Those are Phase 49c vendor-portal tables written by four endpoints in
 * vendor-approval.routes.js that NO SCREEN CALLS. Verified against the running
 * frontend: zero references to /vendor-approval/ncr or /vendor-approval/capa.
 *
 * So the supplier-quality half of every supplier rating had no write path at
 * all. A failed incoming inspection could not reach it even in principle, and
 * the only rows in those tables were seed debris.
 *
 * Worse, the automatic path could not attribute itself to a supplier: the three
 * auto-NCR inserts in quality.routes.js never set vendor_id. Live before this
 * change: 8 rows in ncr_reports, 0 with vendor_id, 0 with grn_id. Vendor 360's
 * NCR panel filters WHERE vendor_id = $1, and its "top vendors by NCR" query
 * JOINs ON nr.vendor_id = v.id -- both returned nothing for every vendor, in
 * every company, permanently.
 *
 * ncr_reports wins as the survivor because it is the one the product actually
 * writes to and reads from. This migration gives it the three columns
 * vendor_ncr had that it lacked, gives capa_actions the five that vendor_capa
 * had, backfills supplier attribution from the receipt, and moves the existing
 * rows across. Nothing is dropped -- the old tables are left in place, simply no
 * longer read. A DROP can follow once this has run in anger.
 *
 * -- PROBLEM 2: STATUS VOCABULARIES NOBODY WRITES --
 *
 * Every seeded row in vendor_ncr, vendor_capa AND capa_actions carries status
 * 'active'. No route in this codebase writes that value. The canonical
 * vocabularies, taken from the code that WRITES them (never from the rows in
 * them -- see project_supplier_performance_index):
 *
 *   ncr_reports.status    open | under-review | resolved | closed
 *   ncr_reports.severity  minor | major | critical            (lower case)
 *   capa_actions.status   open | in_progress | completed | verified
 *
 * The consequence was not cosmetic. scoreQuality() penalises CAPA closure below
 * 60 percent by a flat 10 points, and closure was counted as status = 'Closed'
 * against rows that all said 'active' -- so every supplier with a CAPA took the
 * penalty on a technicality, forever. Normalised here.
 *
 * -- PROBLEM 3: ON-TIME DELIVERY MEASURED AGAINST A DATE NOBODY PROMISED --
 *
 * purchase_orders.expected_delivery_date is accepted by the manual PO form and
 * set by NEITHER of the two paths that actually raise orders in this product --
 * convert-requisition-to-PO and award-RFQ. Live before this change: 0 of 2
 * purchase orders carried one.
 *
 * vendorHealth falls back to order_date + vendors.lead_time_days, which is
 * master data a buyer typed, not a commitment a supplier made. The score then
 * reports itself as measured. A generous lead time silently flatters OTD, and
 * nothing anywhere said which of the two a given number came from.
 *
 * expected_delivery_basis records the provenance, using the same vocabulary
 * tcoEngine already uses for lead_time_basis:
 *
 *   quoted     the supplier quoted these delivery days on the winning bid
 *   agreed     a buyer entered the date on the order
 *   lead_time  derived from vendors.lead_time_days -- an assumption, not a promise
 *
 * Only 'quoted' and 'agreed' are a promise. The delivery score keeps its
 * formula; what changes is that it now publishes what it measured against.
 */

export async function up(knex) {
  // -- 1. ncr_reports: the columns vendor_ncr had and this table did not ------
  // Verified absent against information_schema before writing this, because
  // ADD COLUMN IF NOT EXISTS is a silent no-op when the column already exists
  // with a different type (project_pg_silent_schema_change_traps).
  await knex.raw(`ALTER TABLE ncr_reports ADD COLUMN IF NOT EXISTS po_id INTEGER`);
  await knex.raw(`ALTER TABLE ncr_reports ADD COLUMN IF NOT EXISTS defect_type VARCHAR(80)`);
  await knex.raw(`ALTER TABLE ncr_reports ADD COLUMN IF NOT EXISTS quantity_rejected NUMERIC`);
  await knex.raw(`ALTER TABLE ncr_reports DROP CONSTRAINT IF EXISTS ncr_reports_po_id_fkey`);
  await knex.raw(`
    ALTER TABLE ncr_reports
      ADD CONSTRAINT ncr_reports_po_id_fkey
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL
  `);

  // The supplier scorecard reads this table by vendor over a rolling window.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ncr_reports_vendor    ON ncr_reports(vendor_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ncr_reports_vendor_dt ON ncr_reports(vendor_id, created_at)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ncr_reports_grn       ON ncr_reports(grn_id)`);

  // -- 2. capa_actions: the columns vendor_capa had and this table did not ----
  // vendor_id is not redundant with ncr_id: vendor_capa.ncr_id is nullable, so
  // a supplier CAPA can exist without an NCR behind it (an audit finding, a
  // development action). Deriving the vendor through the NCR alone would lose
  // exactly those.
  await knex.raw(`ALTER TABLE capa_actions ADD COLUMN IF NOT EXISTS capa_number         VARCHAR(40)`);
  await knex.raw(`ALTER TABLE capa_actions ADD COLUMN IF NOT EXISTS vendor_id           INTEGER`);
  await knex.raw(`ALTER TABLE capa_actions ADD COLUMN IF NOT EXISTS root_cause          TEXT`);
  await knex.raw(`ALTER TABLE capa_actions ADD COLUMN IF NOT EXISTS action_plan         TEXT`);
  await knex.raw(`ALTER TABLE capa_actions ADD COLUMN IF NOT EXISTS verification_method TEXT`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_capa_actions_vendor ON capa_actions(vendor_id)`);

  // -- 3. purchase_orders: provenance for the promised date -------------------
  await knex.raw(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_delivery_basis VARCHAR(16)`);
  // A date that is already on an order was put there by a buyer on the manual
  // form -- the only path that has ever set one. That is 'agreed'.
  await knex.raw(`
    UPDATE purchase_orders
       SET expected_delivery_basis = 'agreed'
     WHERE expected_delivery_date IS NOT NULL
       AND expected_delivery_basis IS NULL
  `);

  // -- 4. Attribute existing NCRs to the supplier that shipped the goods ------
  // The receipt knows the order and the order knows the supplier. This is a
  // join the schema already enforces, not a guess. Rows with no grn_id cannot
  // be attributed and are left alone rather than assigned to anyone.
  await knex.raw(`
    UPDATE ncr_reports n
       SET vendor_id = po.supplier_id,
           po_id     = COALESCE(n.po_id, po.id)
      FROM goods_receipt_notes g
      JOIN purchase_orders po ON po.id = g.po_id
     WHERE g.id = n.grn_id
       AND n.vendor_id IS NULL
       AND po.supplier_id IS NOT NULL
  `);

  // -- 5. Normalise the statuses nothing writes ------------------------------
  await knex.raw(`UPDATE ncr_reports  SET status = 'open' WHERE LOWER(status) = 'active'`);
  await knex.raw(`UPDATE capa_actions SET status = 'open' WHERE LOWER(status) = 'active'`);
  await knex.raw(`UPDATE ncr_reports  SET severity = LOWER(severity) WHERE severity <> LOWER(severity)`);

  // -- 6. Move vendor_ncr across ---------------------------------------------
  // Idempotent on ncr_number: re-running inserts nothing. A vendor_ncr row
  // whose number already exists in ncr_reports is assumed to be the same
  // incident and is skipped rather than duplicated -- double-counting an NCR
  // costs a supplier 5 to 15 points of quality score.
  await knex.raw(`
    INSERT INTO ncr_reports
      (title, description, ncr_number, detected_at, created_at, reference_type, reference_id,
       grn_id, po_id, vendor_id, defect_type, quantity_rejected,
       severity, status, root_cause, disposition, source, company_id)
    SELECT
      COALESCE(NULLIF(vn.defect_type, ''), 'Supplier non-conformance'),
      vn.description,
      vn.ncr_number,
      vn.created_at,
      vn.created_at,
      -- ⚠ EVERY grn_id AND po_id ON THESE ROWS IS DANGLING. The seeded set points
      -- at GRNs 1-5 and POs 1-5; the live receipts are 6,7,8,15 and the live orders
      -- are 12,13. ncr_reports.po_id carries a real FK, so carrying the values over
      -- verbatim aborts the whole migration (23503, verified). A reference that
      -- resolves is kept; one that does not becomes NULL. The row still migrates —
      -- an NCR against a supplier is worth keeping even when the receipt it named
      -- never existed, and dropping it would quietly rewrite that supplier's score.
      CASE WHEN EXISTS (SELECT 1 FROM goods_receipt_notes g WHERE g.id = vn.grn_id)
           THEN 'grn' ELSE NULL END,
      (SELECT g.id FROM goods_receipt_notes g WHERE g.id = vn.grn_id),
      (SELECT g.id FROM goods_receipt_notes g WHERE g.id = vn.grn_id),
      (SELECT p.id FROM purchase_orders p WHERE p.id = vn.po_id),
      vn.vendor_id,
      vn.defect_type,
      vn.quantity_rejected,
      LOWER(COALESCE(vn.severity, 'minor')),
      CASE LOWER(COALESCE(vn.status, 'open'))
        WHEN 'closed'       THEN 'closed'
        WHEN 'resolved'     THEN 'resolved'
        WHEN 'under-review' THEN 'under-review'
        ELSE 'open'
      END,
      vn.root_cause,
      vn.disposition,
      'procurement',
      vn.company_id
      FROM vendor_ncr vn
     WHERE NOT EXISTS (
       SELECT 1 FROM ncr_reports n WHERE n.ncr_number = vn.ncr_number
     )
  `);

  // -- 7. Move vendor_capa across, re-pointing ncr_id at the migrated NCR -----
  // The link is carried over by ncr_number, the only identifier the two
  // families share. A CAPA whose NCR did not migrate keeps vendor_id and loses
  // only the link, which is recoverable; it is not dropped.
  await knex.raw(`
    INSERT INTO capa_actions
      (capa_number, ncr_id, vendor_id, action_type, description, root_cause, action_plan,
       verification_method, due_date, status, effectiveness_rating, verified_at,
       created_at, company_id)
    SELECT
      vc.capa_number,
      n.id,
      vc.vendor_id,
      LOWER(COALESCE(vc.capa_type, 'corrective')),
      vc.description,
      vc.root_cause,
      vc.action_plan,
      vc.verification_method,
      vc.due_date,
      CASE LOWER(COALESCE(vc.status, 'open'))
        WHEN 'closed'    THEN 'completed'
        WHEN 'verified'  THEN 'verified'
        WHEN 'completed' THEN 'completed'
        ELSE 'open'
      END,
      vc.effectiveness_rating,
      vc.closed_at,
      vc.created_at,
      vc.company_id
      FROM vendor_capa vc
      LEFT JOIN vendor_ncr  vn ON vn.id = vc.ncr_id
      LEFT JOIN ncr_reports n  ON n.ncr_number = vn.ncr_number
     WHERE vc.capa_number IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM capa_actions ca WHERE ca.capa_number = vc.capa_number
       )
  `);

  // -- 8. Attribute migrated CAPAs that came in through the NCR --------------
  await knex.raw(`
    UPDATE capa_actions ca
       SET vendor_id = n.vendor_id
      FROM ncr_reports n
     WHERE n.id = ca.ncr_id
       AND ca.vendor_id IS NULL
       AND n.vendor_id IS NOT NULL
  `);
}

/**
 * Down leaves the migrated rows where they are. Deleting them would destroy
 * NCRs raised against ncr_reports since this ran, which are indistinguishable
 * from the migrated ones by then -- the added columns are dropped, the data is
 * not. vendor_ncr and vendor_capa still hold their originals either way.
 */
export async function down(knex) {
  await knex.raw(`ALTER TABLE purchase_orders DROP COLUMN IF EXISTS expected_delivery_basis`);
  await knex.raw(`ALTER TABLE capa_actions    DROP COLUMN IF EXISTS verification_method`);
  await knex.raw(`ALTER TABLE capa_actions    DROP COLUMN IF EXISTS action_plan`);
  await knex.raw(`ALTER TABLE capa_actions    DROP COLUMN IF EXISTS root_cause`);
  await knex.raw(`ALTER TABLE capa_actions    DROP COLUMN IF EXISTS vendor_id`);
  await knex.raw(`ALTER TABLE capa_actions    DROP COLUMN IF EXISTS capa_number`);
  await knex.raw(`ALTER TABLE ncr_reports     DROP CONSTRAINT IF EXISTS ncr_reports_po_id_fkey`);
  await knex.raw(`ALTER TABLE ncr_reports     DROP COLUMN IF EXISTS quantity_rejected`);
  await knex.raw(`ALTER TABLE ncr_reports     DROP COLUMN IF EXISTS defect_type`);
  await knex.raw(`ALTER TABLE ncr_reports     DROP COLUMN IF EXISTS po_id`);
}
