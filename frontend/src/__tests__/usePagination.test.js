import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePagination } from '@/features/_shared/usePagination';

const range = (n) => Array.from({ length: n }, (_, i) => i);

describe('usePagination', () => {
  it('returns first page slice of correct size', () => {
    const { result } = renderHook(() => usePagination(range(50), 20));
    expect(result.current.slice).toHaveLength(20);
    expect(result.current.slice[0]).toBe(0);
    expect(result.current.totalPages).toBe(3);
    expect(result.current.total).toBe(50);
  });

  it('next() advances the page', () => {
    const { result } = renderHook(() => usePagination(range(50), 20));
    act(() => result.current.next());
    expect(result.current.page).toBe(2);
    expect(result.current.slice[0]).toBe(20);
  });

  it('prev() moves back and clamps at 1', () => {
    const { result } = renderHook(() => usePagination(range(50), 20));
    act(() => result.current.next());
    act(() => result.current.prev());
    expect(result.current.page).toBe(1);
    act(() => result.current.prev());
    expect(result.current.page).toBe(1);
  });

  it('next() clamps at last page', () => {
    const { result } = renderHook(() => usePagination(range(10), 20));
    act(() => result.current.next());
    expect(result.current.page).toBe(1);
    expect(result.current.totalPages).toBe(1);
  });

  it('goTo() navigates to any page', () => {
    const { result } = renderHook(() => usePagination(range(60), 20));
    act(() => result.current.goTo(3));
    expect(result.current.page).toBe(3);
    expect(result.current.slice[0]).toBe(40);
    expect(result.current.slice).toHaveLength(20);
  });

  it('goTo() clamps out-of-range values', () => {
    const { result } = renderHook(() => usePagination(range(40), 20));
    act(() => result.current.goTo(99));
    expect(result.current.page).toBe(2);
    act(() => result.current.goTo(-5));
    expect(result.current.page).toBe(1);
  });

  it('reset() returns to page 1', () => {
    const { result } = renderHook(() => usePagination(range(60), 20));
    act(() => result.current.goTo(3));
    act(() => result.current.reset());
    expect(result.current.page).toBe(1);
    expect(result.current.slice[0]).toBe(0);
  });

  it('handles empty array', () => {
    const { result } = renderHook(() => usePagination([]));
    expect(result.current.slice).toHaveLength(0);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.total).toBe(0);
  });

  it('handles null/undefined data', () => {
    const { result } = renderHook(() => usePagination(null));
    expect(result.current.slice).toHaveLength(0);
    expect(result.current.totalPages).toBe(1);
  });

  it('last page contains remainder items', () => {
    const { result } = renderHook(() => usePagination(range(45), 20));
    act(() => result.current.goTo(3));
    expect(result.current.slice).toHaveLength(5);
  });

  it('setPageSize() resizes the slice and recomputes totalPages', () => {
    const { result } = renderHook(() => usePagination(range(50), 20));
    act(() => result.current.setPageSize(10));
    expect(result.current.pageSize).toBe(10);
    expect(result.current.slice).toHaveLength(10);
    expect(result.current.totalPages).toBe(5);
  });

  it('setPageSize() returns to page 1 so the offset cannot go stale', () => {
    const { result } = renderHook(() => usePagination(range(50), 20));
    act(() => result.current.goTo(3));
    act(() => result.current.setPageSize(10));
    expect(result.current.page).toBe(1);
    expect(result.current.slice[0]).toBe(0);
  });
});
