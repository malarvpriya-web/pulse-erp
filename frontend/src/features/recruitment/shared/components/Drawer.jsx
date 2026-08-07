// Right-side slide-in drawer shell (backdrop + panel). Extracted from
// RecruitmentAgencies.jsx and InterviewScheduler.jsx, which each hand-rolled
// this exact backdrop/panel wrapper independently. Only the outer chrome is
// shared — header markup, close button, and body content stay with each
// caller (`children`) since those differ enough (icon vs no icon, search bar
// vs none, header-pinned-while-body-scrolls vs whole-panel-scrolls) that
// forcing them into one template would change behavior, not just remove
// duplication. `width`/`boxShadow`/`overflowY` default to
// RecruitmentAgencies.jsx's original values; InterviewScheduler.jsx passes
// its own to keep its exact prior look.
export default function Drawer({
  width = 440,
  boxShadow = '-4px 0 20px rgba(0,0,0,.15)',
  overflowY,
  children,
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ background: '#fff', width, height: '100%', overflowY, display: 'flex', flexDirection: 'column', boxShadow }}>
        {children}
      </div>
    </div>
  );
}
