# Background Verification — page notes

Not loaded by the app. Kept beside the stylesheet so the two BGV pages do not
each have to re-explain the same decisions in a header comment.

## Pages

| Page | Route | What it is |
|---|---|---|
| `BackgroundVerification.jsx` | `/BackgroundVerification` | The module: Dashboard · Employees · Agencies · Costs · Reports |
| `EmployeeBGV.jsx` | `/EmployeeBGV?employee_id=<id>` | One employee's case: summary, checks, documents folder, contact history |

## The two rules the screens have to keep

1. **Status is not Result.** `status` says where the work is (Pending, Initiated,
   In Progress, Completed, Cancelled); `result` says what it found (Pending,
   Clear, Discrepancy, Unable to Verify). They render as two separate badges
   everywhere. A "Completed" check with a Discrepancy result must never read as
   cleared, and the API refuses `status='Completed'` while `result='Pending'`.

2. **A KPI card opens the population it counted.** Each card carries the list
   filter the backend used to count it (`filter` on the dashboard response), and
   clicking it applies exactly that filter to the Employees tab. No card
   navigates to an unfiltered list, and no filter exists that the backend does
   not actually apply.

## Cost display

`money()` in `features/employees/bgv.js`, never `utils/format.js`'s `fmt()`.
`fmt()` is `₹${Number(v ?? 0)}` and renders an uncaptured cost as ₹0 — "not
billed yet" and "no charge" are different facts. `money(null)` is an em-dash.

## Documents

Reports open through `GET /api/files/:filename`, the authenticated + audit-logged
route, fetched as a blob with the JWT attached and shown via an object URL — an
`<a href>` to that path sends no Authorization header and 401s. When the backend
reports `file_present === false` the row says **File not in storage** and the
open button is disabled, rather than offering a link that errors.
