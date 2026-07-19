import React, { useState, useEffect } from 'react';
import { Box } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ModuleSettingsPanel from '@/components/core/ModuleSettingsPanel';

function buildSections(warehouseOptions) {
  return [
    {
      title: 'General',
      description: 'Item numbering and default warehouse configuration',
      fields: [
        {
          key: 'item_number_prefix',
          label: 'Item Code Prefix',
          type: 'text',
          default: 'RM',
          placeholder: 'RM',
          helpText: 'Prefix applied to auto-generated item codes (e.g. RM-001, FG-001)',
        },
        {
          key: 'default_warehouse',
          label: 'Default Warehouse',
          type: 'select',
          options: warehouseOptions.length
            ? warehouseOptions
            : [{ value: '', label: 'No warehouses configured' }],
          default: '',
        },
      ],
    },
    {
      title: 'Stock Rules',
      description: 'Controls for stock movement and reservation behavior',
      fields: [
        {
          key: 'negative_stock_allowed',
          label: 'Allow Negative Stock',
          type: 'toggle',
          default: false,
          helpText: 'Allow issues even when on-hand quantity would go below zero',
        },
        {
          key: 'reservation_mode',
          label: 'Reservation Mode',
          type: 'select',
          options: ['Manual', 'Auto on Production Order', 'Auto on Sales Order'],
          default: 'Manual',
          helpText: 'When stock should be automatically reserved for orders',
        },
        {
          key: 'consumption_method',
          label: 'Consumption Method',
          type: 'select',
          options: ['FIFO', 'FEFO', 'LIFO', 'Manual'],
          default: 'FIFO',
          helpText: 'Order in which batches are consumed during material issue',
        },
      ],
    },
    {
      title: 'Valuation',
      description: 'Method used to calculate inventory cost on issue',
      fields: [
        {
          key: 'valuation_method',
          label: 'Inventory Valuation Method',
          type: 'select',
          options: ['Weighted Average', 'FIFO', 'Standard Cost'],
          default: 'Weighted Average',
          helpText: 'Affects cost of goods sold calculation on each issue',
        },
      ],
    },
    {
      title: 'Batch & Serial',
      description: 'Automatic numbering for batches and serial numbers',
      fields: [
        {
          key: 'auto_batch_numbering',
          label: 'Auto Batch Numbering',
          type: 'toggle',
          default: false,
          helpText: 'Automatically generate batch numbers on GRN (format: BATCH-YYYYMM-NNNN)',
        },
        {
          key: 'batch_number_prefix',
          label: 'Batch Number Prefix',
          type: 'text',
          default: 'BATCH',
          placeholder: 'BATCH',
        },
        {
          key: 'auto_serial_numbering',
          label: 'Auto Serial Numbering',
          type: 'toggle',
          default: false,
          helpText: 'Automatically generate serial numbers on production order completion',
        },
        {
          key: 'serial_number_prefix',
          label: 'Serial Number Prefix',
          type: 'text',
          default: 'SN',
          placeholder: 'SN',
        },
      ],
    },
    {
      title: 'Warehouse & Bin',
      description: 'Warehouse management and transfer approval rules',
      fields: [
        {
          key: 'bin_management_enabled',
          label: 'Enable Bin Management',
          type: 'toggle',
          default: false,
          helpText: 'Track inventory at the bin / shelf level within warehouses',
        },
        {
          key: 'transfer_approval_required',
          label: 'Require Approval for Warehouse Transfers',
          type: 'toggle',
          default: false,
          helpText: 'Inter-warehouse transfers must be approved before stock moves',
        },
      ],
    },
    {
      title: 'Reorder & MRP',
      description: 'Thresholds and automation for stock replenishment',
      fields: [
        {
          key: 'default_reorder_days',
          label: 'Default Reorder Point (days of stock)',
          type: 'number',
          default: 7,
          placeholder: '7',
          helpText: 'Trigger a reorder when remaining stock covers fewer than N days of demand',
        },
        {
          key: 'auto_generate_pr',
          label: 'Auto-Generate Purchase Request on Reorder',
          type: 'toggle',
          default: false,
          helpText: 'Automatically create a draft PR when stock hits the reorder point',
        },
      ],
    },
    {
      title: 'Quality',
      description: 'Incoming inspection and stock hold rules',
      fields: [
        {
          key: 'incoming_inspection_required',
          label: 'Require Incoming Inspection',
          type: 'toggle',
          default: false,
          helpText: 'All GRN items go to inspection hold before moving to available stock',
        },
        {
          key: 'quality_hold_enabled',
          label: 'Enable Quality Stock Hold',
          type: 'toggle',
          default: true,
          helpText: 'Allow store managers to place batches on quality hold',
        },
      ],
    },
    {
      title: 'Alerts',
      description: 'Thresholds for stock-level notifications',
      fields: [
        {
          key: 'low_stock_threshold_pct',
          label: 'Low Stock Alert Threshold (%)',
          type: 'number',
          default: 20,
          placeholder: '20',
          helpText: 'Alert when stock falls below this percentage of the reorder quantity',
        },
        {
          key: 'critical_stock_threshold_pct',
          label: 'Critical Stock Threshold (%)',
          type: 'number',
          default: 5,
          placeholder: '5',
          helpText: 'Critical alert — stock nearly depleted',
        },
        {
          key: 'slow_mover_days',
          label: 'Slow Mover Threshold (days)',
          type: 'number',
          default: 90,
          placeholder: '90',
          helpText: 'Items with no movement for this many days are flagged as slow movers',
        },
        {
          key: 'abc_a_threshold',
          label: 'ABC — A Class Cutoff (%)',
          type: 'number',
          default: 70,
          placeholder: '70',
          helpText: 'Items whose cumulative value % is below this are A class',
        },
        {
          key: 'abc_b_threshold',
          label: 'ABC — B Class Cutoff (%)',
          type: 'number',
          default: 90,
          placeholder: '90',
          helpText: 'Items whose cumulative value % is below this (above A) are B class',
        },
      ],
    },
  ];
}

export default function InventorySettings({ setPage }) {
  const [warehouseOptions, setWarehouseOptions] = useState([]);
  const toast = useToast();

  useEffect(() => {
    api.get('/inventory/warehouses')
      .then(res => {
        const list = Array.isArray(res.data) ? res.data : (res.data?.warehouses ?? []);
        setWarehouseOptions(
          list.map(w => ({ value: String(w.id), label: w.warehouse_name || w.name }))
        );
      })
      .catch(() => {
        setWarehouseOptions([]);
        toast.error('Could not load warehouses');
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ModuleSettingsPanel
      moduleName="Inventory"
      moduleIcon={Box}
      apiEndpoint="/settings/inventory"
      setPage={setPage}
      sections={buildSections(warehouseOptions)}
    />
  );
}
