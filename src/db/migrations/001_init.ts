import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Initial schema. The invariants live here, in the database (constitution principle I):
 * exclusion constraints make double-booking impossible even if application code has a bug.
 * See specs/001-service-scheduler/data-model.md.
 *
 * All time ranges are half-open `[start, end)`, so back-to-back appointments do not overlap.
 */
export const migration001: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    // Needed so an exclusion constraint can combine equality (=) on a uuid with range overlap (&&).
    await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db);

    await sql`CREATE TYPE appointment_status AS ENUM ('confirmed', 'cancelled')`.execute(db);

    // ---------- reference data ----------
    await sql`
      CREATE TABLE dealership (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        time_zone text NOT NULL -- IANA name, e.g. Europe/London
      )`.execute(db);

    await sql`
      CREATE TABLE dealership_hours (
        dealership_id uuid NOT NULL REFERENCES dealership(id),
        weekday smallint NOT NULL, -- 0 = Sunday ... 6 = Saturday
        open_time time NOT NULL,   -- local time at the dealership
        close_time time NOT NULL,
        PRIMARY KEY (dealership_id, weekday),
        CONSTRAINT dealership_hours_weekday_valid CHECK (weekday BETWEEN 0 AND 6),
        CONSTRAINT dealership_hours_close_after_open CHECK (close_time > open_time)
      )`.execute(db);

    await sql`
      CREATE TABLE skill (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL UNIQUE
      )`.execute(db);

    await sql`
      CREATE TABLE service_type (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        duration_minutes integer NOT NULL,
        buffer_minutes integer NOT NULL DEFAULT 0,
        required_skill_id uuid NOT NULL REFERENCES skill(id),
        CONSTRAINT service_type_duration_positive CHECK (duration_minutes > 0),
        CONSTRAINT service_type_buffer_not_negative CHECK (buffer_minutes >= 0)
      )`.execute(db);

    await sql`
      CREATE TABLE service_bay (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        dealership_id uuid NOT NULL REFERENCES dealership(id),
        name text NOT NULL
      )`.execute(db);

    await sql`
      CREATE TABLE technician (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        dealership_id uuid NOT NULL REFERENCES dealership(id),
        name text NOT NULL
      )`.execute(db);

    await sql`
      CREATE TABLE technician_skill (
        technician_id uuid NOT NULL REFERENCES technician(id),
        skill_id uuid NOT NULL REFERENCES skill(id),
        PRIMARY KEY (technician_id, skill_id)
      )`.execute(db);

    await sql`
      CREATE TABLE customer (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        contact text NOT NULL
      )`.execute(db);

    await sql`
      CREATE TABLE vehicle (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid NOT NULL REFERENCES customer(id),
        vin text NOT NULL,
        make text NOT NULL,
        model text NOT NULL,
        CONSTRAINT vehicle_vin_key UNIQUE (vin)
      )`.execute(db);

    // ---------- unavailability (FR-015) ----------
    await sql`
      CREATE TABLE bay_unavailability (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        bay_id uuid NOT NULL REFERENCES service_bay(id),
        period tstzrange NOT NULL,
        reason text NOT NULL,
        CONSTRAINT bay_unavailability_period_valid
          CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
        CONSTRAINT bay_unavailability_no_overlap
          EXCLUDE USING gist (bay_id WITH =, period WITH &&)
      )`.execute(db);

    await sql`
      CREATE TABLE technician_unavailability (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        technician_id uuid NOT NULL REFERENCES technician(id),
        period tstzrange NOT NULL,
        reason text NOT NULL,
        CONSTRAINT technician_unavailability_period_valid
          CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
        CONSTRAINT technician_unavailability_no_overlap
          EXCLUDE USING gist (technician_id WITH =, period WITH &&)
      )`.execute(db);

    // ---------- appointments ----------
    await sql`
      CREATE TABLE appointment (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid NOT NULL REFERENCES customer(id),
        vehicle_id uuid NOT NULL REFERENCES vehicle(id),
        service_type_id uuid NOT NULL REFERENCES service_type(id),
        dealership_id uuid NOT NULL REFERENCES dealership(id),
        bay_id uuid NOT NULL REFERENCES service_bay(id),
        technician_id uuid NOT NULL REFERENCES technician(id),
        occupied_period tstzrange NOT NULL, -- start .. start + duration + buffer
        service_end timestamptz NOT NULL,   -- start + duration, without the buffer
        status appointment_status NOT NULL DEFAULT 'confirmed',
        idempotency_key text NOT NULL,
        request_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        cancelled_at timestamptz,
        CONSTRAINT appointment_idempotency_key_key UNIQUE (idempotency_key),
        CONSTRAINT appointment_period_valid
          CHECK (NOT isempty(occupied_period) AND lower_inc(occupied_period) AND NOT upper_inc(occupied_period)),
        -- A bay never hosts two confirmed appointments at once (FR-007).
        CONSTRAINT appointment_no_bay_overlap
          EXCLUDE USING gist (bay_id WITH =, occupied_period WITH &&)
          WHERE (status = 'confirmed'),
        -- A technician never works two confirmed appointments at once (FR-007).
        CONSTRAINT appointment_no_technician_overlap
          EXCLUDE USING gist (technician_id WITH =, occupied_period WITH &&)
          WHERE (status = 'confirmed')
      )`.execute(db);

    // Speeds up the daily availability and "least booked that day" queries.
    await sql`
      CREATE INDEX appointment_dealership_start_idx
        ON appointment (dealership_id, lower(occupied_period))`.execute(db);
  },

  async down(db: Kysely<unknown>): Promise<void> {
    for (const table of [
      'appointment',
      'technician_unavailability',
      'bay_unavailability',
      'vehicle',
      'customer',
      'technician_skill',
      'technician',
      'service_bay',
      'service_type',
      'skill',
      'dealership_hours',
      'dealership',
    ]) {
      await sql.raw(`DROP TABLE IF EXISTS ${table}`).execute(db);
    }
    await sql`DROP TYPE IF EXISTS appointment_status`.execute(db);
  },
};
