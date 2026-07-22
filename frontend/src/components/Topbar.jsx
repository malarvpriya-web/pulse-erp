import { useAuth } from "@/context/AuthContext";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell, Search, ChevronLeft, X, LogOut, CheckCheck, RefreshCw,
  AlertTriangle, Clock, Info, UserCheck, Settings, Zap,
  Users, Package, Layers, Briefcase, FolderOpen, Database,
} from "lucide-react";
import api from "@/services/api/client";
import "./Topbar.css";
import logo from "../assets/logo.png";
import { NAV_ITEMS } from "@/config/routes";
import { canRoleOpenPage } from "@/config/menuCatalog";

// Build search list from NAV_ITEMS
const SEARCH_PAGES = [
  ...NAV_ITEMS.flatMap(item => {
    if (item.page)    return [{ label: item.name, page: item.page, group: '' }];
    if (item.submenu) return item.submenu.map(sub => ({ label: sub.name, page: sub.page, group: item.name }));
    return [];
  }),
  // Pages not in nav menu but still navigable
  { label: 'Add Employee',           page: 'AddEmployee',          group: 'Employees' },
  { label: 'Employee Profile',       page: 'EmployeeProfile',      group: 'Employees' },
  { label: 'Leave Approvals',        page: 'LeaveApprovals',       group: 'Leaves' },
  { label: 'Leave Reports',          page: 'LeaveReports',         group: 'Leaves' },
  { label: 'Comp Off',               page: 'CompOff',              group: 'Leaves' },
  { label: 'Leave Encashment',       page: 'LeaveEncashment',      group: 'Leaves' },
  { label: 'Profile Settings',        page: 'ProfileSettings',      group: '' },
  { label: 'Notifications',          page: 'Notifications',        group: '' },
  { label: 'Inventory Report',       page: 'InventoryReport',      group: 'Inventory' },
  { label: 'Delivery Note',          page: 'DeliveryNote',         group: 'Service Desk' },
  { label: 'Review Customers',       page: 'ReviewCustomers',      group: 'Service Desk' },
  { label: 'Review Feedback',        page: 'ReviewFeedback',       group: 'Service Desk' },
  { label: 'Review Sites',           page: 'ReviewSites',          group: 'Service Desk' },
  { label: 'Service Master',         page: 'ServiceMasterIPS',     group: 'Service Desk' },
  { label: 'Service Catalog',        page: 'ServiceMaster',        group: 'Service Desk' },
  { label: 'Travel Entry',           page: 'TravelEntry',          group: 'Travel Desk' },
  { label: 'Expense Review',         page: 'ExpenseReview',        group: 'Travel Desk' },
  { label: 'Job Requisition Pipeline',page:'JobRequisitionPipeline',group: 'Recruitment' },
  { label: 'Candidate Detail',       page: 'CandidateDetail',      group: 'Recruitment' },
  { label: 'Org Setup',              page: 'OrganizationSetup',    group: '' },
  { label: 'Setup Wizard',           page: 'SetupWizard',          group: 'Admin' },
  { label: 'Document Signing',       page: 'DocumentSigning',      group: '' },
  { label: 'Order Policy',           page: 'OrderPolicy',          group: 'Admin' },
  { label: 'Asset Maintenance',      page: 'AssetMaintenance',     group: 'Admin' },
  { label: 'Setup Notifications',    page: 'SetupNotifications',   group: 'Admin' },
  { label: 'Master Setup',           page: 'MasterSetup',          group: 'Admin' },
  { label: 'System Health',          page: 'SystemHealth',         group: 'Admin' },
];

// ── Notification type config ──────────────────────────────────────────────────
const NOTIF_CFG = {
  probation_warning : { icon: Clock,         color: '#d97706', bg: '#fffbeb', label: 'Probation'  },
  probation_due     : { icon: AlertTriangle,  color: '#dc2626', bg: '#fef2f2', label: 'Probation'  },
  approval          : { icon: UserCheck,      color: '#7c3aed', bg: '#f5f3ff', label: 'Approval'   },
  info              : { icon: Info,           color: '#0369a1', bg: '#eff6ff', label: 'Info'       },
  default           : { icon: Bell,           color: '#6b7280', bg: '#f9fafb', label: 'System'     },
};
function notifCfg(type = '') {
  return NOTIF_CFG[type] || NOTIF_CFG.default;
}

