import pool from "../../config/db.js";

export const getFinanceDashboard = async (req, res) => {
  try {
    const kpis = {
      bankBalance: 250000,
      cashBalance: 50000,
      accountsReceivable: 125000,
      accountsPayable: 85000,
      monthRevenue: 180000,
      monthExpenses: 95000,
      netProfit: 85000
    };

    const alerts = [
      { title: "Overdue Invoices", message: "5 invoices overdue by more than 30 days", severity: "high" },
      { title: "Low Bank Balance", message: "Bank balance below threshold", severity: "medium" },
      { title: "Upcoming Payments", message: "12 payments due in next 7 days", severity: "low" }
    ];

    res.json({ kpis, alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getJournalEntries = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM journal_entries ORDER BY date DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const createJournalEntry = async (req, res) => {
  try {
    const { date, reference, narration, lines } = req.body;
    const amount = lines.reduce((sum, l) => sum + parseFloat(l.debit), 0);
    
    const entry = await pool.query(
      "INSERT INTO journal_entries (date, reference, narration, amount) VALUES ($1, $2, $3, $4) RETURNING *",
      [date, reference, narration, amount]
    );
    
    for (const line of lines) {
      await pool.query(
        "INSERT INTO journal_entry_lines (journal_entry_id, account_code, description, debit, credit) VALUES ($1, $2, $3, $4, $5)",
        [entry.rows[0].id, line.account, line.description, line.debit, line.credit]
      );
    }
    
    res.json(entry.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getPeriods = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM financial_periods ORDER BY start_date DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const closePeriod = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "UPDATE financial_periods SET status = 'Closed', closed_by = $1, closed_date = NOW() WHERE id = $2 RETURNING *",
      [req.user.email, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getCFODashboard = async (req, res) => {
  try {
    const kpis = {
      totalAssets: 1250000,
      totalLiabilities: 450000,
      equity: 800000,
      currentRatio: 2.5,
      quickRatio: 1.8,
      debtToEquity: 0.56,
      roa: 12.5,
      roe: 18.3,
      grossMargin: 45.2,
      netMargin: 22.8,
      workingCapital: 350000,
      cashRunway: 180
    };
    res.json(kpis);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getAccounts = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM chart_of_accounts ORDER BY code");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const createAccount = async (req, res) => {
  try {
    const { code, name, type, parent, status } = req.body;
    const result = await pool.query(
      "INSERT INTO chart_of_accounts (code, name, type, parent, status) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [code, name, type, parent, status]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getInvoices = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM invoices ORDER BY invoice_date DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getInvoiceStats = async (req, res) => {
  try {
    const stats = {
      totalInvoices: 45,
      paidInvoices: 32,
      overdueInvoices: 5,
      outstanding: 125000
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getBills = async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM supplier_bills ORDER BY bill_date DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getBillStats = async (req, res) => {
  try {
    const stats = {
      totalBills: 38,
      overdueBills: 3,
      upcomingPayments: 12
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
