// Bank Accounts → Ledger links (§275): pick or create a ledger per bank account, then approve.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
import api from '../services/api/client';
import BankLedgerLinks from '../features/finance/components/BankLedgerLinks.jsx';

const OPTIONS = (over = {}) => ({
  bank_accounts: [{ id: 31, account_name: 'Manifest Current', bank_name: 'HDFC Bank', last4: '4421', ifsc_code: 'HDFC0000123', linked_code: null }],
  bank_ledgers: [],
  payable_accounts: [{ code: '2001', name: 'Accounts Payable' }, { code: '2110', name: 'Accounts Payable' }],
  mapping: { status: 'not_configured', problems: [], bankLedgers: {} },
  ...over,
});

beforeEach(() => { vi.clearAllMocks(); });

describe('BankLedgerLinks', () => {
  it('creates a ledger for a bank account, then approves the link', async () => {
    api.get.mockResolvedValueOnce({ data: OPTIONS() })
      .mockResolvedValueOnce({ data: OPTIONS({ bank_ledgers: [{ code: '1121', name: 'HDFC Bank ••4421' }] }) })
      .mockResolvedValueOnce({ data: OPTIONS({ bank_ledgers: [{ code: '1121', name: 'HDFC Bank ••4421' }], mapping: { status: 'approved', problems: [], bankLedgers: { 31: { code: '1121' } }, payable: { code: '2001' } } }) });
    api.post.mockResolvedValue({ data: { account: { code: '1121', name: 'HDFC Bank ••4421' }, bank_account_id: 31 } });
    api.put.mockResolvedValue({ data: {} });
    const onChanged = vi.fn();
    render(<BankLedgerLinks onChanged={onChanged} />);

    expect(await screen.findByText('Not set up')).toBeTruthy();
    expect(screen.getByLabelText('Accounts payable (supplier payments post against it)')).toHaveValue('2001');
    fireEvent.click(screen.getByRole('button', { name: 'Create ledger' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/finance/accounting/bank-ledger-accounts', { bank_account_id: 31 }));
    await waitFor(() => expect(screen.getByLabelText('Ledger for Manifest Current')).toHaveValue('1121'));

    fireEvent.click(screen.getByRole('button', { name: 'Approve links' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/finance/accounting/payment-gl-mapping', {
      accounts_payable_account_code: '2001', bank_ledgers: { 31: '1121' },
    }));
    expect(await screen.findByText('Approved')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows why an approval was refused', async () => {
    api.get.mockResolvedValue({ data: OPTIONS({ bank_ledgers: [{ code: '1121', name: 'HDFC Bank ••4421' }] }) });
    api.put.mockRejectedValue({ response: { status: 422, data: { message: 'Payment account mapping refused', problems: ['Bank account Manifest Current: ledger account 1121 (HDFC) is inactive'] } } });
    render(<BankLedgerLinks />);
    fireEvent.change(await screen.findByLabelText('Ledger for Manifest Current'), { target: { value: '1121' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve links' }));
    expect(await screen.findByText(/ledger account 1121 \(HDFC\) is inactive/)).toBeTruthy();
  });

  it('refuses to approve with nothing linked', async () => {
    api.get.mockResolvedValue({ data: OPTIONS() });
    render(<BankLedgerLinks />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve links' }));
    expect(await screen.findByText('Choose a ledger account for at least one bank account.')).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();
  });
});
