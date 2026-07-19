import React from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Shared wrapper for all Settings registry pages.
 * Enforces the standard white page-header (BUG 7 fix) and consistent
 * layout across Status Setup, Document Setup, Product Master,
 * Notification Rules, etc.
 */
export default function SettingsRegistryPage({
  icon: Icon,
  title,
  subtitle,
  primaryButtonLabel,
  onPrimaryClick,
  onRefresh,
  filterPlaceholder = 'Filter...',
  onFilterChange,
  children,
}) {
  return (
    <div className="settings-registry-page" style={{ padding: 24 }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {Icon && (
            <div style={{ background: '#f3f4f6', borderRadius: 8, padding: 8 }}>
              <Icon size={18} color="var(--color-text-primary, #111827)" />
            </div>
          )}
          <div>
            <h1 className="page-title" style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary, #111827)' }}>
              {title}
            </h1>
            {subtitle && (
              <p className="page-subtitle" style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary, #6b7280)' }}>
                {subtitle}
              </p>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {onFilterChange && (
            <input
              type="text"
              placeholder={filterPlaceholder}
              onChange={e => onFilterChange(e.target.value)}
              style={{
                padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8,
                fontSize: 13, outline: 'none', minWidth: 180,
              }}
            />
          )}
          {onRefresh && (
            <button
              onClick={onRefresh}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', background: '#f9fafb', border: '1px solid #e5e7eb',
                borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#374151',
              }}
            >
              <RefreshCw size={14} /> Refresh
            </button>
          )}
          {primaryButtonLabel && (
            <button
              onClick={onPrimaryClick}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 16px', background: '#7c3aed', color: '#fff',
                border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}
            >
              + {primaryButtonLabel}
            </button>
          )}
        </div>
      </div>

      <div className="page-content">
        {children}
      </div>
    </div>
  );
}
