import type { ColumnType, Generated } from 'kysely';

/**
 * Table types for Kysely. Mirrors specs/001-service-scheduler/data-model.md.
 *
 * Time ranges (`period`, `occupied_period`) are Postgres `tstzrange` values. They are written
 * with `tstzrange(start, end, '[)')` and read with `lower()` / `upper()` in SQL, so the
 * application never parses the range text format.
 */
type Id = Generated<string>; // uuid, defaulted by the database
type Range = ColumnType<string, string, never>; // written via an SQL expression, never updated

export type AppointmentStatus = 'confirmed' | 'cancelled';

export interface DealershipTable {
  id: Id;
  name: string;
  time_zone: string; // IANA, e.g. Europe/London
}

export interface DealershipHoursTable {
  dealership_id: string;
  weekday: number; // 0 = Sunday ... 6 = Saturday (same as Postgres EXTRACT(dow) and JS getDay())
  open_time: string; // local time 'HH:MM:SS'
  close_time: string;
}

export interface SkillTable {
  id: Id;
  name: string;
}

export interface ServiceTypeTable {
  id: Id;
  name: string;
  duration_minutes: number;
  buffer_minutes: Generated<number>;
  required_skill_id: string;
}

export interface ServiceBayTable {
  id: Id;
  dealership_id: string;
  name: string;
}

export interface TechnicianTable {
  id: Id;
  dealership_id: string;
  name: string;
}

export interface TechnicianSkillTable {
  technician_id: string;
  skill_id: string;
}

export interface CustomerTable {
  id: Id;
  name: string; // personal data: never logged
  contact: string; // personal data: never logged
}

export interface VehicleTable {
  id: Id;
  customer_id: string;
  vin: string; // never logged
  make: string;
  model: string;
}

export interface BayUnavailabilityTable {
  id: Id;
  bay_id: string;
  period: Range;
  reason: string;
}

export interface TechnicianUnavailabilityTable {
  id: Id;
  technician_id: string;
  period: Range;
  reason: string;
}

export interface AppointmentTable {
  id: Id;
  customer_id: string;
  vehicle_id: string;
  service_type_id: string;
  dealership_id: string;
  bay_id: string;
  technician_id: string;
  occupied_period: Range; // start .. start + duration + buffer, half-open
  service_end: Date; // start + duration (without buffer), for display
  status: Generated<AppointmentStatus>;
  idempotency_key: string;
  request_hash: string;
  created_at: Generated<Date>;
  cancelled_at: Date | null;
}

export interface Database {
  dealership: DealershipTable;
  dealership_hours: DealershipHoursTable;
  skill: SkillTable;
  service_type: ServiceTypeTable;
  service_bay: ServiceBayTable;
  technician: TechnicianTable;
  technician_skill: TechnicianSkillTable;
  customer: CustomerTable;
  vehicle: VehicleTable;
  bay_unavailability: BayUnavailabilityTable;
  technician_unavailability: TechnicianUnavailabilityTable;
  appointment: AppointmentTable;
}
