import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import './pulse-ui.css';

/**
 * SectionHeader — the clickable title row used inside a FormSection. Usable
 * standalone (e.g. atop a non-form content block that just wants the same
 * collapsible-row chrome).
 *
 * @param {object} props
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {boolean} [props.open] omit for a static (non-collapsible) header
 * @param {Function} [props.onToggle]
 */
export function SectionHeader({ title, description, open, onToggle }) {
  const collapsible = typeof onToggle === 'function';
  return (
    <button
      type="button"
      className={`pl-section-header${collapsible ? '' : ' pl-static'}`}
      onClick={collapsible ? onToggle : undefined}
      disabled={!collapsible}
      aria-expanded={collapsible ? open : undefined}
    >
      <span className="pl-section-title-wrap">
        <span>
          <span className="pl-section-title">{title}</span>
          {description && <div className="pl-section-description">{description}</div>}
        </span>
      </span>
      {collapsible && (
        <ChevronDown size={16} className={`pl-section-chevron${open ? ' pl-open' : ''}`} aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * FormSection — one collapsible section of a FormCard.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {string} [props.description]
 * @param {boolean} [props.collapsible=true]
 * @param {boolean} [props.defaultOpen=true]
 * @param {React.ReactNode} props.children
 */
export function FormSection({ title, description, collapsible = true, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = collapsible ? open : true;
  return (
    <div className="pl-form-section">
      <SectionHeader
        title={title}
        description={description}
        open={isOpen}
        onToggle={collapsible ? () => setOpen((v) => !v) : undefined}
      />
      {isOpen && <div className="pl-section-body">{children}</div>}
    </div>
  );
}

/**
 * FormCard — white card shell composed of one or more `<FormSection>`s.
 * Targets the ~95%-duplicated AddEmployee.jsx/EditEmployee.jsx pattern —
 * a shared section-accordion shell reduces real duplication, not just
 * visual inconsistency.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children one or more <FormSection>
 * @param {string} [props.title]
 * @param {React.ReactNode} [props.footer] Save/Cancel bar — caller renders
 *   its own `.pulse-btn-primary`/`.pulse-btn-secondary` buttons
 * @param {boolean} [props.stickyFooter=false]
 */
export default function FormCard({ children, title, footer, stickyFooter = false }) {
  return (
    <div className="pl-card">
      {title && (
        <div className="pl-card-header">
          <h3 className="pl-card-title">{title}</h3>
        </div>
      )}
      {children}
      {footer && (
        <div className={`pl-form-footer${stickyFooter ? ' pl-sticky' : ''}`}>{footer}</div>
      )}
    </div>
  );
}
