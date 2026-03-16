import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import './Sidebar.css';

const Sidebar = () => {
  const [openMenu, setOpenMenu] = useState(null);

  const toggleMenu = (menu) => {
    setOpenMenu(openMenu === menu ? null : menu);
  };

  const menuItems = [
    {
      name: 'Procurement',
      icon: '🛒',
      subItems: [
        { name: 'PR Dashboard', path: '/procurement/purchase-requests' },
        { name: 'Purchase Orders', path: '/procurement/purchase-orders' },
        { name: 'Goods Receipt (GRN)', path: '/procurement/grn' },
        { name: 'Local Purchase', path: '/procurement/local-purchase' },
        { name: 'Supplier Performance', path: '/procurement/supplier-performance' },
      ],
    },
    {
      name: 'Inventory',
      icon: '📦',
      subItems: [
        { name: 'Warehouse Dashboard', path: '/inventory/dashboard' },
        { name: 'Item Master', path: '/inventory/items' },
        { name: 'Stock Overview', path: '/inventory/stock-overview' },
        { name: 'Stock Movement', path: '/inventory/stock-movement' },
        { name: 'Stock Transfers', path: '/inventory/stock-transfers' },
        { name: 'Stock Adjustments', path: '/inventory/stock-adjustments' },
        { name: 'RM Issues', path: '/inventory/rm-issues' },
        { name: 'Low Stock Alerts', path: '/inventory/low-stock-alerts' },
      ],
    },
    {
        name: 'Advanced Inventory',
        icon: '🧠',
        subItems: [
            { name: 'Advanced Dashboard', path: '/inventory/advanced' },
            { name: 'Batch Tracking', path: '/inventory/batches' },
            { name: 'Reservations', path: '/inventory/reservations' },
            { name: 'Cycle Counting', path: '/inventory/cycle-counts' },
        ]
    }
  ];

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>Pulse ERP</h2>
      </div>
      <nav className="sidebar-nav">
        <ul>
          {menuItems.map((item) => (
            <li key={item.name}>
              <div className="menu-item" onClick={() => toggleMenu(item.name)}>
                <span className="menu-icon">{item.icon}</span>
                <span className="menu-name">{item.name}</span>
                <span className={`arrow ${openMenu === item.name ? 'open' : ''}`}>▼</span>
              </div>
              {openMenu === item.name && (
                <ul className="submenu">
                  {item.subItems.map((subItem) => (
                    <li key={subItem.name}>
                      <NavLink to={subItem.path} className={({ isActive }) => (isActive ? 'active' : '')}>
                        {subItem.name}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
};

export default Sidebar;