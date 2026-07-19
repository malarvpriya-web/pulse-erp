import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level mock — hoisted before imports
vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import api from '../services/api/client';
import { getExEmployees, getEmployee, getEmployees } from '../services/employeeService.js';

beforeEach(() => vi.clearAllMocks());

describe('employeeService.getExEmployees — uses /employees/ex', () => {
  it('calls /employees/ex (not /employees?status=Left)', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    await getExEmployees();
    expect(api.get).toHaveBeenCalledWith('/employees/ex', { params: {} });
    expect(api.get).not.toHaveBeenCalledWith('/employees', expect.anything());
  });

  it('passes exit_date_from filter', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    await getExEmployees({ exit_date_from: '2025-01-01' });
    expect(api.get).toHaveBeenCalledWith('/employees/ex', {
      params: { exit_date_from: '2025-01-01' },
    });
  });

  it('passes both date filters', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    await getExEmployees({ exit_date_from: '2025-01-01', exit_date_to: '2025-12-31' });
    expect(api.get).toHaveBeenCalledWith('/employees/ex', {
      params: { exit_date_from: '2025-01-01', exit_date_to: '2025-12-31' },
    });
  });

  it('returns empty array when API fails', async () => {
    api.get.mockRejectedValueOnce(new Error('Network error'));
    const result = await getExEmployees();
    expect(result).toEqual([]);
  });

  it('returns array from response data', async () => {
    const mockData = [{ id: 1, first_name: 'Arun', status: 'left' }];
    api.get.mockResolvedValueOnce({ data: mockData });
    const result = await getExEmployees();
    expect(result).toEqual(mockData);
  });
});

describe('employeeService.getEmployee', () => {
  it('calls /employees/:id', async () => {
    api.get.mockResolvedValueOnce({ data: { id: 42, first_name: 'Arun' } });
    const result = await getEmployee(42);
    expect(api.get).toHaveBeenCalledWith('/employees/42');
    expect(result.id).toBe(42);
  });

  it('returns null when API fails', async () => {
    api.get.mockRejectedValueOnce(new Error('404'));
    const result = await getEmployee(999);
    expect(result).toBeNull();
  });
});

describe('employeeService.getEmployees', () => {
  it('calls /employees and returns array', async () => {
    api.get.mockResolvedValueOnce({ data: [{ id: 1 }, { id: 2 }] });
    const result = await getEmployees();
    expect(api.get).toHaveBeenCalledWith('/employees', { params: {} });
    expect(result.map(e => e.id)).toEqual([1, 2]);
  });

  // The service derives a display `name` from first_name/last_name — callers
  // depend on it, so it is part of the contract, not incidental.
  it('derives a display name from first_name/last_name', async () => {
    api.get.mockResolvedValueOnce({ data: [{ id: 1, first_name: 'Arun', last_name: 'Kumar' }] });
    const result = await getEmployees();
    expect(result[0].name).toBe('Arun Kumar');
  });

  it('leaves an existing name untouched', async () => {
    api.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'Priya Nair', first_name: 'Priya' }] });
    const result = await getEmployees();
    expect(result[0].name).toBe('Priya Nair');
  });

  it('returns empty array on failure', async () => {
    api.get.mockRejectedValueOnce(new Error('fail'));
    const result = await getEmployees();
    expect(result).toEqual([]);
  });
});
