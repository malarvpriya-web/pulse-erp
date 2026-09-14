/**
 * 20260910000002_dashboard_builder.js
 *
 * The dashboard builder: the table it was always missing.
 *
 * WHAT WAS THERE
 * --------------
 * `intelligence.routes.js` carries a section headed DASHBOARD BUILDER with four
 * endpoints doing full CRUD over `dashboard_widgets` — widget type, name, a
 * `query_config` payload and x/y/w/h geometry. The BI parity audit called it
 * "a stub, not a feature". It was worse than that:
 *
 *   - `dashboard_widgets` has never existed in any migration;
 *   - the routes are short-circuited to 501 before the handlers run, by the
 *     UNBACKED_PREFIXES guard at the top of that file;
 *   - `react-grid-layout` sits in package.json with zero imports;
 *   - no frontend file calls the endpoints.
 *
 * So the product claimed self-service authoring and shipped four routes that
 * answered "not implemented" over a table that was never built.
 *
 * WHY query_config IS NOT SQL
 * ---------------------------
 * The obvious way to finish this is to let `query_config` carry a SQL string and
 * execute it. That is not a dashboard builder, it is an authenticated SQL
 * console: a WHERE clause the user wrote does not carry `company_id`, so the
 * feature would defeat tenant scoping; it would defeat RBAC, because payroll
 * figures would be reachable from a procurement dashboard; and it would hand
 * every reader the file-reading functions.
 *
 * `query_config` therefore NAMES a metric from `shared/metricRegistry.js` and
 * never describes one. It is validated on write and again on read — on read as
 * well, because a metric can be retired after a widget was saved, and a widget
 * pointing at a metric that no longer exists must say so rather than render an
 * empty chart. The CHECK constraint below enforces only the shape; the registry
 * enforces the meaning.
 *
 * TWO TABLES, NOT ONE
 * -------------------
 * The original single-table design hung widgets off `user_id` with no board, so
 * every user had exactly one implicit dashboard and nothing could be shared.
 * `dashboards` gives a board an owner, a company and a visibility, and
 * `dashboard_widgets` hangs off the board. Sharing is a column here rather than
 * a feature bolted on later, because retrofitting one onto a user-keyed table
 * means rewriting every row's ownership.
 *
 * ⚠ company_id is NOT NULL on `dashboards`. A row with a NULL company is
 * invisible to every scoped user (`company_id = $1` never matches NULL) while
 * being visible to a global super-admin — the "NULL scoping" trap this codebase
 * has hit repeatedly. A dashboard with no tenant is not a useful object.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // ── boards ────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS dashboards (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      owner_user_id INTEGER      REFERENCES users(id) ON DELETE SET NULL,
      name          VARCHAR(200) NOT NULL,
      description   TEXT,

      -- 'private'  — only the owner
      -- 'company'  — anyone in the company who holds the permissions the
      --              widgets' own metrics require. Visibility is never a way
      --              PAST a permission: the executor re-checks every widget's
      --              metric permission per viewer, so a shared board shows a
      --              viewer only the tiles they could have built themselves.
      visibility    VARCHAR(20)  NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'company')),

      is_default    BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at    TIMESTAMPTZ
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dashboards_company ON dashboards(company_id) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dashboards_owner   ON dashboards(owner_user_id) WHERE deleted_at IS NULL`);

  // ── widgets ───────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS dashboard_widgets (
      id            SERIAL PRIMARY KEY,
      dashboard_id  INTEGER      NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      company_id    INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

      title         VARCHAR(200) NOT NULL,

      -- Mirrors metricRegistry.CHART_TYPES. Kept as a CHECK rather than a
      -- lookup table because the set is owned by the renderer: a chart type the
      -- React side cannot draw must not be storable.
      chart_type    VARCHAR(30)  NOT NULL DEFAULT 'bar'
                    CHECK (chart_type IN ('bar','column','line','area','pie','donut',
                                          'treemap','waterfall','scatter','funnel',
                                          'kpi','table')),

      -- { metric, dimension, from, to, limit, chart_type }. Shape enforced
      -- here; MEANING enforced by validateQueryConfig() against the registry,
      -- on write and again on read.
      query_config  JSONB        NOT NULL,

      -- Grid geometry. react-grid-layout is already a dependency and had zero
      -- imports; these are the columns it binds to.
      position_x    INTEGER      NOT NULL DEFAULT 0,
      position_y    INTEGER      NOT NULL DEFAULT 0,
      width         INTEGER      NOT NULL DEFAULT 4 CHECK (width  BETWEEN 1 AND 12),
      height        INTEGER      NOT NULL DEFAULT 3 CHECK (height BETWEEN 1 AND 24),

      is_visible    BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

      CONSTRAINT dashboard_widgets_query_config_is_object
        CHECK (jsonb_typeof(query_config) = 'object'),
      CONSTRAINT dashboard_widgets_query_config_names_metric
        CHECK (query_config ? 'metric')
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_widgets_dashboard ON dashboard_widgets(dashboard_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_widgets_company   ON dashboard_widgets(company_id)`);

  // A widget must belong to the same tenant as its board. Without this a widget
  // row could name company 2 while hanging off company 1's dashboard, and the
  // board-level scope check would pass it through.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION dashboard_widget_company_matches() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.company_id IS DISTINCT FROM
         (SELECT company_id FROM dashboards WHERE id = NEW.dashboard_id) THEN
        RAISE EXCEPTION 'widget company_id % does not match its dashboard', NEW.company_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_widget_company_matches ON dashboard_widgets`);
  await knex.raw(`
    CREATE TRIGGER trg_widget_company_matches
      BEFORE INSERT OR UPDATE ON dashboard_widgets
      FOR EACH ROW EXECUTE FUNCTION dashboard_widget_company_matches()
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_widget_company_matches ON dashboard_widgets`);
  await knex.raw(`DROP FUNCTION IF EXISTS dashboard_widget_company_matches()`);
  await knex.raw(`DROP TABLE IF EXISTS dashboard_widgets`);
  await knex.raw(`DROP TABLE IF EXISTS dashboards`);
}
