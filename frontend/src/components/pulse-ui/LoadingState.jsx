import './pulse-ui.css';

/**
 * LoadingState — shimmer skeleton matching the shape of the content it's
 * standing in for.
 *
 * @param {object} props
 * @param {'table'|'cards'|'form'|'lines'} [props.shape='lines']
 * @param {number} [props.rows=5] used by 'table'/'lines'
 * @param {number} [props.count=4] used by 'cards' (mirrors KPICardGrid's loading count)
 */
export default function LoadingState({ shape = 'lines', rows = 5, count = 4 }) {
  if (shape === 'table') {
    return (
      <div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="pl-skel-table-row">
            <span className="pl-skel" style={{ flex: 2 }} />
            <span className="pl-skel" />
            <span className="pl-skel" />
            <span className="pl-skel" style={{ flex: 0.6 }} />
          </div>
        ))}
      </div>
    );
  }

  if (shape === 'cards') {
    return (
      <div className="pl-skel-cards">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="pl-skel pl-skel-card" />
        ))}
      </div>
    );
  }

  if (shape === 'form') {
    return (
      <div className="pl-skel-lines">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="pl-skel pl-skel-line" style={{ width: i % 2 ? '70%' : '100%' }} />
        ))}
      </div>
    );
  }

  // 'lines'
  return (
    <div className="pl-skel-lines">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="pl-skel pl-skel-line" style={{ width: `${100 - i * 8}%` }} />
      ))}
    </div>
  );
}
