import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_IDS, seedSampleData } from '../../src/db/seed.js';
import { startTestDb, type TestDb } from './helpers/db.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await startTestDb();
});
afterAll(async () => {
  await testDb.stop();
});
beforeEach(async () => {
  await testDb.reset();
});

const count = async (table: string) => {
  const { rows } = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(testDb.db);
  return Number(rows[0]?.n);
};

describe('sample seed data', () => {
  it('can be run twice without creating duplicates', async () => {
    await seedSampleData(testDb.db);
    const first = {
      dealership: await count('dealership'),
      bays: await count('service_bay'),
      technicians: await count('technician'),
      skills: await count('technician_skill'),
      hours: await count('dealership_hours'),
      vehicles: await count('vehicle'),
    };
    await seedSampleData(testDb.db);
    expect({
      dealership: await count('dealership'),
      bays: await count('service_bay'),
      technicians: await count('technician'),
      skills: await count('technician_skill'),
      hours: await count('dealership_hours'),
      vehicles: await count('vehicle'),
    }).toEqual(first);
    expect(first).toEqual({
      dealership: 2,
      bays: 6,
      technicians: 6,
      skills: 12,
      hours: 12,
      vehicles: 3,
    });
  });

  it('marks every named record as SAMPLE', async () => {
    await seedSampleData(testDb.db);
    for (const table of [
      'dealership',
      'skill',
      'service_type',
      'service_bay',
      'technician',
      'customer',
    ]) {
      const { rows } = await sql<{ name: string }>`
        SELECT name FROM ${sql.table(table)} WHERE name NOT LIKE 'SAMPLE%'`.execute(testDb.db);
      expect(rows, `${table} has non-SAMPLE rows`).toEqual([]);
    }
  });

  it('gives every service type a technician who can perform it at each dealership', async () => {
    await seedSampleData(testDb.db);
    const { rows } = await sql<{ service_type: string; dealership: string }>`
      SELECT st.name AS service_type, d.name AS dealership
      FROM service_type st CROSS JOIN dealership d
      WHERE NOT EXISTS (
        SELECT 1 FROM technician t
        JOIN technician_skill ts ON ts.technician_id = t.id
        WHERE t.dealership_id = d.id AND ts.skill_id = st.required_skill_id)`.execute(testDb.db);
    expect(rows).toEqual([]);
  });

  it('puts the two dealerships in different time zones', async () => {
    await seedSampleData(testDb.db);
    const zones = await testDb.db
      .selectFrom('dealership')
      .select(['id', 'time_zone'])
      .orderBy('time_zone')
      .execute();
    expect(zones.map((z) => z.time_zone)).toEqual(['America/New_York', 'Europe/London']);
    expect(zones.map((z) => z.id)).toContain(SAMPLE_IDS.london);
  });
});
