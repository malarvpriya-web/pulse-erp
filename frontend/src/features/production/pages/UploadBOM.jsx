// frontend/src/features/production/pages/UploadBOM.jsx
import { useState, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const TEMPLATE_HEADERS = 'finished_product,quantity,unit,component_name,component_qty,component_unit,unit_cost,wastage_pct';
const TEMPLATE_EXAMPLE = `HVDC Converter Unit,1,Nos,Thyristor Module,4,Nos,25000,2
HVDC Converter Unit,1,Nos,Transformer Core,1,Nos,180000,1
STATCOM Controller,1,Nos,IGBT Module,6,Nos,15000,1.5
STATCOM Controller,1,Nos,Control PCB,2,Nos,8500,0`;

export default function UploadBOM() {
  const toast   = useToast();
  const fileRef = useRef(null);
  const [csvText,    setCsv]       = useState('');
  const [fileName,   setFileName]  = useState('');
  const [uploading,  setUploading] = useState(false);
  const [result,     setResult]    = useState(null);

  const downloadTemplate = () => {
    const content = TEMPLATE_HEADERS + '\n' + TEMPLATE_EXAMPLE;
    const blob    = new Blob([content], { type: 'text/csv' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href        = url;
    a.download    = 'bom_import_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (ev) => setCsv(ev.target.result || '');
    reader.readAsText(file);
  };

  const handleUpload = async () => {
    if (!csvText.trim()) return toast.error('Please select a CSV file first');
    setUploading(true);
    setResult(null);
    try {
      const res = await api.post('/bom/bom/import-csv', { csv: csvText });
      setResult(res.data);
      if (res.data.created > 0) {
        toast.success(`${res.data.created} BOM${res.data.created > 1 ? 's' : ''} imported successfully`);
      }
      if (res.data.errors?.length) {
        toast.error(`${res.data.errors.length} row${res.data.errors.length > 1 ? 's' : ''} had errors`);
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Import failed');
    } finally {
      setUploading(false);
    }
  };

  const reset = () => {
    setCsv('');
    setFileName('');
    setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div style={{ padding: 24, maxWidth: 820 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#4c1d95' }}>Upload BOM</h2>
        <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Import Bill of Materials from a CSV file. Each row defines one BOM component.</p>
      </div>

      {/* Template Download */}
      <div style={{ background: '#f5f3ff', border: '1px solid #e9e4ff', borderRadius: 12, padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14, marginBottom: 6 }}>CSV Format</div>
        <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#374151', marginBottom: 12, overflowX: 'auto', whiteSpace: 'nowrap' }}>
          {TEMPLATE_HEADERS}
        </div>
        <ul style={{ margin: '0 0 14px', paddingLeft: 20, fontSize: 12, color: '#6b7280', lineHeight: 1.7 }}>
          <li><strong>finished_product</strong> — the product this BOM is for (rows with the same product are grouped)</li>
          <li><strong>quantity</strong>, <strong>unit</strong> — BOM run quantity and unit (e.g. 1, Nos)</li>
          <li><strong>component_name</strong> — the raw material or sub-assembly name</li>
          <li><strong>component_qty</strong>, <strong>component_unit</strong> — quantity and unit of this component per BOM run</li>
          <li><strong>unit_cost</strong> — cost per component unit in ₹ (optional)</li>
          <li><strong>wastage_pct</strong> — % material wastage allowance (optional)</li>
        </ul>
        <button onClick={downloadTemplate}
          style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          ⬇ Download Template CSV
        </button>
      </div>

      {/* Upload Area */}
      <div style={{ background: '#fff', border: '2px dashed #e9e4ff', borderRadius: 12, padding: 32, textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>📤</div>
        <div style={{ fontWeight: 600, color: '#4c1d95', fontSize: 15, marginBottom: 6 }}>
          {fileName || 'Select a CSV file to import'}
        </div>
        {fileName && (
          <div style={{ fontSize: 12, color: '#16a34a', marginBottom: 10, fontWeight: 600 }}>✓ File ready for import</div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFile}
          style={{ display: 'none' }}
          id="bom-file-input"
        />
        <label htmlFor="bom-file-input"
          style={{ display: 'inline-block', padding: '8px 20px', background: '#f0ebff', color: '#6B3FDB', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          Choose File
        </label>
      </div>

      {/* CSV Preview */}
      {csvText && !result && (
        <div style={{ background: '#f9f9ff', border: '1px solid #e9e4ff', borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ fontWeight: 600, color: '#4c1d95', fontSize: 13, marginBottom: 8 }}>
            Preview ({csvText.split('\n').filter(Boolean).length - 1} data rows)
          </div>
          <pre style={{ margin: 0, fontSize: 11, color: '#374151', overflowX: 'auto', maxHeight: 160, whiteSpace: 'pre' }}>
            {csvText.split('\n').slice(0, 6).join('\n')}
            {csvText.split('\n').length > 6 ? '\n…' : ''}
          </pre>
        </div>
      )}

      {/* Action Buttons */}
      {!result && (
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={handleUpload} disabled={uploading || !csvText}
            style={{
              padding: '10px 24px', background: uploading || !csvText ? '#c4b5fd' : '#6B3FDB',
              color: '#fff', border: 'none', borderRadius: 8, cursor: uploading || !csvText ? 'not-allowed' : 'pointer',
              fontSize: 14, fontWeight: 700,
            }}>
            {uploading ? 'Importing…' : '▶ Import BOMs'}
          </button>
          {csvText && (
            <button onClick={reset} style={{ padding: '10px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
              Clear
            </button>
          )}
        </div>
      )}

      {/* Result */}
      {result && (
        <div style={{ marginTop: 10 }}>
          {/* Summary */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ padding: '12px 20px', background: '#d1fae5', borderRadius: 10, textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#16a34a' }}>{result.created}</div>
              <div style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>BOMs Created</div>
            </div>
            {result.errors?.length > 0 && (
              <div style={{ padding: '12px 20px', background: '#fee2e2', borderRadius: 10, textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#dc2626' }}>{result.errors.length}</div>
                <div style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>Errors</div>
              </div>
            )}
          </div>

          {/* Created BOMs */}
          {result.details?.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #d1fae5', borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
              <div style={{ padding: '10px 16px', background: '#ecfdf5', fontWeight: 700, color: '#166534', fontSize: 13 }}>
                Created BOMs
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Product', 'BOM ID', 'Components'].map(h => (
                      <th key={h} style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.details.map((d, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #f0fdf4' }}>
                      <td style={{ padding: '8px 14px', fontWeight: 600, color: '#1f2937' }}>{d.product}</td>
                      <td style={{ padding: '8px 14px', color: '#6B3FDB', fontFamily: 'monospace' }}>{d.bom_id}</td>
                      <td style={{ padding: '8px 14px', color: '#374151' }}>{d.components} items</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Errors */}
          {result.errors?.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #fecaca', borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
              <div style={{ padding: '10px 16px', background: '#fee2e2', fontWeight: 700, color: '#991b1b', fontSize: 13 }}>
                Import Errors
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Product', 'Error'].map(h => (
                      <th key={h} style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.errors.map((e, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #fee2e2' }}>
                      <td style={{ padding: '8px 14px', fontWeight: 600, color: '#1f2937' }}>{e.product}</td>
                      <td style={{ padding: '8px 14px', color: '#dc2626' }}>{e.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button onClick={reset} style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Import Another File
          </button>
        </div>
      )}
    </div>
  );
}
