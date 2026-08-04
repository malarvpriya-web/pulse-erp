import { Inbox } from 'lucide-react';
import './pulse-ui.css';

/**
 * EmptyState — thin wrapper over `.pulse-empty`'s existing layout with an
 * icon badge, title/subtitle, optional action and hint.
 *
 * @param {object} props
 * @param {React.ComponentType} [props.icon=Inbox] lucide icon
 * @param {string} [props.title='No data found']
 * @param {string} [props.subtitle]
 * @param {React.ReactNode} [props.action] e.g. a `.pulse-btn-primary` button
 * @param {string} [props.hint]
 * @param {boolean} [props.compact=false]
 */
export default function EmptyState({
  icon: Icon = Inbox, title = 'No data found', subtitle, action, hint, compact = false,
}) {
  return (
    <div className={`pl-empty${compact ? ' pl-compact' : ''}`}>
      <div className="pl-empty-icon">
        <Icon size={compact ? 18 : 24} aria-hidden="true" />
      </div>
      <p className="pl-empty-title">{title}</p>
      {subtitle && <p className="pl-empty-subtitle">{subtitle}</p>}
      {action}
      {hint && <div className="pl-empty-hint">{hint}</div>}
    </div>
  );
}
