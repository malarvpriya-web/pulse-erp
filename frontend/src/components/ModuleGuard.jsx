import { lazy, Suspense } from 'react';
import { useModuleRegistry } from '@/hooks/useModuleRegistry';

const Unauthorized = lazy(() => import('@/pages/Unauthorized'));

/**
 * ModuleGuard — wraps a page and checks registry permission.
 *
 * Props:
 *   moduleId  — registry id to check (e.g. 'finance', 'finance.dashboard')
 *   setPage   — passed to Unauthorized so the user can navigate away
 *   children  — page content to render when access is granted
 */
export default function ModuleGuard({ moduleId, setPage, children }) {
  const { hasAccess } = useModuleRegistry();

  if (!hasAccess(moduleId)) {
    return (
      <Suspense fallback={null}>
        <Unauthorized setPage={setPage} />
      </Suspense>
    );
  }

  return children;
}
