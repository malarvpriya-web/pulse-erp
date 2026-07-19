import pool from '../../shared/db.js';
import grnRepo from '../repositories/grn.repository.js';
import poRepo from '../repositories/purchaseOrder.repository.js';
import stockLedgerRepo from '../../inventory/repositories/stockLedger.repository.js';
import advancedInventoryRepo from '../../inventory/repositories/advancedInventory.repository.js';
import { logAudit } from '../../../services/AuditService.js';

class GRNService {
  async createGRN(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get PO details to access supplier_id
      const po = await poRepo.findById(data.po_id);

      const grnNumber = await grnRepo.getNextNumber();
      const grn = await grnRepo.create(client, {
        ...data,
        company_id: data.company_id,
        grn_number: grnNumber
      });

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

          // Stock ledger entry — only accepted quantity enters usable stock
          await stockLedgerRepo.createEntry(client, {
            item_id: item.item_id,
            warehouse_id: data.warehouse_id,
            transaction_type: 'purchase',
            quantity_in: acceptedQty,
            quantity_out: 0,
            rate: item.rate,
            reference_type: 'grn',
            reference_id: grn.id,
            transaction_date: data.received_date,
            remarks: `GRN ${grnNumber}` + (item.quantity_rejected > 0 ? ` (${item.quantity_rejected} rejected)` : ''),
            created_by: userId
          });
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

        // Deduct returned qty from stock
        await stockLedgerRepo.createEntry(client, {
          item_id: item.item_id,
          warehouse_id: data.warehouse_id,
          transaction_type: 'return',
          quantity_in: 0,
          quantity_out: item.quantity_returned,
          rate: item.rate,
          reference_type: 'rtv',
          reference_id: rtv.id,
          transaction_date: data.return_date,
          remarks: `RTV ${rtvNumber}`,
          created_by: userId
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
