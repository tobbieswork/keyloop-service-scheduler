/**
 * DEMO DATA. The API deliberately has no endpoint that lists customers: names and contact details
 * are personal data and the service has no authentication yet. So this demo offers the SAMPLE
 * customers created by the backend's `npm run seed` (same fixed IDs), and says so on screen.
 * A real product would look customers up through an authenticated search instead.
 */
export interface DemoVehicle {
  id: string;
  label: string;
}
export interface DemoCustomer {
  id: string;
  name: string;
  vehicles: DemoVehicle[];
}

export const demoCustomers: DemoCustomer[] = [
  {
    id: '00000004-0000-4000-8000-000000000001',
    name: 'SAMPLE Customer A',
    vehicles: [
      { id: '00000005-0000-4000-8000-000000000001', label: 'SAMPLE Hatchback' },
      { id: '00000005-0000-4000-8000-000000000002', label: 'SAMPLE Estate' },
    ],
  },
  {
    id: '00000004-0000-4000-8000-000000000002',
    name: 'SAMPLE Customer B',
    vehicles: [{ id: '00000005-0000-4000-8000-000000000003', label: 'SAMPLE SUV' }],
  },
];
