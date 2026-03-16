import { useReducer, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './Sidebar.css';
import { useAuth } from '@/context/AuthContext';
import { NAV_ITEMS } from '@/config/routes';

function sidebarReducer(state, action) {
  switch (action.type) {
    case 'EXPAND':
      return { ...state, expanded: true };
    case 'COLLAPSE':
      return { expanded: false, openMenu: null };
    case 'OPEN_MENU':
      return { expanded: true, openMenu: action.name };
    default:
      return state;
  }
}

export default function Sidebar({ setPage }) {
  const [state, dispatch] = useReducer(sidebarReducer, { expanded: false, openMenu: null });
  const [panelVisible, setPanelVisible] = useState(false);
  const [panelTop, setPanelTop] = useState(0);
  const panelRef = useRef(null);
  const menuRefs = useRef({});

  const { role: userRole, hasPermission } = useAuth();

  const visibleItems = NAV_ITEMS.filter(item => {
    if (userRole === 'super_admin' || userRole === 'admin') return true;
    if (item.name === 'Home') return true;

    // Group-level permission gate
    if (item.module && !hasPermission(item.module, 'view')) return false;

    if (userRole === 'manager' || userRole === 'department_head') {
      const allowed = ['Home', 'Dashboard', 'Approvals', 'Employees', 'Attendance',
                       'Leaves', 'Recruitment', 'Performance', 'Projects', 'Reports', 'Settings'];
      return allowed.includes(item.name);
    }

    if (userRole === 'employee') {
      const allowed = ['Home', 'Attendance', 'Leaves', 'Travel Desk', 'Service Desk', 'HR', 'Timesheets'];
      return allowed.includes(item.name);
    }

    return true;
  });

  useEffect(() => {
    if (state.openMenu) {
      setPanelVisible(true);
      const el = menuRefs.current[state.openMenu];
      if (el) setPanelTop(el.getBoundingClientRect().top);
    } else {
      const t = setTimeout(() => setPanelVisible(false), 250);
      return () => clearTimeout(t);
    }
  }, [state.openMenu]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        dispatch({ type: 'COLLAPSE' });
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSidebarLeave = (e) => {
    if (e.relatedTarget instanceof Node && panelRef.current?.contains(e.relatedTarget)) return;
    dispatch({ type: 'COLLAPSE' });
  };

  const handlePanelLeave = (e) => {
    const sidebarEl = document.querySelector('.sidebar');
    if (sidebarEl?.contains(e.relatedTarget)) return;
    dispatch({ type: 'COLLAPSE' });
  };

  const sideWidth = state.expanded ? 220 : 70;

  const activeSubmenu = visibleItems.find(m => m.name === state.openMenu);

  const submenuPanel = panelVisible && (
    <div
      ref={panelRef}
      className={`submenu-panel ${state.openMenu ? 'panel--visible' : ''}`}
      style={{ left: `${sideWidth}px`, top: `${panelTop}px` }}
      onMouseLeave={handlePanelLeave}
    >
      {activeSubmenu?.submenu?.map(sub => (
        <button
          key={sub.name}
          className="nav-item"
          onClick={() => { setPage(sub.page); dispatch({ type: 'COLLAPSE' }); }}
        >
          {sub.name}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div
        className={`sidebar ${state.expanded ? 'expanded' : ''}`}
        onMouseEnter={() => dispatch({ type: 'EXPAND' })}
        onMouseLeave={handleSidebarLeave}
      >
        <ul>
          {visibleItems.map(item => (
            <li
              key={item.name}
              ref={el => { if (el) menuRefs.current[item.name] = el; }}
              onMouseEnter={() => { if (item.submenu) dispatch({ type: 'OPEN_MENU', name: item.name }); }}
            >
              <button
                className="nav-item"
                onClick={() => {
                  if (item.page) { setPage(item.page); dispatch({ type: 'COLLAPSE' }); }
                }}
              >
                <span className="icon">{item.icon}</span>
                {state.expanded && <span className="label">{item.name}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {createPortal(submenuPanel, document.body)}
    </>
  );
}
