import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub localStorage before importing the module
const store = {};
vi.stubGlobal('localStorage', {
  getItem:    (k) => store[k] ?? null,
  setItem:    (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
  clear:      () => { Object.keys(store).forEach(k => delete store[k]); },
});

// Import AFTER stubs are in place
const { default: api } = await import('@/services/api/client');

describe('api client', () => {
  beforeEach(() => localStorage.clear());

  it('base URL defaults to localhost:5000/api', () => {
    expect(api.defaults.baseURL).toContain('localhost:5000/api');
  });

  it('request interceptor adds Bearer token when present', async () => {
    localStorage.setItem('token', 'abc123');
    const handler = api.interceptors.request.handlers.at(-1);
    const cfg = await handler.fulfilled({ headers: {} });
    expect(cfg.headers.Authorization).toBe('Bearer abc123');
  });

  it('request interceptor skips Authorization when no token', async () => {
    const handler = api.interceptors.request.handlers.at(-1);
    const cfg = await handler.fulfilled({ headers: {} });
    expect(cfg.headers.Authorization).toBeUndefined();
  });

  it('response interceptor clears auth keys on 401 from protected endpoint', async () => {
    // No token in storage → hardLogout() fires immediately without a refresh attempt
    localStorage.setItem('user', '{}');
    const handler = api.interceptors.response.handlers.at(-1);
    const err = { response: { status: 401 }, config: { url: '/some/protected' } };
    await expect(handler.rejected(err)).rejects.toBe(err);
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('response interceptor does NOT clear storage on 401 from login endpoint', async () => {
    localStorage.setItem('token', 'tok');
    const handler = api.interceptors.response.handlers.at(-1);
    // Wrong-password 401 — must not wipe the existing session or redirect
    const err = { response: { status: 401 }, config: { url: '/auth/login' } };
    await expect(handler.rejected(err)).rejects.toBe(err);
    expect(localStorage.getItem('token')).toBe('tok');
  });

  it('response interceptor wraps 403 with actionable default message', async () => {
    const handler = api.interceptors.response.handlers.at(-1);
    const err = { response: { status: 403, data: {} }, config: { url: '/some/resource' } };
    await expect(handler.rejected(err)).rejects.toMatchObject({
      message: 'You do not have permission to perform this action.',
      status:  403,
    });
  });

  it('response interceptor uses server message for 403 when provided', async () => {
    const handler = api.interceptors.response.handlers.at(-1);
    const err = {
      response: { status: 403, data: { message: 'Feature not licensed' } },
      config:   { url: '/some/resource' },
    };
    await expect(handler.rejected(err)).rejects.toMatchObject({
      message: 'Feature not licensed',
      status:  403,
    });
  });

  it('response interceptor wraps 500 with user-friendly default message', async () => {
    const handler = api.interceptors.response.handlers.at(-1);
    const err = { response: { status: 500, data: {} }, config: { url: '/some/endpoint' } };
    await expect(handler.rejected(err)).rejects.toMatchObject({
      message: 'A server error occurred. Please try again later.',
      status:  500,
    });
  });

  it('response interceptor uses server message for 5xx when provided', async () => {
    const handler = api.interceptors.response.handlers.at(-1);
    const err = {
      response: { status: 503, data: { message: 'Service unavailable' } },
      config:   { url: '/some/endpoint' },
    };
    await expect(handler.rejected(err)).rejects.toMatchObject({
      message: 'Service unavailable',
      status:  503,
    });
  });

  it('response interceptor passes through 4xx errors unchanged', async () => {
    const handler = api.interceptors.response.handlers.at(-1);
    const err = {
      response: { status: 422, data: { message: 'Validation failed' } },
      config:   { url: '/some/endpoint' },
    };
    await expect(handler.rejected(err)).rejects.toBe(err);
  });
});
