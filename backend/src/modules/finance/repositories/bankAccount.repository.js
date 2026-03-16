import pool from '../db.js';

class BankAccountRepository {
  async create(data) {
    const { account_name, account_number, bank_name, branch, ifsc_code, account_type, currency, opening_balance, chart_account_id } = data;
    const result = await pool.query(
      `INSERT INTO bank_accounts (account_name, account_number, bank_name, branch, ifsc_code, account_type, currency, opening_balance, current_balance, chart_account_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9) RETURNING *`,
      [account_name, account_number, bank_name, branch, ifsc_code, account_type, currency, opening_balance, chart_account_id]
    );
    return result.rows[0];
  }

  async findAll(filters = {}) {
    let query = 'SELECT * FROM bank_accounts WHERE deleted_at IS NULL';
    const params = [];
    
    if (filters.is_active !== undefined) {
      params.push(filters.is_active);
      query += ` AND is_active = $${params.length}`;
    }
    
    query += ' ORDER BY account_name';
    const result = await pool.query(query, params);
    return result.rows;
  }

  async findById(id) {
    const result = await pool.query(
      'SELECT * FROM bank_accounts WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    return result.rows[0];
  }

  async updateBalance(client, id, amount, type) {
    const operator = type === 'credit' ? '+' : '-';
    const result = await client.query(
      `UPDATE bank_accounts 
       SET current_balance = current_balance ${operator} $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 RETURNING *`,
      [amount, id]
    );
    return result.rows[0];
  }

  async createTransaction(client, data) {
    const { bank_account_id, transaction_date, transaction_type, amount, reference_number, description, journal_entry_id } = data;
    
    const account = await this.findById(bank_account_id);
    const balance_after = transaction_type === 'Credit' 
      ? parseFloat(account.current_balance) + parseFloat(amount)
      : parseFloat(account.current_balance) - parseFloat(amount);
    
    const result = await client.query(
      `INSERT INTO bank_transactions (bank_account_id, transaction_date, transaction_type, amount, balance_after, reference_number, description, journal_entry_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [bank_account_id, transaction_date, transaction_type, amount, balance_after, reference_number, description, journal_entry_id]
    );
    
    await this.updateBalance(client, bank_account_id, amount, transaction_type === 'Credit' ? 'credit' : 'debit');
    
    return result.rows[0];
  }

  async getTransactions(bankAccountId, startDate, endDate) {
    const result = await pool.query(
      `SELECT * FROM bank_transactions 
       WHERE bank_account_id = $1 
       AND transaction_date BETWEEN $2 AND $3 
       ORDER BY transaction_date DESC, created_at DESC`,
      [bankAccountId, startDate, endDate]
    );
    return result.rows;
  }

  async getUnreconciledTransactions(bankAccountId) {
    const result = await pool.query(
      `SELECT * FROM bank_transactions 
       WHERE bank_account_id = $1 AND reconciled = false 
       ORDER BY transaction_date`,
      [bankAccountId]
    );
    return result.rows;
  }
}

export default new BankAccountRepository();
