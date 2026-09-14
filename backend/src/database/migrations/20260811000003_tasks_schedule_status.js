/**
 * 20260811000003_tasks_schedule_status.js
 *
 * gantt.routes.js still reads/writes its own legacy `project_tasks` table
 * (always empty on this pilot) instead of the unified `tasks` table that
 * Task List/Kanban actually use, even though migration 20260615000010
 * already added every Gantt column `tasks` needed. One column was missing
 * for the switch to be safe: `tasks.status` already carries Kanban's
 * workflow-stage vocabulary (todo/in_progress/review/done) — reusing it for
 * Gantt's schedule-health vocabulary (on_track/at_risk/delayed) would corrupt
 * Kanban's board bucketing (`taskRepository.getKanbanBoard()` buckets by
 * exact `status` string) the moment a Gantt task existed. `schedule_status`
 * gives Gantt its own column so the two features can finally share one row
 * per task without colliding on what "status" means.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_status VARCHAR(20) DEFAULT 'on_track'
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE tasks DROP COLUMN IF EXISTS schedule_status
  `);
}
