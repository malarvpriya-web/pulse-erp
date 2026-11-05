/**
 * 20261105000003 — DB-01C2: a fixed-purpose way to add a telemetry month.
 * MODULE_FEATURE_CONNECTION_MANUAL.md §241.
 *
 * jobs/iotPartitions.cron.js adds each month of device_telemetry with CREATE TABLE.
 * Only the table's owner can do that, and the application role must not be able to
 * create tables at all. Under that role the job failed and telemetry piled into the
 * default partition, which then blocks the month's partition from being created.
 *
 * This function runs as its owner and can do exactly one thing: create the partition
 * of device_telemetry for one calendar month.
 *   - It takes two integers and builds the table name itself, so no caller text
 *     reaches the SQL.
 *   - The month must be between last month and twelve months ahead.
 *   - search_path is fixed, so a caller cannot redirect what it resolves.
 *   - Execution is revoked from PUBLIC and granted only to the application role.
 *
 * It does not set a time zone. Partition bounds are read in the session's zone, as
 * the job's own CREATE TABLE always did, so a new month meets the existing ones
 * without an overlap or a gap.
 *
 * Partition removal stays with the owner: retention is off by default, and a
 * function that drops telemetry is a larger grant than this needs.
 *
 * down() removes the function only. Partitions, and the telemetry in them, stay.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ensure_device_telemetry_partition(p_year integer, p_month integer)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $fn$
    DECLARE
      v_from date;
      v_to   date;
      v_name text;
      v_this date := date_trunc('month', now())::date;
    BEGIN
      IF p_year IS NULL OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12 OR p_year NOT BETWEEN 2000 AND 2999 THEN
        RAISE EXCEPTION 'ensure_device_telemetry_partition: % / % is not a calendar month', p_year, p_month
          USING ERRCODE = '22023';
      END IF;
      v_from := make_date(p_year, p_month, 1);
      IF v_from < (v_this - interval '1 month')::date OR v_from > (v_this + interval '12 months')::date THEN
        RAISE EXCEPTION 'ensure_device_telemetry_partition: % is outside the allowed window', v_from
          USING ERRCODE = '22023';
      END IF;
      v_to   := (v_from + interval '1 month')::date;
      v_name := 'device_telemetry_' || to_char(v_from, 'YYYY') || '_' || to_char(v_from, 'MM');
      IF to_regclass('public.' || v_name) IS NOT NULL THEN
        RETURN false;
      END IF;
      EXECUTE format('CREATE TABLE public.%I PARTITION OF public.device_telemetry FOR VALUES FROM (%L) TO (%L)',
                     v_name, v_from, v_to);
      RETURN true;
    END
    $fn$`);
  await knex.raw(`REVOKE ALL ON FUNCTION ensure_device_telemetry_partition(integer, integer) FROM PUBLIC`);
  await knex.raw(`
    DO $grant$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_app') THEN
        GRANT EXECUTE ON FUNCTION ensure_device_telemetry_partition(integer, integer) TO pulse_app;
      END IF;
    END
    $grant$`);
}

export async function down(knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS ensure_device_telemetry_partition(integer, integer)`);
}
