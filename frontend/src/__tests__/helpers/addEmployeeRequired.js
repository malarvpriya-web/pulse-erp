import { fireEvent, screen } from '@testing-library/react';

/**
 * Current address, bank account number and IFSC are required on Add Employee
 * since §202. They live in the Address and Bank Details accordion sections
 * (one section is open at a time), so open each and fill it. Leaves the Bank
 * Details section open — call it last, right before Save.
 */
export function fillBankAndAddress({ address = '1 Fixture Street', account = '123456789012', ifsc = 'HDFC0001234' } = {}) {
  fireEvent.click(screen.getByText('Address', { selector: '.accordion-header h2' }));
  fireEvent.change(document.getElementById('ae-current-address'), { target: { value: address } });
  fireEvent.click(screen.getByText('Bank Details', { selector: '.accordion-header h2' }));
  fireEvent.change(document.getElementById('ae-account-number'), { target: { value: account } });
  fireEvent.change(document.getElementById('ae-ifsc'), { target: { value: ifsc } });
}