const timeAgo = ts => {
  if (!ts) return '';
  const d = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (d < 1)    return 'just now';
  if (d < 60)   return `${d}m ago`;
  if (d < 1440) return `${Math.floor(d / 60)}h ago`;
  return `${Math.floor(d / 1440)}d ago`;
};

export default function Topbar({ goBack, currentPage }) {
  const { user, role, menuAccess, logout } = useAuth();
  const navigateTo = useNavigate();

  // Pages the signed-in role could never open — hidden from the inline
  // search so it doesn't advertise admin/other-role machinery (Setup Wizard,
  // Master Setup, System Health, Leave Approvals, …) by name to a role that
  // will only hit "Unauthorized" clicking through. Mirrors the same check
  // GlobalSearch.jsx runs for the command-palette search.
  const searchablePages = useMemo(
    () => SEARCH_PAGES.filter(p => canRoleOpenPage(role, p.page, { menuAccess })),
    [role, menuAccess]
  );

  // notifications state
  const [notifs,       setNotifs]       = useState([]);
  const [unreadCount,  setUnreadCount]  = useState(0);
  const [loadingNotif, setLoadingNotif] = useState(false);
  const [showBell,     setShowBell]     = useState(false);

  // search state
  const [search,         setSearch]         = useState('');
  const [results,        setResults]        = useState([]);
  const [entityGroups,   setEntityGroups]   = useState([]);
  const [searchingAPI,   setSearchingAPI]   = useState(false);
  const [showSearch,     setShowSearch]     = useState(false);
  const searchTimerRef = useRef(null);

  // user menu
  const [showUser, setShowUser] = useState(false);

  const bellRef   = useRef(null);
  const searchRef = useRef(null);
  const userRef   = useRef(null);

  // ── Fetch notifications ────────────────────────────────────────────────────
  const fetchNotifs = useCallback(async (showLoad = false) => {
    if (showLoad) setLoadingNotif(true);
    try {
      const [nRes, cRes] = await Promise.all([
        api.get('/notifications', { params: { limit: 20 } }),
        api.get('/notifications/unread-count'),
      ]);
      setNotifs(Array.isArray(nRes.data) ? nRes.data : []);
      setUnreadCount(cRes.data?.count ?? 0);
    } catch {
      // fail silently — don't spam console
    } finally {
      setLoadingNotif(false);
    }
  }, []);

  // Initial load + poll every 30s
  useEffect(() => {
    fetchNotifs(true);
    const interval = setInterval(fetchNotifs, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifs]);

  // ── Mark as read ───────────────────────────────────────────────────────────
  const markRead = async (id) => {
    try {
      await api.put(`/notifications/${id}/read`);
      setNotifs(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch { /* ignore */ }
  };

  const markAllRead = async () => {
    try {
      await api.put('/notifications/mark-all-read');
      setNotifs(prev => prev.map(n => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch { /* ignore */ }
  };

  const deleteNotif = async (e, id) => {
    e.stopPropagation();
    try {
      await api.delete(`/notifications/${id}`);
      setNotifs(prev => {
        const target = prev.find(n => n.id === id);
        if (target && !target.is_read) setUnreadCount(c => Math.max(0, c - 1));
        return prev.filter(n => n.id !== id);
      });
    } catch { /* ignore */ }
  };

  // ── Search — local pages (instant) + API entities (debounced 300ms) ─────────
  useEffect(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      setResults([]); setEntityGroups([]); setShowSearch(false);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      return;
    }
    // Instant page results
    setResults(
      searchablePages.filter(p =>
        p.label.toLowerCase().includes(q) || p.group.toLowerCase().includes(q)
      ).slice(0, 6)
    );
    setShowSearch(true);

    // Debounced entity search
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (q.length >= 2) {
      setSearchingAPI(true);
      searchTimerRef.current = setTimeout(async () => {
        try {
          const res = await api.get('/global-search', { params: { q, limit: 4 } });
          setEntityGroups(res.data?.groups || []);
        } catch {
          setEntityGroups([]);
        } finally {
          setSearchingAPI(false);
        }
      }, 300);
    }

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search, searchablePages]);

  // ── Close dropdowns on outside click ──────────────────────────────────────
  useEffect(() => {
    const handler = e => {
      if (bellRef.current   && !bellRef.current.contains(e.target))   setShowBell(false);
      if (searchRef.current && !searchRef.current.contains(e.target)) setShowSearch(false);
      if (userRef.current   && !userRef.current.contains(e.target))   setShowUser(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const navigate = pg => {
    navigateTo(pg === 'Home' ? '/' : `/${pg}`);
    setShowBell(false); setSearch(''); setShowSearch(false); setShowUser(false);
  };

  const displayName = user?.name || user?.username || user?.email?.split('@')[0] || 'User';
  const initials    = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="tb-root">

      {/* Left — back */}
      <div className="tb-left">
        {currentPage && currentPage !== 'Home' && (
          <button className="tb-back-btn" onClick={goBack}>
            <ChevronLeft size={15} /> Back
          </button>
        )}
      </div>

      {/* Center — logo + brand */}
      <div className="tb-center">
        <div className="tb-logo-wrap"><img src={logo} className="tb-logo" alt="Logo" /></div>
        <span className="tb-brand">Manifest Technologies</span>
      </div>

      {/* Right */}
      <div className="tb-right">

        {/* Search */}
        <div className="tb-search-wrap" ref={searchRef}>
          <div className="tb-search">
            <Search size={14} color="#9ca3af" />
            <input
              placeholder="Search pages, employees, orders…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onFocus={() => search && setShowSearch(true)}
            />
            {search && (
              <button className="tb-search-clear" onClick={() => { setSearch(''); setShowSearch(false); }}>
                <X size={12} />
              </button>
            )}
          </div>
          {showSearch && (
            <div className="tb-search-drop">
              {/* Page results */}
              {results.length > 0 && (
                <>
                  <div className="tb-search-section-label">Pages</div>
                  {results.map(r => (
                    <button key={r.page} className="tb-search-item" onClick={() => navigate(r.page)}>
                      <Search size={12} color="#9ca3af" />
                      <span className="tb-search-label">{r.label}</span>
                      {r.group && <span className="tb-search-group">{r.group}</span>}
                    </button>
                  ))}
                </>
              )}

              {/* Entity results from API */}
              {searchingAPI && (
                <div className="tb-search-api-loading">
                  <Database size={11} color="#9ca3af" />
                  <span>Searching records…</span>
                </div>
              )}
              {!searchingAPI && entityGroups.map(group => (
                <div key={group.type}>
                  <div className="tb-search-section-label">{group.label}</div>
                  {group.items.map((item, idx) => (
                    <button key={idx} className="tb-search-item tb-search-item--entity"
                      onClick={() => navigate(group.page)}>
                      <Database size={11} color="#7c3aed" />
                      <span className="tb-search-label">{item.label}</span>
                      {item.meta && <span className="tb-search-group">{item.meta}</span>}
                    </button>
                  ))}
                </div>
              ))}

              {results.length === 0 && entityGroups.length === 0 && !searchingAPI && (
                <div className="tb-search-empty">No results found for "{search}"</div>
              )}
            </div>
          )}
        </div>

        {/* Bell — notifications */}
        <div className="tb-bell-wrap" ref={bellRef}>
          <button
            className="tb-bell-trigger"
            onClick={() => {
              const opening = !showBell;
              setShowBell(opening);
              if (opening) fetchNotifs(true);
            }}
            title="Notifications"
          >
            <Bell size={18} strokeWidth={1.8} />
            {unreadCount > 0 && (
              <span className="tb-badge">{Math.min(unreadCount, 99)}</span>
            )}
          </button>

          {showBell && (
            <div className="tb-bell-drop">
              {/* Header */}
              <div className="tb-bell-hd">
                <div className="tb-bell-hd-left">
                  <span className="tb-bell-title">Notifications</span>
                  {unreadCount > 0 && (
                    <span className="tb-bell-count">{unreadCount} new</span>
                  )}
                </div>
                <div className="tb-bell-hd-right">
                  {unreadCount > 0 && (
                    <button className="tb-bell-mark-all" onClick={markAllRead} title="Mark all as read">
                      <CheckCheck size={13} /> All read
                    </button>
                  )}
                  <button className="tb-bell-refresh" onClick={() => fetchNotifs(true)} title="Refresh">
                    <RefreshCw size={13} />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="tb-bell-body">
                {loadingNotif ? (
                  <div className="tb-bell-skeleton">
                    {[1,2,3].map(i => <div key={i} className="tb-bell-skel-row" />)}
                  </div>
                ) : notifs.length === 0 ? (
                  <div className="tb-bell-empty">
                    <div className="tb-bell-empty-icon"><CheckCheck size={28} /></div>
                    <p>You're all caught up!</p>
                    <span>No notifications right now</span>
                  </div>
                ) : (
                  notifs.map(n => {
                    const cfg  = notifCfg(n.notification_type);
                    const Icon = cfg.icon;
                    return (
                      <div
                        key={n.id}
                        className={`tb-notif-row${n.is_read ? '' : ' tb-notif-unread'}`}
                        onClick={() => { if (!n.is_read) markRead(n.id); }}
                      >
                        <div className="tb-notif-icon" style={{ background: cfg.bg, color: cfg.color }}>
                          <Icon size={14} />
                        </div>
                        <div className="tb-notif-body">
                          <div className="tb-notif-title">{n.title}</div>
                          {n.message && (
                            <div className="tb-notif-msg">{n.message}</div>
                          )}
                          <div className="tb-notif-meta">
                            <span className="tb-notif-type" style={{ color: cfg.color }}>{cfg.label}</span>
                            <span className="tb-notif-time">{timeAgo(n.created_at)}</span>
                          </div>
                        </div>
                        <button
                          className="tb-notif-del"
                          onClick={e => deleteNotif(e, n.id)}
                          title="Dismiss"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <button className="tb-bell-footer" onClick={() => navigate('NotificationCenter')}>
                View all notifications →
              </button>
            </div>
          )}
        </div>

        {/* User avatar */}
        <div className="tb-user-wrap" ref={userRef}>
          <button className="tb-avatar" onClick={() => setShowUser(v => !v)} title={displayName}>
            {initials}
          </button>
          {showUser && (
            <div className="tb-user-drop">
              <div className="tb-user-info">
                <div className="tb-user-avatar-lg">{initials}</div>
                <div>
                  <div className="tb-user-name">{displayName}</div>
                  <div className="tb-user-email">{user?.email || ''}</div>
                  {user?.role && (
                    <div className="tb-user-role">
                      {user.role.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
                    </div>
                  )}
                </div>
              </div>
              <div className="tb-user-divider" />
              <button className="tb-drop-item" onClick={() => navigate('ProfileSettings')}>
                <Settings size={14} /> Profile settings
              </button>
              {(role === 'super_admin' || role === 'admin') && (
                <button className="tb-drop-item" onClick={() => navigate('SettingsCenter')}>
                  <Settings size={14} /> System Settings
                </button>
              )}
              {role === 'super_admin' && (
                <button className="tb-drop-item" onClick={() => navigate('SetupWizard')}>
                  <Zap size={14} /> Setup Wizard
                </button>
              )}
              <div className="tb-user-divider" />
              <button className="tb-drop-item tb-drop-logout" onClick={logout}>
                <LogOut size={14} /> Sign out
              </button>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
