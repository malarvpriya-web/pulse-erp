import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHero, PageShell } from '@/components/pulse-ui';
import '../recruitment-ui.css';

/**
 * Shared tab-page shell for grouped Recruitment pages.
 *
 * Extracted from Candidates.jsx, which had this chrome inline — so every
 * grouped page (Candidates, Jobs, Interviews) now renders an identical header
 * band and tab strip instead of each re-implementing it slightly differently.
 *
 * Keeps the `?tab=` URL param behaviour, so a tab is linkable and survives a
 * refresh.
 *
 * @param {string} eyebrow  small uppercase label above the title
 * @param {Function} icon    lucide icon for the hero chip
 * @param {string} title    page title
 * @param {string} subtitle one-line description
 * @param {Array}  tabs     [{ id, label, icon, render: () => node }]
 */
export default function TabPage({ eyebrow = 'Recruitment', icon, title, subtitle, tabs, actions }) {
  const ids = tabs.map(t => t.id);
  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');
  const [active, setActive] = useState(ids.includes(urlTab) ? urlTab : ids[0]);
  // Follow ?tab= when it changes without a remount — a link from one tab to
  // another on the same page (Requisitions → "Post job opening" / "View job")
  // only changes the URL, and the page stayed on the old tab.
  useEffect(() => {
    if (urlTab && ids.includes(urlTab) && urlTab !== active) setActive(urlTab);
  }, [urlTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (id) => {
    setActive(id);
    setSp({ tab: id }, { replace: true });
  };

  const current = tabs.find(t => t.id === active) || tabs[0];

  return (
    <PageShell dock={
      <>
        <PageHero
          icon={icon}
          eyebrow={eyebrow}
          title={title}
          subtitle={subtitle}
          actions={actions}
        />
        {/* Tab strip sits on its own white bar under the hero rather than on
            the gradient. It stays inside the dock, so switching tabs never
            scrolls the controls out of reach. */}
        <div className="tp-tabs" role="tablist">
          {tabs.map(({ id, label, icon: Icon, count }) => {
            const on = active === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={on}
                onClick={() => go(id)}
                className={`tp-tab${on ? ' is-on' : ''}`}
              >
                {Icon && <Icon size={14} />}{label}
                {count != null && <span className="tp-tab-count">{count}</span>}
              </button>
            );
          })}
        </div>
      </>
    }>
      {/* `go` is passed through so a tab can hand off to a sibling tab (e.g.
          All Candidates → Pipeline) instead of navigating to another route. */}
      <div>{current?.render({ go, active })}</div>
    </PageShell>
  );
}
