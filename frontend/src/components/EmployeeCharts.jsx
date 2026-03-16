import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, LabelList
} from "recharts";

const COLORS = ["#6b7280", "#9ca3af", "#4b5563", "#d1d5db"];

export function GenderChart({ employees }) {
  const maleCount = employees.filter(e => e.gender === "Male").length;
  const femaleCount = employees.filter(e => e.gender === "Female").length;
  
  if (maleCount === 0 && femaleCount === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '240px', color: '#9ca3af', fontSize: '14px' }}>
        No gender data available
      </div>
    );
  }
  
  const genderData = [
    { name: "Male", value: maleCount },
    { name: "Female", value: femaleCount }
  ].filter(d => d.value > 0);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={genderData} dataKey="value" cx="50%" cy="50%" outerRadius={80}>
          {genderData.map((_, i) => (
            <Cell key={i} fill={COLORS[i]} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function SkillChart({ employees }) {
  const skilledCount = employees.filter(e => e.skill_type === "Skilled").length;
  const semiSkilledCount = employees.filter(e => e.skill_type === "Semi Skilled").length;
  const unskilledCount = employees.filter(e => e.skill_type === "Unskilled").length;
  
  const skillData = [
    { name: "Skilled", value: skilledCount },
    { name: "Semi Skilled", value: semiSkilledCount },
    { name: "Unskilled", value: unskilledCount }
  ].filter(s => s.value > 0);

  if (skillData.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '240px', color: '#9ca3af', fontSize: '14px' }}>
        No skill data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={skillData} dataKey="value" cx="50%" cy="50%" outerRadius={80} innerRadius={40}>
          {skillData.map((_, i) => (
            <Cell key={i} fill={COLORS[i]} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function DepartmentChart({ employees }) {
  const deptCounts = {};
  employees.forEach(emp => {
    if (emp.department && emp.status !== "Left") {
      deptCounts[emp.department] = (deptCounts[emp.department] || 0) + 1;
    }
  });
  
  const deptData = Object.entries(deptCounts).map(([name, employees]) => ({ name, employees }));

  if (deptData.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '260px', color: '#9ca3af', fontSize: '14px' }}>
        No department data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={deptData} margin={{ top: 20, right: 25, left: 15, bottom: 30 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="name" tick={{fontSize:14}} />
        <YAxis tick={{fontSize:14}} domain={[0, 'dataMax + 5']}/>
        <Tooltip />
        <Bar dataKey="employees" fill="#3b82f6" radius={[8, 8, 0, 0]}>
          <LabelList dataKey="employees" position="top" style={{fontWeight:"700", fontSize: 16, fill: "#1f2937"}} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function GrowthChart({ employees }) {
  const activeEmployees = employees.filter(e => e.status !== "Left");
  const monthCounts = {};
  
  const now = new Date();
  const last12Months = [];
  
  for (let i = 11; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    last12Months.push(monthKey);
    monthCounts[monthKey] = 0;
  }
  
  activeEmployees.forEach(emp => {
    if (emp.joining_date) {
      const joinDate = new Date(emp.joining_date);
      const monthKey = `${joinDate.getFullYear()}-${String(joinDate.getMonth() + 1).padStart(2, '0')}`;
      if (monthCounts.hasOwnProperty(monthKey)) {
        monthCounts[monthKey]++;
      }
    }
  });
  
  let cumulative = activeEmployees.filter(emp => {
    if (!emp.joining_date) return false;
    const joinDate = new Date(emp.joining_date);
    const firstMonth = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    return joinDate < firstMonth;
  }).length;
  
  const growthData = last12Months.map(monthKey => {
    cumulative += monthCounts[monthKey];
    const [year, month] = monthKey.split('-');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return { 
      month: monthNames[parseInt(month) - 1], 
      employees: cumulative 
    };
  });

  if (growthData.every(d => d.employees === 0)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '260px', color: '#9ca3af', fontSize: '14px' }}>
        No employee growth data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={growthData} margin={{top:20,right:25,left:15,bottom:30}}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="month" tick={{fontSize:14}} />
        <YAxis tick={{ fontSize: 14 }} domain={[0, 'dataMax + 5']} />
        <Tooltip />
        <Bar dataKey="employees" fill="#10b981" radius={[8, 8, 0, 0]}>
          <LabelList dataKey="employees" position="top" style={{fontWeight:"700", fontSize:14, fill: "#1f2937"}}/>
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}