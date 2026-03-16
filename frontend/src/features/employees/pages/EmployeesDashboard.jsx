import { useState, useEffect } from "react";
import api from "@/services/api/client";
import "@/pages/Home.css" 
import { GenderChart, SkillChart, DepartmentChart, GrowthChart } from "@/components/EmployeeCharts";
import "./EmployeesDashboard.css";

export default function EmployeesDashboard({ setPage, setSelectedEmployee }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterDept, setFilterDept] = useState("All");
  const [hrAlerts, setHrAlerts] = useState([]);

  // Fetch employees on component mount
  useEffect(() => {
    fetchEmployees();
  }, []);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      console.log("📥 Fetching employees from API...");
      const response = await api.get("/employees");
      console.log("✅ Employees fetched:", response.data);
      const empData = response.data || [];
      setEmployees(empData);
      calculateHRAlerts(empData);
    } catch (err) {
      console.error("❌ Error fetching employees:", err.message);
    } finally {
      setLoading(false);
    }
  };

  const calculateHRAlerts = (empData) => {
    const today = new Date();
    const alerts = [];

    empData.forEach(emp => {
      const dob = emp.dob ? new Date(emp.dob) : null;
      const anniversary = emp.anniversary_date ? new Date(emp.anniversary_date) : null;
      const doj = emp.joining_date ? new Date(emp.joining_date) : null;

      // Check birthdays in next 7 days
      if (dob) {
        const nextBirthday = new Date(today.getFullYear(), dob.getMonth(), dob.getDate());
        if (nextBirthday < today) nextBirthday.setFullYear(today.getFullYear() + 1);
        const daysUntil = Math.ceil((nextBirthday - today) / (1000 * 60 * 60 * 24));
        if (daysUntil >= 0 && daysUntil <= 7) {
          alerts.push({ name: `${emp.first_name} ${emp.last_name}`, type: 'Birthday', days: daysUntil });
        }
      }

      // Check anniversaries in next 7 days
      if (anniversary) {
        const nextAnniversary = new Date(today.getFullYear(), anniversary.getMonth(), anniversary.getDate());
        if (nextAnniversary < today) nextAnniversary.setFullYear(today.getFullYear() + 1);
        const daysUntil = Math.ceil((nextAnniversary - today) / (1000 * 60 * 60 * 24));
        if (daysUntil >= 0 && daysUntil <= 7) {
          alerts.push({ name: `${emp.first_name} ${emp.last_name}`, type: 'Anniversary', days: daysUntil });
        }
      }

      // Check work anniversaries in next 7 days
      if (doj) {
        const nextWorkAnniversary = new Date(today.getFullYear(), doj.getMonth(), doj.getDate());
        if (nextWorkAnniversary < today) nextWorkAnniversary.setFullYear(today.getFullYear() + 1);
        const daysUntil = Math.ceil((nextWorkAnniversary - today) / (1000 * 60 * 60 * 24));
        if (daysUntil >= 0 && daysUntil <= 7 && doj.getFullYear() < today.getFullYear()) {
          const years = today.getFullYear() - doj.getFullYear();
          alerts.push({ name: `${emp.first_name} ${emp.last_name}`, type: `Work Anniversary (${years} years)`, days: daysUntil });
        }
      }

      // Check probation ending in next 7 days (6 months from joining)
      if (emp.status === "Probation" && doj) {
        const probationEnd = new Date(doj);
        probationEnd.setMonth(probationEnd.getMonth() + 6);
        const daysUntil = Math.ceil((probationEnd - today) / (1000 * 60 * 60 * 24));
        if (daysUntil >= 0 && daysUntil <= 7) {
          alerts.push({ 
            name: `${emp.first_name} ${emp.last_name}`, 
            type: `Probation Ending - Notify ${emp.department_head || 'Manager'}`, 
            days: daysUntil 
          });
        }
      }
    });

    setHrAlerts(alerts);
  };

  // Filter employees based on search and department
  const filteredEmployees = employees.filter((emp) => {
    const matchesSearch = 
      emp.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.last_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.company_email?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesDept = filterDept === "All" || emp.department === filterDept;
    
    return matchesSearch && matchesDept;
  });

  // Get unique departments
  const departments = ["All", ...new Set(employees.map(e => e.department).filter(Boolean))];

  // Calculate stats from employee data
  const calculateAverageService = () => {
    if (employees.length === 0) return "0";
    const totalYears = employees.reduce((sum, emp) => {
      if (emp.joining_date) {
        const years = (new Date() - new Date(emp.joining_date)) / (365.25 * 24 * 60 * 60 * 1000);
        return sum + years;
      }
      return sum;
    }, 0);
    return (totalYears / employees.length).toFixed(1);
  };

  const stats = [
    { 
      title: "Total Employees", 
      value: employees.filter(e => e.status !== "Left").length,
      trend: "+3",
      trendText: "this month"
    },
    { 
      title: "Active Employees", 
      value: employees.filter(e => e.status === "Active" || !e.status).length,
      trend: "+5",
      trendText: "this month"
    },
    { 
      title: "Probation Employees", 
      value: employees.filter(e => e.status === "Probation").length,
      trend: "-2",
      trendText: "this month"
    },
    { 
      title: "Notice Period Employees", 
      value: employees.filter(e => e.status === "Notice").length,
      trend: "+1",
      trendText: "this month"
    },
    { 
      title: "Average Service Years", 
      value: calculateAverageService(),
      trend: "+0.2",
      trendText: "vs last year"
    }
  ];


  return (
    <div className="employees-page">

      {/* PAGE TITLE */}
      <h1 style={{marginBottom:"20px"}}>Employees Dashboard</h1>

      {/* 🟦 KPI CARDS */}
      <div className="kpi-cards-row">
        {stats.map((card,i)=>(
          <div key={i} className="kpi-card">
            <div className="kpi-title">{card.title}</div>
            <div className="kpi-value">{card.value}</div>
            <div className={`kpi-trend ${parseFloat(card.trend) >= 0 ? 'positive' : 'negative'}`}>
              {parseFloat(card.trend) >= 0 ? '▲' : '▼'} {card.trend} {card.trendText}
            </div>
          </div>
        ))}
      </div>


      {/* 🟨 CHART PLACEHOLDERS */}
   {/* Row 1 : Gender + Skill */}
<div className="charts-row">
  <div className="widget chart-widget">
    <h2>Gender Distribution</h2>
    <div className="chart-flex">
      <GenderChart employees={employees} />
      <div className="chart-legend">
        <div className="legend-item">
          <h2>Male </h2>
          <h2>{employees.filter(e => e.gender === "Male").length}</h2>
        </div>
        <div className="legend-item">
          <h2>Female</h2>
          <h2>{employees.filter(e => e.gender === "Female").length}</h2>
        </div>
      </div>
    </div>
  </div>

  <div className="widget chart-widget">
    <h2>Skill Distribution</h2>
    <div className="chart-flex">
      <SkillChart employees={employees} />
      <div className="chart-legend">
        <div className="legend-item">
          <h2>Skilled</h2>
          <h2>{employees.filter(e => e.skill_type === "Skilled").length}</h2>
        </div>
        <div className="legend-item">
          <h2>Semi Skilled</h2>
          <h2>{employees.filter(e => e.skill_type === "Semi Skilled").length}</h2>
        </div>
        <div className="legend-item">
          <h2>Unskilled</h2>
          <h2>{employees.filter(e => e.skill_type === "Unskilled").length}</h2>
        </div>
      </div>
    </div>
  </div>
</div>


{/* Row 2 : Department full width */}
<div className="charts-row">

  <div className="widget chart-widget">
    <h2>Department Distribution</h2>
    <DepartmentChart employees={employees} />
  </div>

  <div className="widget chart-widget">
    <h2>Employee Growth</h2>
    <GrowthChart employees={employees} />
  </div>

</div>

      {/* 🟩 HR ALERTS */}
      <div className="hr-alerts-section">
        <div className="widget hr-alerts-widget">
          <h3>🚨 HR Alerts (Next 7 Days)</h3>
          <div className="hr-alerts-list">
            {hrAlerts.length > 0 ? (
              hrAlerts.slice(0, 5).map((alert, i) => (
                <div key={i} className="hr-alert-item">
                  <span className="alert-name">{alert.name}</span>
                  <span className="alert-type">— {alert.type}</span>
                  <span className="alert-time">{alert.days === 0 ? 'Today' : `in ${alert.days} day${alert.days > 1 ? 's' : ''}`}</span>
                </div>
              ))
            ) : (
              <div className="no-alerts">✅ No upcoming events</div>
            )}
          </div>
        </div>
      </div>

      </div>
  );
}

