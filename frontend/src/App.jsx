import { useState } from "react";
import { useAuth } from "./context/AuthContext";
import Layout from "./components/Layout";
import Login from "./pages/Login";

function App() {
  const { isLoggedIn, initializing, user } = useAuth();
  const [page, setPage] = useState(() => {
    if (typeof window !== 'undefined') {
      const storedRole = localStorage.getItem('role');
      const roleRedirects = {
        employee        : "EmployeeDashboard",
        manager         : "ManagerDashboard",
        department_head : "ManagerDashboard",
        admin           : "SuperAdminDashboard",
        super_admin     : "SuperAdminDashboard",
      };
      return roleRedirects[storedRole] || 'Home';
    }
    return 'Home';
  });
  const [selectedEmployee, setSelectedEmployee] = useState(null);

  if (initializing) {
    return <div style={{ padding: '50px', textAlign: 'center' }}>Loading...</div>;
  }

  if (!isLoggedIn) {
    return <Login setPage={setPage} />;
  }

  return (
    <Layout
      page={page}
      setPage={setPage}
      selectedEmployee={selectedEmployee}
      setSelectedEmployee={setSelectedEmployee}
    />
  );
}

export default App;
