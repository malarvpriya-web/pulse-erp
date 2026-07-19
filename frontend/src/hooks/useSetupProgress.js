import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';

const DEFAULT_PROGRESS = {
  setup_complete: false,
  steps: {
    company:      { done: false, skipped: false },
    organization: { done: false, skipped: false },
    users:        { done: false, skipped: false },
    roles:        { done: false, skipped: false },
    payroll:      { done: false, skipped: false },
    finance:      { done: false, skipped: false },
    leaves:       { done: false, skipped: false },
    integrations: { done: false, skipped: false },
  },
};

export function useSetupProgress() {
  const [progress, setProgress] = useState(() => {
    try {
      const cached = sessionStorage.getItem('setup_progress_cache');
      return cached ? JSON.parse(cached) : DEFAULT_PROGRESS;
    } catch {
      return DEFAULT_PROGRESS;
    }
  });
  const [wizardStatus,   setWizardStatus]   = useState(null);
  const [settingsStatus, setSettingsStatus] = useState(null);
  const [isLoading,      setIsLoading]      = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    try {
      const [progressRes, wizRes, settingsRes] = await Promise.allSettled([
        api.get('/settings/setup-progress'),
        api.get('/wizard/status'),
        api.get('/settings/status'),
      ]);

      let wizData = null;
      if (wizRes.status === 'fulfilled') {
        wizData = wizRes.value.data;
        setWizardStatus(wizData);
      }

      if (progressRes.status === 'fulfilled' || wizData) {
        const apiData = progressRes.status === 'fulfilled' ? (progressRes.value.data || {}) : {};
        // Derive step completion from wizard status (live table counts) when available
        const wSteps = wizData?.steps || {};
        const derivedSteps = {
          company:      { done: !!(wSteps.company_profile?.done || wSteps.departments?.done),   skipped: false },
          organization: { done: !!(wSteps.designations?.done),                                  skipped: false },
          users:        { done: !!(wSteps.users?.done),                                         skipped: false },
          roles:        { done: !!(wSteps.users?.done && wSteps.designations?.done),            skipped: false },
          payroll:      { done: !!(wSteps.salary_structures?.done),                             skipped: false },
          finance:      { done: false,                                                           skipped: false },
          leaves:       { done: !!(wSteps.leave_types?.done),                                   skipped: false },
          integrations: { done: !!(wSteps.attendance_setup?.done),                              skipped: false },
        };
        const merged = {
          ...DEFAULT_PROGRESS,
          ...apiData,
          setup_complete: apiData.completed || wizData?.completed || false,
          steps: derivedSteps,
        };
        setProgress(merged);
        sessionStorage.setItem('setup_progress_cache', JSON.stringify(merged));
      }

      if (settingsRes.status === 'fulfilled') setSettingsStatus(settingsRes.value.data);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const markStepDone = useCallback(async (stepKey) => {
    try { await api.post('/settings/setup-progress', { step: stepKey, done: true }); } catch { /* optimistic */ }
    setProgress(prev => {
      const next = { ...prev, steps: { ...prev.steps, [stepKey]: { ...prev.steps[stepKey], done: true } } };
      sessionStorage.setItem('setup_progress_cache', JSON.stringify(next));
      return next;
    });
    await refetch();
  }, [refetch]);

  const skipStep = useCallback(async (stepKey) => {
    try { await api.post('/settings/setup-progress', { step: stepKey, skipped: true }); } catch { /* ignore */ }
    setProgress(prev => {
      const next = { ...prev, steps: { ...prev.steps, [stepKey]: { ...prev.steps[stepKey], skipped: true } } };
      sessionStorage.setItem('setup_progress_cache', JSON.stringify(next));
      return next;
    });
    await refetch();
  }, [refetch]);

  const isComplete = progress.setup_complete ||
    Object.values(progress.steps).every(s => s.done || s.skipped);

  return {
    // Primary API (settings/pages/* + settings/pages/SetupWizard)
    progress,
    isLoading,
    isComplete,
    refetch,
    markStepDone,
    skipStep,
    // Extended API (admin/pages/SetupDashboard)
    wizardStatus,
    settingsStatus,
    loading: isLoading,
    refresh: refetch,
  };
}
