import { ArrowRight } from 'lucide-react';

const P = '#7c3aed';
const PL = '#f5f3ff';
const PB = '#e9e4ff';

export default function SmartEmptyState({
  icon: Icon,
  title,
  description,
  actions = [],
  hint,
  size = 'md',
}) {
  const pad = size === 'sm' ? 32 : size === 'lg' ? 80 : 56;
  const iconSz = size === 'sm' ? 32 : size === 'lg' ? 56 : 44;
  const titleSz = size === 'sm' ? 15 : size === 'lg' ? 22 : 18;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: `${pad}px 24px`,
      textAlign: 'center', gap: 12,
    }}>
      {Icon && (
        <div style={{
          width: iconSz + 20, height: iconSz + 20, borderRadius: '50%',
          background: PL, border: `2px solid ${PB}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 4,
        }}>
          <Icon size={iconSz} color={P} strokeWidth={1.5} />
        </div>
      )}

      <div style={{ fontSize: titleSz, fontWeight: 700, color: '#1f2937' }}>{title}</div>

      {description && (
        <div style={{
          fontSize: 13, color: '#6b7280', maxWidth: 420, lineHeight: 1.6,
        }}>{description}</div>
      )}

      {hint && (
        <div style={{
          fontSize: 12, color: '#9ca3af', background: '#f9fafb',
          border: '1px solid #f0f0f4', borderRadius: 8, padding: '8px 16px',
          marginTop: 4,
        }}>{hint}</div>
      )}

      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={action.onClick}
              style={action.primary !== false
                ? {
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '9px 20px', borderRadius: 8, border: 'none',
                    background: P, color: '#fff', fontSize: 13, fontWeight: 600,
                    cursor: 'pointer',
                  }
                : {
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '8px 18px', borderRadius: 8,
                    border: `1px solid ${PB}`, background: PL,
                    color: P, fontSize: 13, fontWeight: 500, cursor: 'pointer',
                  }
              }
            >
              {action.icon && <action.icon size={14} />}
              {action.label}
              {action.primary !== false && <ArrowRight size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
