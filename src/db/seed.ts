/* eslint-disable no-console -- this is a command-line script, not the service */
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { createDb, type Db } from './index.js';

/**
 * SAMPLE data for local development, demos and the cURL examples. Every name starts with
 * "SAMPLE" so it can never be mistaken for real customer data. IDs are fixed so the seed can be
 * re-run safely and examples can refer to them.
 */
const id = (group: number, n: number) =>
  `${group.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export const SAMPLE_IDS = {
  london: id(1, 1),
  newYork: id(1, 2),
  skillGeneral: id(2, 1),
  skillBrakes: id(2, 2),
  skillElectrical: id(2, 3),
  skillTyres: id(2, 4),
  oilChange: id(3, 1), // 30 min + 10 buffer, general
  brakeService: id(3, 2), // 90 min + 15 buffer, brakes
  diagnostics: id(3, 3), // 60 min + 15 buffer, electrical
  tyreChange: id(3, 4), // 45 min + 0 buffer, tyres
  customerA: id(4, 1),
  customerB: id(4, 2),
  vehicleA1: id(5, 1),
  vehicleA2: id(5, 2),
  vehicleB1: id(5, 3),
  /** Bays 1-3 at London, 4-6 at New York. */
  bays: [id(6, 1), id(6, 2), id(6, 3), id(6, 4), id(6, 5), id(6, 6)],
  /** Technicians 1-3 at London, 4-6 at New York. */
  technicians: [id(7, 1), id(7, 2), id(7, 3), id(7, 4), id(7, 5), id(7, 6)],
} as const;

export async function seedSampleData(db: Db): Promise<void> {
  const s = SAMPLE_IDS;

  await db
    .insertInto('dealership')
    .values([
      { id: s.london, name: 'SAMPLE Dealership London', time_zone: 'Europe/London' },
      { id: s.newYork, name: 'SAMPLE Dealership New York', time_zone: 'America/New_York' },
    ])
    .onConflict((oc) => oc.doNothing())
    .execute();

  // London: Mon-Fri 08:00-17:00, Sat 09:00-13:00, closed Sunday.
  // New York: Mon-Sat 07:00-18:00, closed Sunday.
  const hours = [
    ...[1, 2, 3, 4, 5].map((weekday) => ({
      dealership_id: s.london,
      weekday,
      open_time: '08:00',
      close_time: '17:00',
    })),
    { dealership_id: s.london, weekday: 6, open_time: '09:00', close_time: '13:00' },
    ...[1, 2, 3, 4, 5, 6].map((weekday) => ({
      dealership_id: s.newYork,
      weekday,
      open_time: '07:00',
      close_time: '18:00',
    })),
  ];
  await db
    .insertInto('dealership_hours')
    .values(hours)
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('skill')
    .values([
      { id: s.skillGeneral, name: 'SAMPLE general' },
      { id: s.skillBrakes, name: 'SAMPLE brakes' },
      { id: s.skillElectrical, name: 'SAMPLE electrical' },
      { id: s.skillTyres, name: 'SAMPLE tyres' },
    ])
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('service_type')
    .values([
      {
        id: s.oilChange,
        name: 'SAMPLE Oil change',
        duration_minutes: 30,
        buffer_minutes: 10,
        required_skill_id: s.skillGeneral,
      },
      {
        id: s.brakeService,
        name: 'SAMPLE Brake service',
        duration_minutes: 90,
        buffer_minutes: 15,
        required_skill_id: s.skillBrakes,
      },
      {
        id: s.diagnostics,
        name: 'SAMPLE Electrical diagnostics',
        duration_minutes: 60,
        buffer_minutes: 15,
        required_skill_id: s.skillElectrical,
      },
      {
        id: s.tyreChange,
        name: 'SAMPLE Tyre change',
        duration_minutes: 45,
        buffer_minutes: 0,
        required_skill_id: s.skillTyres,
      },
    ])
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('service_bay')
    .values(
      s.bays.map((bayId, i) => ({
        id: bayId,
        dealership_id: i < 3 ? s.london : s.newYork,
        name: `SAMPLE Bay ${(i % 3) + 1}`,
      })),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('technician')
    .values(
      s.technicians.map((technicianId, i) => ({
        id: technicianId,
        dealership_id: i < 3 ? s.london : s.newYork,
        name: `SAMPLE Technician ${(i % 3) + 1}`,
      })),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();

  // Per dealership: tech 1 = general + brakes, tech 2 = general + electrical, tech 3 = tyres + brakes.
  const skillMap = [
    [s.skillGeneral, s.skillBrakes],
    [s.skillGeneral, s.skillElectrical],
    [s.skillTyres, s.skillBrakes],
  ];
  await db
    .insertInto('technician_skill')
    .values(
      s.technicians.flatMap((technicianId, i) =>
        (skillMap[i % 3] ?? []).map((skillId) => ({
          technician_id: technicianId,
          skill_id: skillId,
        })),
      ),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('customer')
    .values([
      { id: s.customerA, name: 'SAMPLE Customer A', contact: 'sample.a@example.invalid' },
      { id: s.customerB, name: 'SAMPLE Customer B', contact: 'sample.b@example.invalid' },
    ])
    .onConflict((oc) => oc.doNothing())
    .execute();

  await db
    .insertInto('vehicle')
    .values([
      {
        id: s.vehicleA1,
        customer_id: s.customerA,
        vin: 'SAMPLE0000000001A',
        make: 'SAMPLE',
        model: 'Hatchback',
      },
      {
        id: s.vehicleA2,
        customer_id: s.customerA,
        vin: 'SAMPLE0000000002A',
        make: 'SAMPLE',
        model: 'Estate',
      },
      {
        id: s.vehicleB1,
        customer_id: s.customerB,
        vin: 'SAMPLE0000000003B',
        make: 'SAMPLE',
        model: 'SUV',
      },
    ])
    .onConflict((oc) => oc.doNothing())
    .execute();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl, { poolSize: 1 });
  try {
    await seedSampleData(db);
    console.log('SAMPLE data seeded (safe to run again).');
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
