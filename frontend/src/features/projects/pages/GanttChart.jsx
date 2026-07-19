import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { FolderKanban } from 'lucide-react';
import api from '@/services/api/client';

function EmptyState({ icon: Icon, title, sub, action }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 24px', textAlign: 'center', gap: 8,
      background: 'var(--color-background-secondary)',
      borderRadius: 'var(--border-radius-lg)',
      border: '0.5px solid var(--color-border-tertiary)',
    }}>
      {Icon && <Icon size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }} />}
      <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{title}</p>
      {sub && <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>{sub}</p>}
      {action}
    </div>
  );
}

const ASSIGNEE_COLORS = ['#6B3FDB','#2563eb','#16a34a','#dc2626','#d97706','#0891b2','#db2777','#65a30d','#6B3FDB','#9333ea'];
function assigneeColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return ASSIGNEE_COLORS[Math.abs(h) % ASSIGNEE_COLORS.length];
}
function initials(name) {
  const parts = name.trim().split(' ');
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function formatDate(date) {
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function diffDays(a, b) {
  return Math.round((b - a) / 86400000);
}
function statusColor(status) {
  if (status === 'on_track') return '#22c55e';
  if (status === 'at_risk') return '#f59e0b';
  if (status === 'delayed') return '#ef4444';
  return '#94a3b8';
}
function darkenColor(hex, amount = 40) {
  const n = parseInt(hex.replace('#',''), 16);
  const r = Math.max(0, (n >> 16) - amount);
  const g = Math.max(0, ((n >> 8) & 0xff) - amount);
  const b = Math.max(0, (n & 0xff) - amount);
  return `rgb(${r},${g},${b})`;
}

// Critical path: find longest duration path using DFS
function computeCriticalPath(tasks) {
  const taskMap = {};
  tasks.forEach(t => { taskMap[t.id] = t; });
  const deps = {};
  tasks.forEach(t => { deps[t.id] = Array.isArray(t.dependencies) ? t.dependencies : []; });
  // reverse map: successors
  const successors = {};
  tasks.forEach(t => { successors[t.id] = []; });
  tasks.forEach(t => {
    deps[t.id].forEach(depId => {
      if (successors[depId]) successors[depId].push(t.id);
    });
  });
  // compute earliest finish for each task
  const memo = {};
  function longestPathFrom(id) {
    if (memo[id] !== undefined) return memo[id];
    const task = taskMap[id];
    if (!task) return { len: 0, path: [] };
    const dur = diffDays(parseDate(task.start_date), parseDate(task.end_date)) + 1;
    if (successors[id].length === 0) {
      memo[id] = { len: dur, path: [id] };
      return memo[id];
    }
    let best = { len: 0, path: [] };
    successors[id].forEach(sid => {
      const sub = longestPathFrom(sid);
      if (sub.len > best.len) best = sub;
    });
    memo[id] = { len: dur + best.len, path: [id, ...best.path] };
    return memo[id];
  }
  let overall = { len: 0, path: [] };
  tasks.forEach(t => {
    if (deps[t.id].length === 0) {
      const r = longestPathFrom(t.id);
      if (r.len > overall.len) overall = r;
    }
  });
  return new Set(overall.path);
}

const ROW_H = 52;
const BAR_H = 28;
const HEADER_H = 56;
const RESOURCE_W = 240;

export default function GanttChart() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddTask, setShowAddTask] = useState(false);
  const [zoomLevel, setZoomLevel] = useState('week');
  const [pxPerDayOverride, setPxPerDayOverride] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [dragging, setDragging] = useState(null); // { taskId, startX, origEnd }
  const scrollRef = useRef(null);
  const svgRef = useRef(null);

  useEffect(() => {
    api.get('/gantt/tasks')
      .then(res => setTasks(Array.isArray(res.data) ? res.data : []))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, []);

  const pxPerDay = useMemo(() => {
    if (pxPerDayOverride !== null) return pxPerDayOverride;
    if (zoomLevel === 'day') return 40;
    if (zoomLevel === 'week') return 20;
    return 8;
  }, [zoomLevel, pxPerDayOverride]);

  const { minDate, maxDate } = useMemo(() => {
    if (!tasks.length) return { minDate: new Date(), maxDate: new Date() };
    const dates = tasks.flatMap(t => [parseDate(t.start_date), parseDate(t.end_date)]);
    const min = new Date(Math.min(...dates));
    const max = new Date(Math.max(...dates));
    return { minDate: addDays(min, -14), maxDate: addDays(max, 14) };
  }, [tasks]);

  const totalDays = useMemo(() => diffDays(minDate, maxDate) + 1, [minDate, maxDate]);
  const svgWidth = useMemo(() => totalDays * pxPerDay, [totalDays, pxPerDay]);
  const svgHeight = useMemo(() => tasks.length * ROW_H + HEADER_H, [tasks.length]);

  const criticalPath = useMemo(() => tasks.length ? computeCriticalPath(tasks) : new Set(), [tasks]);

  const dateToX = useCallback((dateStr) => {
    const d = parseDate(dateStr);
    return diffDays(minDate, d) * pxPerDay;
  }, [minDate, pxPerDay]);

  function _xToDate(x) {
    const days = Math.round(x / pxPerDay);
    const d = addDays(minDate, days);
    return d.toISOString().slice(0, 10);
  }

  function scrollToToday() {
    if (!scrollRef.current) return;
    const today = new Date().toISOString().slice(0, 10);
    const tx = dateToX(today);
    const cw = scrollRef.current.clientWidth;
    scrollRef.current.scrollLeft = tx - cw / 2;
  }

  function handleZoomIn() {
    setPxPerDayOverride(prev => Math.min((prev !== null ? prev : pxPerDay) * 1.25, 120));
  }
  function handleZoomOut() {
    setPxPerDayOverride(prev => Math.max((prev !== null ? prev : pxPerDay) * 0.8, 2));
  }
  function handleZoomLevel(lvl) {
    setZoomLevel(lvl);
    setPxPerDayOverride(null);
  }

  // Mouse handlers for drag-to-resize
  function handleBarResizeStart(e, taskId, origEnd) {
    e.preventDefault();
    e.stopPropagation();
    setDragging({ taskId, startX: e.clientX, origEnd });
  }

  function handleSvgMouseMove(e) {
    if (!dragging) return;
    const deltaX = e.clientX - dragging.startX;
    const deltaDays = Math.round(deltaX / pxPerDay);
    const origDate = parseDate(dragging.origEnd);
    const newDate = addDays(origDate, deltaDays);
    const newDateStr = newDate.toISOString().slice(0, 10);
    setTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, end_date: newDateStr } : t));
  }

  function handleSvgMouseUp() {
    if (!dragging) return;
    const task = tasks.find(t => t.id === dragging.taskId);
    if (task) {
      api.put(`/gantt/tasks/${task.id}`, { end_date: task.end_date }).catch(() => {
        // Revert optimistic update on failure
        setTasks(prev => prev.map(t => t.id === dragging.taskId ? { ...t, end_date: dragging.origEnd } : t));
      });
    }
    setDragging(null);
  }

  // Timeline header segments
  const headerSegments = useMemo(() => {
    if (!totalDays) return [];
    const segments = [];
    const cur = new Date(minDate);
    const end = new Date(maxDate);

    if (zoomLevel === 'month') {
      while (cur <= end) {
        const monthStart = new Date(cur.getFullYear(), cur.getMonth(), 1);
        const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
        const segStart = cur < monthStart ? monthStart : new Date(cur);
        const segEnd = monthEnd < end ? monthEnd : new Date(end);
        const x = diffDays(minDate, segStart) * pxPerDay;
        const w = (diffDays(segStart, segEnd) + 1) * pxPerDay;
        segments.push({ x, w, label: segStart.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) });
        cur.setMonth(cur.getMonth() + 1);
        cur.setDate(1);
      }
    } else if (zoomLevel === 'week') {
      let d = new Date(minDate);
      // align to Monday
      const dow = d.getDay();
      d = addDays(d, dow === 0 ? -6 : -(dow - 1));
      while (d <= end) {
        const wEnd = addDays(d, 6);
        const x = Math.max(0, diffDays(minDate, d) * pxPerDay);
        const w = 7 * pxPerDay;
        const wNum = Math.ceil((diffDays(new Date(d.getFullYear(), 0, 1), d) + 1) / 7);
        const label = `W${wNum} ${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}–${wEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}`;
        segments.push({ x, w, label });
        d = addDays(d, 7);
      }
    } else {
      // day zoom — show one segment per day
      let d = new Date(minDate);
      while (d <= end) {
        const x = diffDays(minDate, d) * pxPerDay;
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        segments.push({ x, w: pxPerDay, label: String(d.getDate()), isWeekend, date: new Date(d) });
        d = addDays(d, 1);
      }
    }
    return segments;
  }, [minDate, maxDate, totalDays, pxPerDay, zoomLevel]);

  const todayX = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (today < minDate || today > maxDate) return null;
    return diffDays(minDate, today) * pxPerDay;
  }, [minDate, maxDate, pxPerDay]);


  return (
    <div style={{ fontFamily:'Inter,sans-serif', background:'#f5f3ff', minHeight:'100vh', padding:24 }}>
      {/* Page title */}
      <div style={{ marginBottom:16 }}>
        <h1 style={{ fontSize:22, fontWeight:700, color:'#1e1b4b', margin:0 }}>Gantt Chart</h1>
        <p style={{ color:'#6b7280', fontSize:13, margin:'4px 0 0' }}>Project timeline and task dependencies</p>
      </div>

      {/* Card wrapper */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>

        {/* TOOLBAR */}
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 16px', borderBottom:'1px solid #e9e4ff', flexWrap:'wrap' }}>
          {/* Zoom level buttons */}
          <div style={{ display:'flex', gap:4 }}>
            {['day','week','month'].map(lvl => (
              <button key={lvl} onClick={() => handleZoomLevel(lvl)} style={{
                padding:'5px 14px', borderRadius:6, border:'1px solid #e9e4ff', cursor:'pointer', fontSize:13, fontWeight:500,
                background: zoomLevel === lvl ? '#6B3FDB' : '#f5f3ff',
                color: zoomLevel === lvl ? '#fff' : '#4b5563',
                transition:'all 0.15s'
              }}>
                {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
              </button>
            ))}
          </div>

          <div style={{ width:1, height:20, background:'#e9e4ff', margin:'0 4px' }} />

          {/* Today button */}
          <button onClick={scrollToToday} style={{
            padding:'5px 14px', borderRadius:6, border:'1px solid #6B3FDB', background:'#f5f3ff', color:'#6B3FDB',
            cursor:'pointer', fontSize:13, fontWeight:500
          }}>
            ◄ Today ►
          </button>

          <div style={{ width:1, height:20, background:'#e9e4ff', margin:'0 4px' }} />

          {/* Zoom in/out */}
          <button onClick={handleZoomIn} style={{
            width:32, height:32, borderRadius:6, border:'1px solid #e9e4ff', background:'#f5f3ff',
            cursor:'pointer', fontSize:18, color:'#6B3FDB', display:'flex', alignItems:'center', justifyContent:'center'
          }}>+</button>
          <button onClick={handleZoomOut} style={{
            width:32, height:32, borderRadius:6, border:'1px solid #e9e4ff', background:'#f5f3ff',
            cursor:'pointer', fontSize:18, color:'#6B3FDB', display:'flex', alignItems:'center', justifyContent:'center'
          }}>−</button>

          <div style={{ width:1, height:20, background:'#e9e4ff', margin:'0 4px' }} />

          {/* Export */}
          <button onClick={() => window.print()} style={{
            padding:'5px 14px', borderRadius:6, border:'1px solid #e9e4ff', background:'#f5f3ff',
            cursor:'pointer', fontSize:13, fontWeight:500, color:'#4b5563'
          }}>
            Export
          </button>

          <div style={{ marginLeft:'auto', display:'flex', gap:12, alignItems:'center' }}>
            <LegendDot color="#22c55e" label="On Track" />
            <LegendDot color="#f59e0b" label="At Risk" />
            <LegendDot color="#ef4444" label="Delayed" />
            <LegendDot color="#6B3FDB" label="Milestone" isSquare={false} isDiamond />
          </div>
        </div>

        {/* MAIN AREA */}
        {!loading && tasks.length === 0 ? (
          <div style={{ padding: 32 }}>
            <EmptyState
              icon={FolderKanban}
              title="No tasks found for this project"
              sub="Add your first task to build the project timeline."
              action={
                <button
                  onClick={() => setShowAddTask(true)}
                  style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
                >
                  Add Task
                </button>
              }
            />
          </div>
        ) : null}
        <div style={{ display: tasks.length === 0 ? 'none' : 'flex', position:'relative' }}>

          {/* RESOURCE COLUMN */}
          <div style={{ width:RESOURCE_W, minWidth:RESOURCE_W, flexShrink:0, borderRight:'1px solid #e9e4ff', zIndex:10, background:'#fff' }}>
            {/* Header placeholder matching timeline header height */}
            <div style={{ height:HEADER_H, borderBottom:'1px solid #e9e4ff', background:'#faf9ff', display:'flex', alignItems:'center', paddingLeft:12 }}>
              <span style={{ fontSize:11, fontWeight:600, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:0.5 }}>Task / Assignee</span>
            </div>
            {tasks.map((task, i) => (
              <div key={task.id} style={{
                height:ROW_H, display:'flex', flexDirection:'column', justifyContent:'center',
                padding:'0 12px', borderBottom:'1px solid #f0f0f4',
                background: i % 2 === 0 ? '#fff' : '#fafafa'
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  {task.is_milestone && (
                    <span style={{ fontSize:12, color:'#6B3FDB', marginRight:2 }}>◆</span>
                  )}
                  <span style={{ fontSize:13, fontWeight:600, color:'#1e1b4b', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:180 }}>
                    {task.name}
                  </span>
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:3 }}>
                  <div style={{
                    width:20, height:20, borderRadius:'50%', background:assigneeColor(task.assignee),
                    display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:9, fontWeight:700, color:'#fff', flexShrink:0
                  }}>
                    {initials(task.assignee)}
                  </div>
                  <span style={{ fontSize:11, color:'#6b7280', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:130 }}>
                    {task.assignee}
                  </span>
                  {!task.is_milestone && (
                    <span style={{ fontSize:11, color:'#9ca3af', marginLeft:'auto', flexShrink:0 }}>{task.progress}%</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* SVG TIMELINE AREA */}
          <div
            ref={scrollRef}
            style={{ overflowX:'auto', flex:1, position:'relative', cursor: dragging ? 'col-resize' : 'default' }}
          >
            <svg
              ref={svgRef}
              width={svgWidth}
              height={svgHeight}
              style={{ display:'block' }}
              onMouseMove={handleSvgMouseMove}
              onMouseUp={handleSvgMouseUp}
              onMouseLeave={handleSvgMouseUp}
            >
              {/* Zebra stripe backgrounds */}
              {tasks.map((task, i) => (
                <rect
                  key={`zebra-${task.id}`}
                  x={0} y={HEADER_H + i * ROW_H}
                  width={svgWidth} height={ROW_H}
                  fill={i % 2 === 0 ? '#ffffff' : '#fafafa'}
                />
              ))}

              {/* Timeline Header */}
              <GanttHeader
                segments={headerSegments}
                zoomLevel={zoomLevel}
                pxPerDay={pxPerDay}
                minDate={minDate}
                totalDays={totalDays}
                svgWidth={svgWidth}
              />

              {/* Today vertical line */}
              {todayX !== null && (
                <line
                  x1={todayX} y1={HEADER_H}
                  x2={todayX} y2={svgHeight}
                  stroke="#6B3FDB" strokeWidth={1.5}
                  strokeDasharray="6 4" opacity={0.6}
                />
              )}

              {/* Row separators */}
              {tasks.map((_, i) => (
                <line
                  key={`sep-${i}`}
                  x1={0} y1={HEADER_H + (i + 1) * ROW_H}
                  x2={svgWidth} y2={HEADER_H + (i + 1) * ROW_H}
                  stroke="#f0f0f4" strokeWidth={1}
                />
              ))}

              {/* Dependency arrows — rendered before bars so bars are on top */}
              {tasks.map(task => {
                const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
                return deps.map(depId => {
                  const depTask = tasks.find(t => t.id === depId);
                  if (!depTask) return null;
                  const depIdx = tasks.indexOf(depTask);
                  const taskIdx = tasks.indexOf(task);
                  const isCritical = criticalPath.has(task.id) && criticalPath.has(depId);

                  let x1, y1;
                  if (depTask.is_milestone) {
                    x1 = dateToX(depTask.end_date) + 14;
                  } else {
                    x1 = dateToX(depTask.end_date) + pxPerDay;
                  }
                  y1 = HEADER_H + depIdx * ROW_H + ROW_H / 2;

                  let x2;
                  if (task.is_milestone) {
                    x2 = dateToX(task.start_date);
                  } else {
                    x2 = dateToX(task.start_date);
                  }
                  const y2 = HEADER_H + taskIdx * ROW_H + ROW_H / 2;

                  const cp1x = x1 + 40;
                  const cp2x = x2 - 40;
                  const pathD = `M${x1},${y1} C${cp1x},${y1} ${cp2x},${y2} ${x2},${y2}`;
                  const arrowColor = isCritical ? '#ef4444' : '#94a3b8';
                  const arrowPts = `${x2},${y2} ${x2-8},${y2-4} ${x2-8},${y2+4}`;

                  return (
                    <g key={`dep-${task.id}-${depId}`}>
                      <path d={pathD} stroke={arrowColor} strokeWidth={isCritical ? 2 : 1.5} fill="none" opacity={0.8} />
                      <polygon points={arrowPts} fill={arrowColor} />
                    </g>
                  );
                });
              })}

              {/* Task bars and milestones */}
              {tasks.map((task, i) => {
                const rowY = HEADER_H + i * ROW_H;
                const centerY = rowY + ROW_H / 2;
                const isCritical = criticalPath.has(task.id);

                if (task.is_milestone) {
                  const mx = dateToX(task.start_date) + pxPerDay / 2;
                  const my = centerY;
                  const pts = `${mx},${my - 14} ${mx + 14},${my} ${mx},${my + 14} ${mx - 14},${my}`;
                  return (
                    <g key={`m-${task.id}`}
                      onMouseEnter={e => setTooltip({ task, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setTooltip(null)}
                      style={{ cursor:'pointer' }}
                    >
                      <polygon points={pts} fill="#6B3FDB" stroke="#fff" strokeWidth={2} />
                    </g>
                  );
                }

                const barX = dateToX(task.start_date);
                const barEndX = dateToX(task.end_date) + pxPerDay;
                const barW = Math.max(barEndX - barX, 4);
                const barY = centerY - BAR_H / 2;
                const color = statusColor(task.status);
                const progressW = barW * (task.progress / 100);
                const showLabel = barW > 60;

                return (
                  <g key={`bar-${task.id}`}
                    onMouseEnter={e => setTooltip({ task, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setTooltip(null)}
                    style={{ cursor:'pointer' }}
                  >
                    {/* Bar background */}
                    <rect
                      x={barX} y={barY} width={barW} height={BAR_H}
                      rx={4} ry={4}
                      fill={color}
                      opacity={0.85}
                      stroke={isCritical ? '#ef4444' : 'none'}
                      strokeWidth={isCritical ? 2 : 0}
                    />
                    {/* Progress fill */}
                    {task.progress > 0 && (
                      <rect
                        x={barX} y={barY} width={progressW} height={BAR_H}
                        rx={4} ry={4}
                        fill={darkenColor(color, 30)}
                        opacity={0.45}
                      />
                    )}
                    {/* Label inside bar */}
                    {showLabel && (
                      <text
                        x={barX + 8} y={barY + BAR_H / 2 + 1}
                        dominantBaseline="middle"
                        fontSize={11} fontWeight={500} fill="#fff"
                        style={{ pointerEvents:'none', userSelect:'none' }}
                      >
                        <title>{task.name}</title>
                        {task.name.length > Math.floor(barW / 7) ? task.name.slice(0, Math.floor(barW / 7)) + '…' : task.name}
                      </text>
                    )}
                    {/* Resize handle */}
                    <rect
                      x={barX + barW - 8} y={barY}
                      width={8} height={BAR_H}
                      fill="transparent"
                      style={{ cursor:'col-resize' }}
                      onMouseDown={e => handleBarResizeStart(e, task.id, task.end_date)}
                    />
                  </g>
                );
              })}
            </svg>

            {/* Tooltip — absolutely positioned over the scroll container */}
            {tooltip && (
              <div style={{
                position:'fixed',
                left: Math.min(tooltip.x + 12, window.innerWidth - 224),
                top: tooltip.y + 12,
                width:210,
                background:'#fff',
                border:'1px solid #e9e4ff',
                borderRadius:8,
                boxShadow:'0 8px 24px rgba(107,63,219,0.12)',
                padding:'10px 14px',
                zIndex:9999,
                pointerEvents:'none',
                fontFamily:'Inter,sans-serif'
              }}>
                <div style={{ fontWeight:700, fontSize:13, color:'#1e1b4b', marginBottom:6, borderBottom:'1px solid #f0f0f4', paddingBottom:6 }}>
                  {tooltip.task.is_milestone ? '◆ ' : ''}{tooltip.task.name}
                </div>
                <div style={{ fontSize:12, color:'#4b5563', lineHeight:1.7 }}>
                  <div>📅 {formatDate(parseDate(tooltip.task.start_date))} – {formatDate(parseDate(tooltip.task.end_date))}</div>
                  <div>👤 {tooltip.task.assignee}</div>
                  {!tooltip.task.is_milestone && <div>📊 {tooltip.task.progress}% complete</div>}
                  <div style={{ display:'flex', alignItems:'center', gap:4, marginTop:2 }}>
                    <span style={{ width:8, height:8, borderRadius:'50%', background:statusColor(tooltip.task.status), display:'inline-block' }} />
                    <span style={{ textTransform:'capitalize' }}>
                      {tooltip.task.status === 'on_track' ? 'On Track' : tooltip.task.status === 'at_risk' ? '⚠ At Risk' : '✗ Delayed'}
                    </span>
                  </div>
                  {tooltip.task.project && (
                    <div style={{ color:'#9ca3af', marginTop:2, fontSize:11 }}>{tooltip.task.project}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GanttHeader({ segments, zoomLevel, pxPerDay, minDate, totalDays, svgWidth }) {
  const primaryH = 28;
  const secondaryH = HEADER_H - primaryH;

  return (
    <g>
      {/* Header background */}
      <rect x={0} y={0} width={svgWidth} height={HEADER_H} fill="#faf9ff" />
      <line x1={0} y1={HEADER_H} x2={svgWidth} y2={HEADER_H} stroke="#e9e4ff" strokeWidth={1} />

      {/* Primary header segments */}
      {segments.map((seg, i) => (
        <g key={`hseg-${i}`}>
          {seg.isWeekend && zoomLevel === 'day' && (
            <rect x={seg.x} y={0} width={seg.w} height={HEADER_H} fill="#f8f8f8" />
          )}
          {seg.w > 20 && (
            <text
              x={seg.x + seg.w / 2} y={primaryH / 2 + 1}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={zoomLevel === 'day' ? 11 : 12}
              fontWeight={500} fill="#4b5563"
            >
              {seg.label}
            </text>
          )}
          <line x1={seg.x} y1={0} x2={seg.x} y2={primaryH} stroke="#e9e4ff" strokeWidth={1} />
        </g>
      ))}

      {/* Secondary row — day ticks */}
      <line x1={0} y1={primaryH} x2={svgWidth} y2={primaryH} stroke="#e9e4ff" strokeWidth={1} />
      {Array.from({ length: totalDays }, (_, i) => {
        const d = addDays(minDate, i);
        const x = i * pxPerDay;
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        const showTick = zoomLevel === 'day' || (zoomLevel === 'week' && pxPerDay >= 10 && d.getDay() === 1) || (zoomLevel === 'month' && d.getDate() === 1);
        if (!showTick) return null;
        return (
          <g key={`tick-${i}`}>
            {isWeekend && zoomLevel === 'day' && (
              <rect x={x} y={primaryH} width={pxPerDay} height={secondaryH} fill="#f3f0ff" opacity={0.5} />
            )}
            <line x1={x} y1={primaryH} x2={x} y2={HEADER_H} stroke="#e9e4ff" strokeWidth={1} />
            {pxPerDay >= 14 && (
              <text
                x={x + pxPerDay / 2} y={primaryH + secondaryH / 2 + 1}
                textAnchor="middle" dominantBaseline="middle"
                fontSize={10} fill={isWeekend ? '#9ca3af' : '#6b7280'}
              >
                {d.getDate()}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

function LegendDot({ color, label, isDiamond }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5 }}>
      {isDiamond ? (
        <svg width={12} height={12}>
          <polygon points="6,0 12,6 6,12 0,6" fill={color} />
        </svg>
      ) : (
        <div style={{ width:12, height:12, borderRadius:3, background:color }} />
      )}
      <span style={{ fontSize:11, color:'#6b7280' }}>{label}</span>
    </div>
  );
}
