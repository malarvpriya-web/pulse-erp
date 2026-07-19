/**
 * Form submission hook.
 * Handles loading, success, error states.
 */
import { useState, useCallback } from 'react';
import api from '../api/client';

export function useFormSubmit(options = {}) {
  const {
    onSuccess,
    onError,
    successMessage: _successMessage = 'Saved successfully',
    resetOnSuccess: _resetOnSuccess = true,
  } = options;

  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [success,     setSuccess]     = useState(false);

  const submit = useCallback(async (method, endpoint, data, extra = {}) => {
    setSubmitting(true);
    setSubmitError(null);
    setSuccess(false);
    try {
      const res = await api[method](endpoint, data, extra);
      setSuccess(true);
      onSuccess?.(res.data);
      return { ok: true, data: res.data };
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Submission failed';
      setSubmitError(msg);
      onError?.(err);
      return { ok: false, error: msg };
    } finally {
      setSubmitting(false);
    }
  }, [onSuccess, onError]);

  const reset = useCallback(() => {
    setSubmitError(null);
    setSuccess(false);
  }, []);

  return { submit, submitting, submitError, success, reset };
}
