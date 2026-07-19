import React from 'react';
import { ArrowUpRight } from 'lucide-react';

const PRIORITY_COLORS = {
  leave:     '#10b981',
  expense:   '#f59e0b',
  purchase:  '#3b82f6',
  timesheet: '#8b5cf6',
};

const ApprovalsQueueWidget = ({ title = 'Pending Approvals', data, onViewAll }) => {
  if (!data || !data.items || data.items.length === 0) {
    return (
      <>
        <h3 className="widget-title">{title}</h3>
        <div className="widget-empty" style={{ padding:'16px 0', color:'#9ca3af', fontSize:13, textAlign:'center' }}>
          ✅ No pending approvals
        </div>
      </>
    );
  }

  const { items, total } = data;
  const hasMore = total > items.length;

  return (
    <>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <h3 className="widget-title" style={{ margin:0 }}>
          {title}
          <span style={{
            marginLeft:6, fontSize:11, fontWeight:700, padding:'2px 7px',
            borderRadius:12, background:'#fef3c7', color:'#d97706',
          }}>{total || items.length}</span>
        </h3>
        <button
          onClick={onViewAll}
          style={{
            background:'none', border:'none', cursor:'pointer',
            color:'#6B3FDB', fontSize:11, fontWeight:600,
            display:'flex', alignItems:'center', gap:3, padding:0,
          }}
        >
          View All <ArrowUpRight size={11}/>
        </button>
      </div>

      <div className="widget-scroll">
        {items.map((item, index) => {
          const typeKey = (item.type || '').toLowerCase();
          const color   = PRIORITY_COLORS[typeKey] || '#9ca3af';
          return (
            <div key={index} className="activity-item" style={{ gap:8 }}>
              <span style={{
                width:8, height:8, borderRadius:2, background:color, flexShrink:0, marginTop:3,
              }}/>
              <div style={{ minWidth:0, flex:1 }}>
                <div style={{ fontWeight:600, color:'#1f2937', fontSize:12 }}>{item.type}</div>
                <div style={{ fontSize:11, color:'#6b7280' }}>{item.requester}</div>
              </div>
              <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:2 }}>
                <span style={{
                  fontSize:10, fontWeight:600, padding:'2px 7px',
                  background:`${color}18`, color, borderRadius:4,
                }}>Pending</span>
                <div className="activity-time" style={{ fontSize:10 }}>{item.date}</div>
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <button
          onClick={onViewAll}
          style={{
            width:'100%', marginTop:8, padding:'7px', borderRadius:8,
            border:'1px solid #e9e4ff', background:'#f5f3ff',
            color:'#6B3FDB', fontSize:12, fontWeight:600, cursor:'pointer',
          }}
        >
          +{total - items.length} more approvals → View All
        </button>
      )}
    </>
  );
};

export default ApprovalsQueueWidget;
