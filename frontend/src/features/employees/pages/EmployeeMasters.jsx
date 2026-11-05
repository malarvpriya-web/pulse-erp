// ──────────────────────────────────────────────────────────────────────────────
// Employee Masters — the HR entry point to the master lists Add Employee uses.
//
// ⚠ THIS IS NOT A SECOND MASTER-DATA IMPLEMENTATION.
//
// It renders `MasterSetup` — the same component, the same tabs, the same
// SimpleListTab, the same `/master/*` endpoints, the same usage counts and the
// same delete-vs-deactivate rules — scoped with `only` to the masters that
// appear on the employee forms. There is one canonical management UI; this is a
// second DOOR into it, in the place HR actually works.
//
// The reason for the door: these lists were reachable only through
// Settings → Master Data, which is an administrator's menu. HR filling in an
// employee should not have to go hunting through Settings to fix a designation
// they just mistyped.
//
// Settings → Master Data is deliberately LEFT INTACT and still shows every
// master, including these. Departments, designations, zones, grades and bands
// are consumed by recruitment, projects, CRM and travel policy as well as HR —
// removing their tabs from the administrator's screen would take the management
// UI away from the people who own those other modules.
//
// ⚠ Branches/Locations are NOT here. A branch is an entity with a code, an
// address, a type and contact details, managed at
// Settings → Company Setup → Branch Management. A name-only editor over it
// would offer a rename that silently drops everything else.
// ──────────────────────────────────────────────────────────────────────────────
import MasterSetup, { EMPLOYEE_MASTER_TABS } from '@/features/admin/pages/MasterSetup';

export default function EmployeeMasters({ urlParams }) {
  return (
    <MasterSetup
      urlParams={urlParams}
      only={EMPLOYEE_MASTER_TABS}
      hero={{
        eyebrow: 'Employees',
        title: 'Employee Masters',
        subtitle:
          'The lists behind the Add Employee pickers — add, rename, deactivate or ' +
          'remove the values HR uses. Locations are managed under Company Setup → Branch Management.',
      }}
    />
  );
}
