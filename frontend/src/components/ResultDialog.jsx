/**
 * ResultDialog — reusable centered success / error / info dialog
 *
 * Usage:
 *   import ResultDialog from '@/components/ResultDialog';
 *
 *   const [dlg, setDlg] = useState(null);
 *
 *   // show success
 *   setDlg({ type: 'success', title: 'Saved!', message: 'Employee added successfully.' });
 *   // show error
 *   setDlg({ type: 'error', title: 'Failed', message: err.message });
 *   // auto-close
 *   setDlg({ type: 'success', title: 'Done', message: '…', autoClose: 2000 });
 *
 *   <ResultDialog dialog={dlg} onClose={() => setDlg(null)} />
 */

import { useEffect } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import './ResultDialog.css';

const TYPE_CFG = {
  success : { Icon: CheckCircle,   color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', iconBg: '#dcfce7' },
  error   : { Icon: XCircle,       color: '#dc2626', bg: '#fef2f2', border: '#fecaca', iconBg: '#fee2e2' },
  warning : { Icon: AlertTriangle, color: '#d97706', bg: '#fffbeb', border: '#fde68a', iconBg: '#fef3c7' },
  info    : { Icon: Info,          color: '#0369a1', bg: '#eff6ff', border: '#bfdbfe', iconBg: '#dbeafe' },
};

export default function ResultDialog({ dialog, onClose }) {
  const { type = 'info', title, message, autoClose } = dialog || {};
  const cfg = TYPE_CFG[type] || TYPE_CFG.info;
  const { Icon } = cfg;

  // auto-close
  useEffect(() => {
    if (!dialog || !autoClose) return;
    const t = setTimeout(onClose, autoClose);
    return () => clearTimeout(t);
  }, [dialog, autoClose, onClose]);

  if (!dialog) return null;

  return (
    <div className="rdlg-backdrop" onClick={onClose}>
      <div
        className={`rdlg-box result-dialog result-dialog-${type}`}
        style={{ background: cfg.bg, border: `1.5px solid ${cfg.border}` }}
        role={type === 'error' || type === 'warning' ? 'alert' : undefined}
        onClick={e => e.stopPropagation()}
      >
        {/* close button */}
        <button className="rdlg-close" onClick={onClose}><X size={14}/></button>

        {/* icon */}
        <div className="rdlg-icon" style={{ background: cfg.iconBg, color: cfg.color }}>
          <Icon size={28} strokeWidth={2}/>
        </div>

        {/* text */}
        <div className="rdlg-body">
          {title && <h3 className="rdlg-title" style={{ color: cfg.color }}>{title}</h3>}
          {message && <p className="rdlg-message">{message}</p>}
        </div>

        {/* action */}
        <button
          className="rdlg-ok"
          style={{ background: cfg.color }}
          onClick={onClose}
        >
          OK
        </button>
      </div>
    </div>
  );
}
