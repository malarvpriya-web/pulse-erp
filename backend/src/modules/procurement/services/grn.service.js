import pool from '../../shared/db.js';
import grnRepo from '../repositories/grn.repository.js';
import poRepo from '../repositories/purchaseOrder.repository.js';
import advancedInventoryRepo from '../../inventory/repositories/advancedInventory.repository.js';
import { logAudit } from '../../../services/AuditService.js';
import { postStock } from '../../production/subcontracting.routes.js';

class GRNService {
  async createGRN(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get PO details to access supplier_id
      const po = await poRepo.findById(data.po_id);

      // quality_settings.require_iqc_before_stock (default true — matches the
      // column's own DB default and quality.routes.js's GET /settings fallback)
      // decides whether accepted stock is usable immediately or held until
      // Quality clears it via the quality_tests flow.
      const { rows: [settings] } = await client.query(
        'SELECT require_iqc_before_stock FROM quality_settings WHERE company_id=$1',
        [data.company_id ?? null]
      );
      const holdForIqc = settings ? settings.require_iqc_before_stock !== false : true;

      const grnNumber = await grnRepo.getNextNumber();
      const grn = await grnRepo.create(client, {
        ...data,
        company_id: data.company_id,
        grn_number: grnNumber
      });

      if (holdForIqc) {
        await client.query(`UPDATE goods_receipt_notes SET quality_status='pending' WHERE id=$1`, [grn.id]);
      }

      for (const item of data.items) {
        const acceptedQty = Math.max(0,
          (item.quantity_received || 0) - (item.quantity_rejected || 0)
        );

        await grnRepo.createItem(client, {
          grn_id: grn.id,
          ...item
        });

        // Update PO item received quantity (only accepted goods count toward fulfillment)
        await poRepo.updateItemReceived(client, item.po_item_id, acceptedQty);

        // Batch created only for accepted (non-rejected) quantity
        if (acceptedQty > 0) {
          const itemIdStr = String(item.item_id);
          await advancedInventoryRepo.createBatch({
            item_id: item.item_id,
            warehouse_id: data.warehouse_id,
            batch_number: item.batch_number || `GRN-${grnNumber}-${itemIdStr.substring(0, 4)}`,
            received_date: data.received_date,
            expiry_date: item.expiry_date || null,
            supplier_id: po?.supplier_id || null,
            grn_id: grn.id,
            quantity_received: acceptedQty,
            rate: item.rate
          });

          // Stock ledger entry — only accepted quantity enters usable stock,
          // and only once Quality has cleared it (see holdForIqc above).
          // Uses the shared postStock() helper (also updates
          // inventory_items.current_stock and fires reorder-breach detection)
          // instead of a separate stock-ledger-write implementation.
          if (!holdForIqc) {
            await postStock(client, {
              itemId: item.item_id,
              warehouseId: data.warehouse_id,
              inQty: acceptedQty,
              outQty: 0,
              txnType: 'purchase',
              refType: 'grn',
              refId: grn.id,
              remarks: `GRN ${grnNumber}` + (item.quantity_rejected > 0 ? ` (${item.quantity_rejected} rejected)` : ''),
              rate: item.rate,
              createdBy: userId,
              companyId: data.company_id,
              transactionDate: data.received_date,
            });
          }
        }
      }

      // Check if PO is fully received — compare accepted totals against ordered qty
      const poItems = await poRepo.getItems(data.po_id);
      const allReceived = poItems.every(item =>
        parseFloat(item.received_quantity) >= parseFloat(item.quantity)
      );

      // Use valid VALID_PO_STATUSES values: 'partial' not 'partially_received'
      if (allReceived) {
        await poRepo.updateStatus(client, data.po_id, 'received');
      } else {
        await poRepo.updateStatus(client, data.po_id, 'partial');
      }

      await client.query('COMMIT');

      // Audit log after commit
      try {
        await logAudit({
          company_id: data.company_id,
          user_id: userId,
          action: 'CREATE',
          entity_type: 'GRN',
          entity_id: grn.id,
          description: `GRN ${grnNumber} created against PO ${po?.po_number || data.po_id}`
        });
      } catch (_) { /* audit failure must not break the transaction */ }

      return await grnRepo.findById(grn.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createRTV(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const rtvNumber = `RTV-${Date.now()}`;
      const { rows: [rtv] } = await client.query(
        `INSERT INTO return_to_vendor (rtv_number, grn_id, vendor_id, company_id, return_date, reason, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [rtvNumber, data.grn_id, data.vendor_id, data.company_id, data.return_date, data.reason, data.notes || null, userId]
      );

      for (const item of data.items) {
        await client.query(
          `INSERT INTO rtv_items (rtv_id, item_id, quantity_returned, rate, remarks)
           VALUES ($1,$2,$3,$4,$5)`,
          [rtv.id, item.item_id, item.quantity_returned, item.rate, item.remarks || null]
        );

        // Deduct returned qty from stock — via the shared postStock() helper
        // (also fires reorder-breach detection, which this RTV path never
        // triggered before since it bypassed the shared helper entirely).
        await postStock(client, {
          itemId: item.item_id,
          warehouseId: data.warehouse_id,
          inQty: 0,
          outQty: item.quantity_returned,
          txnType: 'return',
          refType: 'rtv',
          refId: rtv.id,
          remarks: `RTV ${rtvNumber}`,
          rate: item.rate,
          createdBy: userId,
          companyId: data.company_id,
          transactionDate: data.return_date,
        });
      }

      await client.query('COMMIT');
      return rtv;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Posts a held GRN's accepted quantities to usable stock. Called once IQC
  // clears the GRN (quality_tests' rollup flips goods_receipt_notes.quality_status
  // to 'passed' — see quality.routes.js's rollupQualityStatus()). Idempotent via
  // the stock_ledger's own grn reference rather than a separate "posted" flag,
  // so re-triggering the rollup after the GRN already passed is a safe no-op.
  async releaseGrnStock(grnId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [already] } = await client.query(
        `SELECT 1 FROM stock_ledger WHERE reference_type='grn' AND reference_id=$1 LIMIT 1`,
        [grnId]
      );
      if (already) { await client.query('ROLLBACK'); return; }

      const { rows: [grn] } = await client.query(
        `SELECT id, grn_number, warehouse_id, company_id, received_date FROM goods_receipt_notes WHERE id=$1`,
        [grnId]
      );
      if (!grn) { await client.query('ROLLBACK'); return; }

      const { rows: items } = await client.query(
        `SELECT item_id, quantity_received, quantity_rejected, rate FROM grn_items WHERE grn_id=$1`,
        [grnId]
      );

      for (const item of items) {
        const acceptedQty = Math.max(0, (item.quantity_received || 0) - (item.quantity_rejected || 0));
        if (acceptedQty <= 0) continue;
        await postStock(client, {
          itemId: item.item_id,
          warehouseId: grn.warehouse_id,
          inQty: acceptedQty,
          outQty: 0,
          txnType: 'purchase',
          refType: 'grn',
          refId: grn.id,
          remarks: `GRN ${grn.grn_number} (released after IQC pass)`,
          rate: item.rate,
          createdBy: null, // system-triggered release, not one actor's action
          companyId: grn.company_id,
          transactionDate: grn.received_date,
        });
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getGRNs(filters) {
    return await grnRepo.findAll(filters);
  }

  async getGRNById(id) {
    const grn = await grnRepo.findById(id);
    if (grn) {
      grn.items = await grnRepo.getItems(id);
    }
    return grn;
  }
}

export default new GRNService();
