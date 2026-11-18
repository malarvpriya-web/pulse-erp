/**
 * 20261112000001_succession_production_ready.js
 *
 * Succession Center production pass (2026-11-12).
 *
 * 1. Foreign keys to employees. No succession table had one, so a removed
 *    employee (id 4 in Manifest) left rows that every count included and every
 *    list dropped: a role read "1 candidate" over an empty candidate list. Owned
 *    rows CASCADE with their employee; optional references (role holder, action
 *    owner, alert subject) SET NULL. Each key is added NOT VALID, so new rows are
 *    checked at once, and VALIDATEd when no existing row breaks it. A database
 *    that still holds orphans keeps the NOT VALID key and says so in a NOTICE.
 *
 * 2. Vocabularies as CHECKs, the same lists the routes enforce (added the same
 *    way: NOT VALID, validated when clean). Mentoring gains 'cancelled'.
 *
 * 3. mentoring_sessions: one row per mentoring session. session_count and
 *    next_session_date on the assignment are kept in step by the routes.
 *
 * 4. Readiness has ONE source: talent_assessments.readiness (the 9-box rating).
 *    succession_plans.readiness_level and leadership_pipeline_entries.readiness
 *    are no longer read or written; the columns stay for history and are
 *    commented as deprecated.
 *
 * 5. Employee leaving or serving notice → succession alert + notification.
 *    An AFTER UPDATE trigger on employees, so every path that ends employment
 *    (Exit Management, offboarding, the status change, the soft delete, the exit
 *    status cron, probation) is covered without each one remembering to call it.
 *    When an employee who appears anywhere in Succession moves INTO an exited
 *    status (or is soft-deleted), or INTO notice, one succession_alerts row
 *    lists every place they appear, and every recipient gets a notification.
 *    Recipients: active users of the company who can view Succession (user
 *    override first, else any held role), limited to Settings → Notification
 *    Recipients when that list is not empty. A failure inside the trigger is
 *    caught and raised as a WARNING: recording an exit must never fail because
 *    of a notification.
 *    The exited/notice spellings are employeeStatus.js EXITED_STATUSES /
 *    NOTICE_STATUSES; a test checks the two agree.
 *
 * 6. notify_roles: the default named 'chro' and 'hr_admin', which no company has,
 *    and nothing read it. It now decides who is notified, so a row still holding
 *    the untouched default becomes the roles that can open Succession, and codes
 *    that are not roles are dropped.
 */

const EXITED = ['left', 'inactive', 'terminated', 'resigned', 'ex-employee', 'ex employee', 'exited', 'relieved', 'absconded'];
const NOTICE = ['notice', 'notice_period', 'notice period'];
const arr = (xs) => `ARRAY[${xs.map(x => `'${x}'`).join(',')}]::text[]`;

const EMPLOYEE_FKS = [
  // [table, column, on delete]
  ['talent_assessments',          'employee_id',           'CASCADE'],
  ['talent_assessment_history',   'employee_id',           'CASCADE'],
  ['succession_perf_sync_log',    'employee_id',           'CASCADE'],
  ['succession_plans',            'candidate_employee_id', 'CASCADE'],
  ['critical_roles',              'current_holder_id',     'SET NULL'],
  ['leadership_pipeline_entries', 'employee_id',           'CASCADE'],
  ['development_plans',           'employee_id',           'CASCADE'],
  ['development_actions',         'owner_employee_id',     'SET NULL'],
  ['mentoring_assignments',       'mentee_employee_id',    'CASCADE'],
  ['mentoring_assignments',       'mentor_employee_id',    'CASCADE'],
  ['employee_pool_members',       'employee_id',           'CASCADE'],
  ['succession_alerts',           'employee_id',           'SET NULL'],
];

const CHECKS = [
  // [table, name, expression]
  ['talent_assessments', 'chk_ta_flight_risk', `flight_risk IN ('low','medium','high')`],
  ['talent_assessments', 'chk_ta_readiness',   `readiness IS NULL OR readiness IN ('ready-now','1-2-years','3-5-years','not_ready')`],
  ['talent_assessments', 'chk_ta_mobility',    `mobility IS NULL OR mobility IN ('flexible','local_only','regional','international','remote_only')`],
  ['critical_roles',     'chk_cr_risk_level',  `risk_level IN ('low','medium','high')`],
  ['development_plans',  'chk_dp_status',      `status IN ('active','paused','completed','cancelled')`],
  ['development_actions', 'chk_da_status',     `status IN ('pending','in_progress','completed','cancelled')`],
  ['development_actions', 'chk_da_type',       `action_type IN ('task','training','stretch_assignment','mentoring','project','certification','secondment')`],
  ['mentoring_assignments', 'chk_ma_status',   `status IN ('active','completed','cancelled')`],
  ['mentoring_assignments', 'chk_ma_distinct', `mentee_employee_id <> mentor_employee_id`],
  ['employee_talent_pools', 'chk_etp_type',    `pool_type IN ('leadership','technical','hipo','project_leaders','graduate','general')`],
  ['leadership_pipeline_entries', 'chk_lpe_status', `status IN ('active','inactive','promoted','exited')`],
  ['succession_plans',   'chk_sp_successor_type', `successor_type IS NULL OR successor_type IN ('primary','secondary','tertiary','emergency')`],
];

