import { useParams } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { getSectionForPage } from '@/config/menuCatalog';

/**
 * usePageAccess — resolves the admin-configured Page Access level for the page
 * currently rendered, so any page can enforce read-only behaviour.
 *
 * Returns:
 *   access   — 'hidden' | 'view' | 'edit' | null  (null = no override / default)
 *   readOnly — true when the section is restricted to View (block create/edit/delete)
 *   canEdit  — convenience negation of readOnly
 *   section  — the NAV section name this page belongs to (or null)
 *
 * Usage:
 *   const { readOnly } = usePageAccess();
 *   <button disabled={readOnly} ...>Add</button>
 *   {readOnly && <ReadOnlyBanner />}
 */
export function usePageAccess(pageOverride) {
  const { page: routePage } = useParams();
  const { menuAccess } = useAuth();

  const page    = pageOverride || routePage || 'Home';
  const section = getSectionForPage(page);
  const access  = section ? menuAccess(section) : null;

  return {
    access,
    section,
    readOnly: access === 'view',
    canEdit:  access !== 'view',
  };
}

export default usePageAccess;
