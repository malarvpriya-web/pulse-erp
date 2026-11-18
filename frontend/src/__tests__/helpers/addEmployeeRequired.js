import { fireEvent, screen } from '@testing-library/react';

/**
 * Current address, bank account number and IFSC are required on Add Employee
 * since §202; a new account also needs the account-holder name and a cancelled
 * cheque or bank statement (§267). They live in the Address and Bank Details
 * accordion sections (one section is open at a time), so open each and fill it.
 * Leaves the Bank Details section open — call it last, right before Save.
 * `proof: false` leaves the holder name and cheque out.
 */
export function fillBankAndAddress({ address = '1 Fixture Street', account = '123456789012', ifsc = 'HDFC0001234',
  holder = 'Ravi Kumar', proof = true } = {}) {
  fireEvent.click(screen.getByText('Address', { selector: '.accordion-header h2' }));
  fireEvent.change(document.getElementById('ae-current-address'), { target: { value: address } });
  fireEvent.click(screen.getByText('Bank Details', { selector: '.accordion-header h2' }));
  fireEvent.change(document.getElementById('ae-account-number'), { target: { value: account } });
  fireEvent.change(document.getElementById('ae-ifsc'), { target: { value: ifsc } });
  if (proof) {
    fireEvent.change(document.getElementById('ae-account-holder'), { target: { value: holder } });
    const cheque = new File(['%PDF'], 'cheque.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Cancelled cheque'), { target: { files: [cheque] } });
  }
}