/** Add a constraint NOT VALID, then validate it if no existing row breaks it. */
async function addGuarded(knex, table, name, definition) {
  await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`);
  await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition} NOT VALID`);
  await knex.raw(`
    DO $v$
    BEGIN
      ALTER TABLE ${table} VALIDATE CONSTRAINT ${name};
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      RAISE NOTICE 'succession: % on % left NOT VALID: existing rows break it (new rows are checked)', '${name}', '${table}';
    END
    $v$`);
}

export async function up(knex) {
  // 1. Foreign keys
  for (const [t, col, onDelete] of EMPLOYEE_FKS) {
    await addGuarded(knex, t, `fk_${t}_${col}`.slice(0, 63),
      `FOREIGN KEY (${col}) REFERENCES employees(id) ON DELETE ${onDelete}`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${`ix_${t}_${col}`.slice(0, 63)} ON ${t} (${col})`);
  }

  // 2. Vocabularies
  for (const [t, name, expr] of CHECKS) await addGuarded(knex, t, name, `CHECK (${expr})`);

  // 3. Mentoring sessions
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS mentoring_sessions (
      id                 SERIAL PRIMARY KEY,
      assignment_id      INTEGER NOT NULL REFERENCES mentoring_assignments(id) ON DELETE CASCADE,
      session_date       DATE NOT NULL,
      duration_minutes   INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 1440),
      topic              VARCHAR(200),
      notes              TEXT,
      next_session_date  DATE,
      company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_mentoring_sessions_assignment ON mentoring_sessions (assignment_id, session_date DESC)`);

  // Alerts: what an employee-left alert lists, and a fast unread count.
  await knex.raw(`ALTER TABLE succession_alerts ADD COLUMN IF NOT EXISTS details JSONB`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_succession_alerts_unread ON succession_alerts (company_id, is_read, created_at DESC)`);

  // 4. Readiness: one source
  await knex.raw(`COMMENT ON COLUMN succession_plans.readiness_level IS
    'DEPRECATED 2026-11-12: not read or written. Readiness comes from talent_assessments.readiness.'`);
  await knex.raw(`COMMENT ON COLUMN leadership_pipeline_entries.readiness IS
    'DEPRECATED 2026-11-12: not read or written. Readiness comes from talent_assessments.readiness.'`);

  // 6. notify_roles
  await knex.raw(`ALTER TABLE succession_settings ALTER COLUMN notify_roles SET DEFAULT '[]'::jsonb`);
  await knex.raw(`
    UPDATE succession_settings s SET notify_roles = COALESCE((
      SELECT jsonb_agg(code ORDER BY code) FROM (
        SELECT DISTINCT LOWER(r.code) AS code FROM roles r
          JOIN role_permissions rp ON rp.role_id = r.id AND rp.module = 'succession' AND rp.can_view
      ) v), '[]'::jsonb)
     WHERE s.notify_roles @> '["chro","hr_admin","hr_manager"]'::jsonb
       AND jsonb_array_length(s.notify_roles) = 3`);
  await knex.raw(`
    UPDATE succession_settings s SET notify_roles = COALESCE((
      SELECT jsonb_agg(x ORDER BY x) FROM jsonb_array_elements_text(s.notify_roles) x
       WHERE EXISTS (SELECT 1 FROM roles r WHERE LOWER(r.code) = LOWER(x))), '[]'::jsonb)`);

  // 5. Employee leaving → alert + notifications
  await knex.raw(`
    CREATE OR REPLACE FUNCTION succession_employment_phase(p_status text, p_deleted timestamp)
    RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
      SELECT CASE
        WHEN p_deleted IS NOT NULL OR LOWER(BTRIM(COALESCE(p_status, ''))) = ANY(${arr(EXITED)}) THEN 'left'
        WHEN LOWER(BTRIM(COALESCE(p_status, ''))) = ANY(${arr(NOTICE)}) THEN 'notice'
        ELSE 'employed' END
    $fn$`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION succession_notify_employee_change()
    RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      v_phase   text := succession_employment_phase(NEW.status, NEW.deleted_at);
      v_cid     integer := NEW.company_id;
      v_items   jsonb := '[]'::jsonb;
      v_lines   text[] := ARRAY[]::text[];
      v_role    integer;
      v_sev     text := 'warning';
      v_title   text;
      v_msg     text;
      v_alert   integer;
      v_roles   jsonb;
      r         record;
    BEGIN
      IF v_cid IS NULL OR NEW.is_test THEN RETURN NULL; END IF;

      BEGIN
        FOR r IN SELECT id, role_title FROM critical_roles WHERE current_holder_id = NEW.id AND company_id = v_cid ORDER BY id LOOP
          v_items := v_items || jsonb_build_object('kind', 'role_holder', 'id', r.id, 'label', r.role_title);
          v_lines := v_lines || ('holds the critical role "' || r.role_title || '"');
          v_role := COALESCE(v_role, r.id); v_sev := 'critical';
        END LOOP;
        FOR r IN SELECT cr.id, cr.role_title, sp.rank FROM succession_plans sp JOIN critical_roles cr ON cr.id = sp.critical_role_id
                  WHERE sp.candidate_employee_id = NEW.id AND sp.company_id = v_cid ORDER BY sp.rank, cr.id LOOP
          v_items := v_items || jsonb_build_object('kind', 'successor', 'id', r.id, 'label', r.role_title, 'rank', r.rank);
          v_lines := v_lines || ('successor #' || r.rank || ' for "' || r.role_title || '"');
          v_role := COALESCE(v_role, r.id);
          IF r.rank = 1 THEN v_sev := 'critical'; END IF;
        END LOOP;
        FOR r IN SELECT lpe.id, cl.level_name FROM leadership_pipeline_entries lpe LEFT JOIN leadership_pipeline_levels cl ON cl.id = lpe.current_level_id
                  WHERE lpe.employee_id = NEW.id AND lpe.company_id = v_cid AND lpe.status = 'active' LOOP
          v_items := v_items || jsonb_build_object('kind', 'pipeline', 'id', r.id, 'label', COALESCE(r.level_name, 'no level'));
          v_lines := v_lines || ('in the leadership pipeline (' || COALESCE(r.level_name, 'no level') || ')');
        END LOOP;
        FOR r IN SELECT id, plan_title FROM development_plans WHERE employee_id = NEW.id AND company_id = v_cid AND status IN ('active','paused') LOOP
          v_items := v_items || jsonb_build_object('kind', 'development_plan', 'id', r.id, 'label', r.plan_title);
          v_lines := v_lines || ('has the open development plan "' || r.plan_title || '"');
        END LOOP;
        FOR r IN SELECT da.id, da.title, dp.plan_title FROM development_actions da JOIN development_plans dp ON dp.id = da.plan_id
                  WHERE da.owner_employee_id = NEW.id AND dp.company_id = v_cid AND da.status IN ('pending','in_progress') LOOP
          v_items := v_items || jsonb_build_object('kind', 'action_owner', 'id', r.id, 'label', r.title);
          v_lines := v_lines || ('owns the open action "' || r.title || '" (' || r.plan_title || ')');
        END LOOP;
        FOR r IN SELECT ma.id, ma.mentee_employee_id = NEW.id AS is_mentee, other.name AS other_name
                   FROM mentoring_assignments ma
                   JOIN employees other ON other.id = CASE WHEN ma.mentee_employee_id = NEW.id THEN ma.mentor_employee_id ELSE ma.mentee_employee_id END
                  WHERE NEW.id IN (ma.mentee_employee_id, ma.mentor_employee_id) AND ma.company_id = v_cid AND ma.status = 'active' LOOP
          v_items := v_items || jsonb_build_object('kind', CASE WHEN r.is_mentee THEN 'mentee' ELSE 'mentor' END, 'id', r.id, 'label', r.other_name);
          v_lines := v_lines || (CASE WHEN r.is_mentee THEN 'is mentored by ' ELSE 'mentors ' END || r.other_name);
        END LOOP;
        FOR r IN SELECT etp.id, etp.pool_name FROM employee_pool_members epm JOIN employee_talent_pools etp ON etp.id = epm.pool_id
                  WHERE epm.employee_id = NEW.id AND etp.company_id = v_cid LOOP
          v_items := v_items || jsonb_build_object('kind', 'pool', 'id', r.id, 'label', r.pool_name);
          v_lines := v_lines || ('is in the talent pool "' || r.pool_name || '"');
        END LOOP;
        IF EXISTS (SELECT 1 FROM talent_assessments WHERE employee_id = NEW.id AND company_id = v_cid) THEN
          v_items := v_items || jsonb_build_object('kind', 'assessment');
          v_lines := v_lines || 'has a 9-box rating'::text;
        END IF;

        IF jsonb_array_length(v_items) = 0 THEN RETURN NULL; END IF;

        IF v_phase = 'left' THEN
          v_title := 'Succession: ' || NEW.name || ' has left';
          v_msg   := NEW.name || ' (' || NEW.office_id || ') has left. In Succession they ' || array_to_string(v_lines, '; ')
                     || '. They are no longer counted; review and replace them in the Succession Center.';
        ELSE
          v_title := 'Succession: ' || NEW.name || ' is serving notice';
          v_msg   := NEW.name || ' (' || NEW.office_id || ') is serving notice'
                     || COALESCE(' (last day ' || to_char(NEW.exit_date, 'DD Mon YY') || ')', '')
                     || '. In Succession they ' || array_to_string(v_lines, '; ') || '. Plan their replacement in the Succession Center.';
        END IF;

        INSERT INTO succession_alerts (alert_type, role_id, employee_id, message, severity, company_id, details)
        VALUES (CASE WHEN v_phase = 'left' THEN 'employee_left' ELSE 'employee_notice' END,
                v_role, NEW.id, v_msg, v_sev, v_cid,
                jsonb_build_object('employee_id', NEW.id, 'office_id', NEW.office_id, 'name', NEW.name,
                                   'phase', v_phase, 'status', NEW.status, 'items', v_items))
        RETURNING id INTO v_alert;

        SELECT notify_roles INTO v_roles FROM succession_settings WHERE company_id = v_cid;

        INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type, link)
        SELECT u.id, v_title, v_msg, 'succession', v_alert,
               CASE WHEN v_phase = 'left' THEN 'warning' ELSE 'info' END,
               '/SuccessionCenter?tab=planning'
          FROM users u
         WHERE u.is_active
           AND (u.company_id = v_cid OR EXISTS (SELECT 1 FROM user_scope us WHERE us.user_id = u.id AND us.company_id = v_cid))
           AND COALESCE(
                 (SELECT p.can_view FROM permissions p WHERE p.user_id = u.id AND p.module = 'succession' LIMIT 1),
                 EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                          WHERE ur.user_id = u.id AND rp.module = 'succession' AND rp.can_view))
           AND (v_roles IS NULL OR jsonb_array_length(v_roles) = 0
                OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                            WHERE ur.user_id = u.id AND v_roles ? LOWER(ro.code)));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'succession_notify_employee_change(%): % (%)', NEW.id, SQLERRM, SQLSTATE;
      END;
      RETURN NULL;
    END
    $fn$`);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_employees_succession_notify ON employees`);
  await knex.raw(`
    CREATE TRIGGER trg_employees_succession_notify
      AFTER UPDATE OF status, deleted_at ON employees
      FOR EACH ROW
      WHEN (succession_employment_phase(NEW.status, NEW.deleted_at) IN ('left', 'notice')
            AND succession_employment_phase(NEW.status, NEW.deleted_at)
                IS DISTINCT FROM succession_employment_phase(OLD.status, OLD.deleted_at))
      EXECUTE FUNCTION succession_notify_employee_change()`);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_employees_succession_notify ON employees`);
  await knex.raw(`DROP FUNCTION IF EXISTS succession_notify_employee_change()`);
  await knex.raw(`DROP FUNCTION IF EXISTS succession_employment_phase(text, timestamp)`);
  await knex.raw(`ALTER TABLE succession_settings ALTER COLUMN notify_roles SET DEFAULT '["chro", "hr_admin", "hr_manager"]'::jsonb`);
  await knex.raw(`DROP INDEX IF EXISTS ix_succession_alerts_unread`);
  await knex.raw(`ALTER TABLE succession_alerts DROP COLUMN IF EXISTS details`);
  await knex.raw(`DROP TABLE IF EXISTS mentoring_sessions`);
  for (const [t, name] of CHECKS) await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${name}`);
  for (const [t, col] of EMPLOYEE_FKS) {
    await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${`fk_${t}_${col}`.slice(0, 63)}`);
    await knex.raw(`DROP INDEX IF EXISTS ${`ix_${t}_${col}`.slice(0, 63)}`);
  }
  await knex.raw(`COMMENT ON COLUMN succession_plans.readiness_level IS NULL`);
  await knex.raw(`COMMENT ON COLUMN leadership_pipeline_entries.readiness IS NULL`);
}
