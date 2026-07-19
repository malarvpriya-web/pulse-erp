import { create } from 'zustand';

/**
 * Global App Store for shared entity selection and cross-module state.
 * Reduces prop-drilling in Layout and App.
 */
const useAppStore = create((set) => ({
  // Shared Selections
  selectedEmployee: null,
  setSelectedEmployee: (employee) => set({ selectedEmployee: employee }),
  
  selectedProduction: null,
  setSelectedProduction: (production) => set({ selectedProduction: production }),

  selectedCandidateId: null,
  setSelectedCandidateId: (id) => set({ selectedCandidateId: id }),

  selectedJobId: null,
  setSelectedJobId: (id) => set({ selectedJobId: id }),

  selectedProject: null,
  setSelectedProject: (project) => set({ selectedProject: project }),

  // UI State
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  
  // Notification Indicator (Quick Ref)
  unreadNotifications: 0,
  setUnreadNotifications: (count) => set({ unreadNotifications: count }),
  
  // Utility: Reset Selections (When moving between unrelated modules)
  clearSelections: () => set({ 
    selectedEmployee: null, 
    selectedProduction: null, 
    selectedProject: null 
  }),
}));

export default useAppStore;
