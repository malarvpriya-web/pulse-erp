/**
 * meetings / meeting_attendees — the tables behind Manager Dashboard's
 * "Schedule Meeting" drawer.
 *
 * The drawer has always been fully wired on the frontend: it collects a title,
 * date, time, a multi-select of team members and free-text notes, then posts
 * `{ title, date, time, attendee_ids, notes }` to `POST /meetings`. No such
 * route and no such table ever existed, so the button reported "Failed to
 * schedule meeting" on every click.
 *
 * Shape follows the drawer's contract rather than inventing a calendar system:
 * one row per meeting, one row per invitee. `attendee_ids` are **employee** ids
 * (that is what the team-member picker lists), not user ids — the notification
 * fan-out maps employees to their logins via `users.employee_id`.
 */

export async function up(knex) {
  // $1, not ?: the migration runner is a thin pg shim, not knex's query builder.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS meetings (
      id                    SERIAL PRIMARY KEY,
      title                 VARCHAR(200) NOT NULL,
      meeting_date          DATE         NOT NULL,
      meeting_time          TIME,
      notes                 TEXT,
      organiser_employee_id INTEGER REFERENCES employees(id),
      status                VARCHAR(20)  NOT NULL DEFAULT 'scheduled',
      company_id            INTEGER,
      created_by            INTEGER REFERENCES users(id),
      created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at            TIMESTAMPTZ
    )
  `);

  await knex.raw(`
    ALTER TABLE meetings
      ADD CONSTRAINT meetings_status_check
      CHECK (status IN ('scheduled', 'cancelled', 'completed'))
  `).catch(() => {});

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS meeting_attendees (
      id          SERIAL PRIMARY KEY,
      meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      response    VARCHAR(20) NOT NULL DEFAULT 'invited',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Re-inviting the same person must not duplicate the row — the POST route
  // upserts against this.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS meeting_attendees_meeting_employee_unique
      ON meeting_attendees (meeting_id, employee_id)
  `);

  // "My upcoming meetings" reads by attendee then by date; the organiser's own
  // list reads by organiser then date.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_meeting_attendees_employee
      ON meeting_attendees (employee_id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_meetings_date
      ON meetings (meeting_date) WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_meetings_organiser
      ON meetings (organiser_employee_id) WHERE deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS meeting_attendees');
  await knex.raw('DROP TABLE IF EXISTS meetings');
}
