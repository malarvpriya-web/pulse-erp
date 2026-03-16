import pool from '../db.js';

class ChartOfAccountsRepository {
  async create(data) {
    const { code, name, account_type, parent_id, description } = data;
    const result = await pool.query(
      `INSERT INTO chart_of_accounts (code, name, account_type, parent_id, description) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [code, name, account_type, parent_id, description]
    );
    return result.rows[0];
  }

  async findById(id) {
    const result = await pool.query(
      'SELECT * FROM chart_of_accounts WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    return result.rows[0];
  }

  async findAll() {
    const result = await pool.query(
      'SELECT * FROM chart_of_accounts WHERE deleted_at IS NULL ORDER BY code'
    );
    return result.rows;
  }

  async findTree() {
    const result = await pool.query(
      `WITH RECURSIVE account_tree AS (
        SELECT id, code, name, account_type, parent_id, is_active, description, 0 as level
        FROM chart_of_accounts WHERE parent_id IS NULL AND deleted_at IS NULL
        UNION ALL
        SELECT c.id, c.code, c.name, c.account_type, c.parent_id, c.is_active, c.description, at.level + 1
        FROM chart_of_accounts c
        INNER JOIN account_tree at ON c.parent_id = at.id
        WHERE c.deleted_at IS NULL
      )
      SELECT * FROM account_tree ORDER BY code`
    );
    return result.rows;
  }

  async update(id, data) {
    const { name, description, is_active } = data;
    const result = await pool.query(
      `UPDATE chart_of_accounts 
       SET name = $1, description = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $4 AND deleted_at IS NULL RETURNING *`,
      [name, description, is_active, id]
    );
    return result.rows[0];
  }

  async softDelete(id) {
    const result = await pool.query(
      'UPDATE chart_of_accounts SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0];
  }

  async getBalance(accountId, startDate, endDate) {
    const result = await pool.query(
      `SELECT 
        COALESCE(SUM(debit), 0) as total_debit,
        COALESCE(SUM(credit), 0) as total_credit
       FROM journal_entry_lines jel
       JOIN journal_entries je ON jel.journal_entry_id = je.id
       WHERE jel.account_id = $1 
       AND je.entry_date BETWEEN $2 AND $3
       AND je.is_posted = true
       AND je.deleted_at IS NULL`,
      [accountId, startDate, endDate]
    );
    return result.rows[0];
  }
}

export default new ChartOfAccountsRepository();
