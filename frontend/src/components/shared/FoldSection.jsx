import { useState } from 'react';

/**
 * A heading with an arrow that shows or hides what is under it. The content stays mounted while
 * hidden, so anything typed into a closed section is still there when it is opened again.
 */
export default function FoldSection({ title, open, onToggle, right = null, level = 3, children, style, ...rest }) {
  const H = `h${level}`;
  return (
    <section style={style} {...rest}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <H style={{ margin: 0, fontSize: level === 3 ? 15 : 14, flex: 1, minWidth: 0 }}>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit', fontWeight: 600, color: 'inherit', textAlign: 'left' }}
          >
            <span aria-hidden="true" style={{ display: 'inline-block', width: 12, transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none', color: 'var(--color-primary, #6B3FDB)' }}>▶</span>
            {title}
          </button>
        </H>
        {right}
      </div>
      <div hidden={!open} style={{ marginTop: 8 }}>{children}</div>
    </section>
  );
}

/** Which sections are open, plus open-all / close-all. */
export function useFolds() {
  const [openKeys, setOpenKeys] = useState(() => new Set());
  return {
    isOpen: (k) => openKeys.has(k),
    toggle: (k) => setOpenKeys((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
    setAll: (keys) => setOpenKeys(new Set(keys)),
    anyOpen: openKeys.size > 0,
  };
}

export function FoldAllButton({ folds, keys }) {
  return (
    <button type="button" className="pulse-btn-secondary" onClick={() => folds.setAll(folds.anyOpen ? [] : keys)} style={{ fontSize: 12, padding: '4px 10px' }}>
      {folds.anyOpen ? 'Close all' : 'Open all'}
    </button>
  );
}
