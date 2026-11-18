/**
 * 20261112000002_succession_left_message_wording.js
 *
 * Wording only. The alert and notification text written by
 * succession_notify_employee_change() (migration 20261112000001) read
 * "In Succession they holds the critical role ...". It now reads
 * "Recorded in Succession as: holder of the critical role ...; successor #1
 * for ...". The function is otherwise identical; down() restores the old text.
 */

export async function up(knex) {
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
          v_lines := v_lines || ('holder of the critical role "' || r.role_title || '"');
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
          v_lines := v_lines || ('open development plan "' || r.plan_title || '"');
        END LOOP;
        FOR r IN SELECT da.id, da.title, dp.plan_title FROM development_actions da JOIN development_plans dp ON dp.id = da.plan_id
                  WHERE da.owner_employee_id = NEW.id AND dp.company_id = v_cid AND da.status IN ('pending','in_progress') LOOP
          v_items := v_items || jsonb_build_object('kind', 'action_owner', 'id', r.id, 'label', r.title);
          v_lines := v_lines || ('owner of the open action "' || r.title || '" (' || r.plan_title || ')');
        END LOOP;
        FOR r IN SELECT ma.id, ma.mentee_employee_id = NEW.id AS is_mentee, other.name AS other_name
                   FROM mentoring_assignments ma
                   JOIN employees other ON other.id = CASE WHEN ma.mentee_employee_id = NEW.id THEN ma.mentor_employee_id ELSE ma.mentee_employee_id END
                  WHERE NEW.id IN (ma.mentee_employee_id, ma.mentor_employee_id) AND ma.company_id = v_cid AND ma.status = 'active' LOOP
          v_items := v_items || jsonb_build_object('kind', CASE WHEN r.is_mentee THEN 'mentee' ELSE 'mentor' END, 'id', r.id, 'label', r.other_name);
          v_lines := v_lines || (CASE WHEN r.is_mentee THEN 'mentee of ' ELSE 'mentor of ' END || r.other_name);
        END LOOP;
        FOR r IN SELECT etp.id, etp.pool_name FROM employee_pool_members epm JOIN employee_talent_pools etp ON etp.id = epm.pool_id
                  WHERE epm.employee_id = NEW.id AND etp.company_id = v_cid LOOP
          v_items := v_items || jsonb_build_object('kind', 'pool', 'id', r.id, 'label', r.pool_name);
          v_lines := v_lines || ('member of the talent pool "' || r.pool_name || '"');
        END LOOP;
        IF EXISTS (SELECT 1 FROM talent_assessments WHERE employee_id = NEW.id AND company_id = v_cid) THEN
          v_items := v_items || jsonb_build_object('kind', 'assessment');
          v_lines := v_lines || 'rated on the 9-box'::text;
        END IF;

        IF jsonb_array_length(v_items) = 0 THEN RETURN NULL; END IF;

        IF v_phase = 'left' THEN
          v_title := 'Succession: ' || NEW.name || ' has left';
          v_msg   := NEW.name || ' (' || NEW.office_id || ') has left. Recorded in Succession as: ' || array_to_string(v_lines, '; ')
                     || '. They are no longer counted; review and replace them in the Succession Center.';
        ELSE
          v_title := 'Succession: ' || NEW.name || ' is serving notice';
          v_msg   := NEW.name || ' (' || NEW.office_id || ') is serving notice'
                     || COALESCE(' (last day ' || to_char(NEW.exit_date, 'DD Mon YY') || ')', '')
                     || '. Recorded in Succession as: ' || array_to_string(v_lines, '; ') || '. Plan their replacement in the Succession Center.';
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

}

export async function down(knex) {
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

}
