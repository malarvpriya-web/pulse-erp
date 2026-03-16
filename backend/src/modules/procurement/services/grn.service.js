import pool from '../../shared/db.js';
import grnRepo from '../repositories/grn.repository.js';
import poRepo from '../repositories/purchaseOrder.repository.js';
import stockLedgerRepo from '../../inventory/repositories/stockLedger.repository.js';
import advancedInventoryRepo from '../../inventory/repositories/advancedInventory.repository.js';

class GRNService {
  async createGRN(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get PO details to access supplier_id
      const po = await poRepo.findById(data.po_id, client);

      const grnNumber = await grnRepo.getNextNumber();
      const grn = await grnRepo.create(client, {
        ...data,
        grn_number: grnNumber
      });

      for (const item of data.items) {
        await grnRepo.createItem(client, {
          grn_id: grn.id,
          ...item
        });

        // Update PO item received quantity
        await poRepo.updateItemReceived(client, item.po_item_id, item.quantity_received);

        // Create a batch for the received item, enabling traceability
        // Assumes batch_number and expiry_date are provided in the item object from the frontend
        await advancedInventoryRepo.createBatch({
          item_id: item.item_id,
          warehouse_id: data.warehouse_id,
          batch_number: item.batch_number || `GRN-${grnNumber}-${item.item_id.substring(0, 4)}`, // Auto-generate if not provided
          received_date: data.received_date,
          expiry_date: item.expiry_date || null,
          supplier_id: po.supplier_id,
          grn_id: grn.id,
          quantity_received: item.quantity_received,
          rate: item.rate
        });

        // Create a stock ledger entry for financial tracking / audit trail
        await stockLedgerRepo.createEntry(client, { // This can be kept for auditing
          item_id: item.item_id,
          warehouse_id: data.warehouse_id,
          transaction_type: 'purchase',
          quantity_in: item.quantity_received,
          quantity_out: 0,
          rate: item.rate,
          reference_type: 'grn',
          reference_id: grn.id,
          transaction_date: data.received_date,
          remarks: `GRN ${grnNumber}`,
          created_by: userId
        });
      }

      // Check if PO is fully received
      const poItems = await poRepo.getItems(data.po_id, client);
      const allReceived = poItems.every(item => 
        parseFloat(item.received_quantity) >= parseFloat(item.quantity)
      );

      if (allReceived) {
        await poRepo.updateStatus(client, data.po_id, 'completed');
      } else {
        await poRepo.updateStatus(client, data.po_id, 'partially_received');
      }

      await client.query('COMMIT');
      return await grnRepo.findById(grn.id);
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
