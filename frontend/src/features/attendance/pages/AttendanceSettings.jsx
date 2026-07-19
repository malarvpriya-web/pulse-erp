import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings, Shield, Clock, MapPin, Cpu, Camera } from 'lucide-react';

import GeneralSettings from './settings/GeneralSettings';
import PolicyEngine from './AttendancePolicies';
import ShiftManagement from './ShiftManagement';
import GeoFencing from './GeoFencing';
import DeviceManagement from './DeviceManagement';
import FaceAttendance from './FaceAttendance';

const VALID_TABS = ['general', 'policies', 'shifts', 'geo-fencing', 'devices', 'face'];

const TABS = [
  { id: 'general',    label: 'General',     icon: Settings },
  { id: 'policies',   label: 'Policies',    icon: Shield },
  { id: 'shifts',     label: 'Shifts',      icon: Clock },
  { id: 'geo-fencing', label: 'Geo Fencing', icon: MapPin },
  { id: 'devices',    label: 'Devices',     icon: Cpu },
  { id: 'face',       label: 'Face',        icon: Camera },
];

export default function AttendanceSettings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(
    VALID_TABS.includes(urlTab) ? urlTab : 'general'
  );

  useEffect(() => {
    if (VALID_TABS.includes(urlTab) && urlTab !== activeTab) {
      setActiveTab(urlTab);
    }
  }, [urlTab]);

  const handleTabChange = (tabId) => {
    setActiveTab(tabId);
    setSearchParams({ tab: tabId }, { replace: true });
  };

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Attendance Settings</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Configure policies, shifts, geo-fencing, devices, and face attendance</p>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #f0f0f4', marginBottom: 24 }}>
        {TABS.map(tab => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              style={{
                padding: '8px 16px',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                borderBottom: active ? '2px solid #6B3FDB' : '2px solid transparent',
                color: active ? '#6B3FDB' : '#6b7280',
                fontWeight: active ? 600 : 400,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                transition: 'color 0.15s',
              }}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'general'     && <GeneralSettings />}
        {activeTab === 'policies'    && <PolicyEngine />}
        {activeTab === 'shifts'      && <ShiftManagement />}
        {activeTab === 'geo-fencing' && <GeoFencing />}
        {activeTab === 'devices'     && <DeviceManagement />}
        {activeTab === 'face'        && <FaceAttendance />}
      </div>
    </div>
  );
}
