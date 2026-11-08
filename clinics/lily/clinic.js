// Lily's Clinic – the clinic's settings. Its policies, procedures, and FAQs are in knowledge/*.md
// (the receptionist searches those during a call).
//
// The receptionist only tells callers what is written here or in knowledge/. Leave a field empty ('' or [])
// until the clinic administrator has confirmed it: the receptionist will then say it doesn't
// have that detail confirmed and offer to have the clinic team follow up, instead of guessing.
//
// Restart the agent after editing this file or the knowledge files.

export default {
  name: "Lily's Clinic",
  specialty: 'General Practice & Family Medicine',

  // Languages the receptionist speaks. She answers in the caller's language and switches if they do.
  // The first one is used when the caller's language isn't clear. Supported: 'English', 'Arabic'.
  languages: ['English', 'Arabic'],
  // Played the instant a call connects. Mention the second language so callers know they can use it.
  greeting: "Hello! Thank you for calling Lily's Clinic. I'm your virtual receptionist. How can I help you today? تقدر تكلمني عربي كمان.",

  // Folder with the clinic's knowledge base (Markdown), relative to this file
  knowledgeDir: 'knowledge',

  // At the end of a normal call, ask the caller to rate it from 1 to 5 (shown on the Review page)
  askForRating: true,

  // Time zone of the clinic, e.g. 'Africa/Cairo' or 'America/New_York'. Empty = this computer's time zone.
  timeZone: 'America/New_York',
  // The clinic's country calling code. Callers phoning from another country (by caller ID) are told their own
  // local emergency number instead of emergencyNumber below, e.g. 123 for a caller in Egypt.
  countryCode: '+1',

  // ---- Facts the receptionist may tell callers (written the way you'd say them out loud) ----
  // e.g. 'Sunday to Thursday, 9 AM to 5 PM. Closed on Fridays and Saturdays.'
  openingHours: 'Every day, 9 AM to 9 PM.',
  // e.g. '12 Nile Street, Garden City, Cairo, next to the pharmacy'
  address: '',
  // e.g. 'A general consultation is 500 pounds. A routine checkup is 700 pounds.'
  fees: '',
  // e.g. 'We accept AXA and Allianz. Please bring your insurance card.'
  insurance: '',
  // e.g. 'Please bring a photo ID, your insurance card, and a list of any medicines you take.'
  whatToBring: '',
  // e.g. 'Please cancel or reschedule at least 24 hours before your appointment.'
  cancellationPolicy: '',
  // What callers are told after the receptionist takes a callback request,
  // e.g. 'A member of the clinic team will call you back within one working day.'
  callbackPromise: '',

  // Services the clinic administrator has confirmed. Suggested list – uncomment the confirmed ones:
  services: [
    // 'general health consultations',
    // 'routine health checkups',
    // 'preventive care and wellness visits',
    // 'follow-up appointments',
    // 'family health consultations',
    // 'referrals to other specialists when appropriate',
  ],

  // ---- Emergencies ----
  // Local emergency number, e.g. '123' (Egypt), '911' (US), '999' (UK). Empty = "local emergency services".
  emergencyNumber: '911',
  // Mental health crisis line for callers who may harm themselves, e.g. '988' (US). Empty = emergency number only.
  crisisLine: '988',
  // Any extra instructions from the clinic's approved emergency protocol (optional).
  emergencyProtocol: '',

  // ---- Online booking ----
  // Doctors who can be booked. Each one uses `schedule` below unless given their own, e.g.
  //   { name: 'Dr. Sarah Ahmed' },
  //   { name: 'Dr. Omar Khaled', schedule: { sunday: ['09:00-13:00'], tuesday: ['14:00-18:00'] } },
  // Leave empty to book "the next available doctor" without names.
  // Demo doctors – replace with the clinic's real doctors
  doctors: [{ name: 'Dr. Amira Hassan' }, { name: 'Dr. James Carter' }],

  // Bookable hours per weekday, 24-hour clock, e.g.
  //   sunday: ['09:00-13:00', '14:00-17:00'],
  // While this is empty, nothing can be booked online: the receptionist takes a callback
  // request instead so the clinic team can arrange the appointment.
  schedule: {
    sunday: ['09:00-21:00'],
    monday: ['09:00-21:00'],
    tuesday: ['09:00-21:00'],
    wednesday: ['09:00-21:00'],
    thursday: ['09:00-21:00'],
    friday: ['09:00-21:00'],
    saturday: ['09:00-21:00'],
  },

  // Days the clinic is closed (holidays), as 'YYYY-MM-DD'
  closedDates: [],

  // Appointment types callers can book, and how long each one takes (minutes)
  appointmentTypes: {
    general_consultation: { label: 'general consultation', minutes: 20 },
    routine_checkup: { label: 'routine checkup', minutes: 30 },
    follow_up: { label: 'follow-up visit', minutes: 15 },
  },

  // How far ahead callers can book, and the minimum notice for a same-day booking
  bookingDaysAhead: 30,
  minNoticeMinutes: 60,

  // Ask for date of birth when booking, and check it before changing or cancelling an appointment
  requireDateOfBirth: false,
};
