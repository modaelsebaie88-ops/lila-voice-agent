// A made-up clinic used only by the tests (npm test / npm run test-live), so test calls never
// touch the real clinic settings, appointments, or messages. It searches Lily's real knowledge base.
import clinic from './clinics/lily/clinic.js';

const allDay = ['08:00-20:00'];

export default {
  ...clinic,
  knowledgeDir: 'clinics/lily/knowledge', // relative to this file
  openingHours: 'Every day from 8 AM to 8 PM.',
  // Address, fees, insurance, and parking come from Lily's knowledge base (demo values)
  services: ['general health consultations', 'routine health checkups', 'follow-up appointments'],
  emergencyNumber: '123',
  doctors: [{ name: 'Dr. Amira Hassan' }, { name: 'Dr. James Carter' }],
  schedule: {
    sunday: allDay,
    monday: allDay,
    tuesday: allDay,
    wednesday: allDay,
    thursday: allDay,
    friday: allDay,
    saturday: allDay,
  },
  closedDates: [],
  requireDateOfBirth: false,
};
