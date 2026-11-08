// NEW CLINIC TEMPLATE – copy this whole folder to clinics/<clinic-name>/, fill it in, then start the agent with
//   CLINIC_CONFIG=clinics/<clinic-name>/clinic.js
//
// This file holds the clinic's settings and the facts the receptionist always knows. Its policies, procedures,
// and FAQs go in knowledge/*.md, which the receptionist searches during a call.
//
// The receptionist only tells callers what is written here or in knowledge/. Leave a field empty ('' or [])
// until the clinic has confirmed it: the receptionist then says she doesn't have that detail confirmed and
// offers a callback from the clinic team, instead of guessing.
//
// Restart the agent after editing this file or the knowledge files.

export default {
  name: 'TODO Clinic Name',
  specialty: 'TODO, e.g. General Practice & Family Medicine',

  // Languages the receptionist speaks. She answers in the caller's language and switches if they do.
  // The first one is used when the caller's language isn't clear. Supported: 'English', 'Arabic'.
  languages: ['English', 'Arabic'],
  // Played the instant a call connects. Empty = "Hello! Thank you for calling <name>. I'm your virtual receptionist..."
  // With two languages, end with a short line in the second one so callers know they can use it, e.g. "تقدر تكلمني عربي كمان."
  greeting: '',

  // Folder with the clinic's knowledge base (Markdown), relative to this file
  knowledgeDir: 'knowledge',

  // At the end of a normal call, ask the caller to rate it from 1 to 5 (shown on the Review page)
  askForRating: true,

  // Time zone of the clinic, e.g. 'Africa/Cairo' or 'America/New_York'. Empty = the server's time zone.
  timeZone: 'Africa/Cairo',
  // The clinic's country calling code, e.g. '+20' (Egypt). Callers phoning from another country (by caller ID)
  // are told their own local emergency number instead of emergencyNumber below.
  countryCode: '+20',

  // ---- Facts the receptionist always knows (written the way you'd say them out loud) ----
  // Anything left empty here can still be answered from knowledge/ (for example the address, in 01-visiting.md).
  // e.g. 'Sunday to Thursday, 9 AM to 5 PM. Closed on Fridays and Saturdays.'
  openingHours: '',
  // e.g. '12 Nile Street, Garden City, Cairo, next to the pharmacy'
  address: '',
  // e.g. 'A general consultation is 500 pounds. A routine checkup is 700 pounds.'
  fees: '',
  // e.g. 'We accept AXA and Allianz. Please bring your insurance card.'
  insurance: '',
  whatToBring: '',
  cancellationPolicy: '',
  // What callers are told after the receptionist passes on a request,
  // e.g. 'A member of the clinic team will call you back within one working day.'
  callbackPromise: '',
  // Services the clinic has confirmed, e.g. ['general health consultations', 'routine health checkups']
  services: [],

  // ---- Emergencies ----
  // Local emergency number, e.g. '123' (Egypt ambulance), '911' (US), '999' (UK). Empty = "local emergency services".
  emergencyNumber: '',
  // Mental health crisis line, e.g. '988' (US). Confirm the current number for the clinic's country before going live.
  // Empty = the receptionist gives the emergency number only.
  crisisLine: '',
  // Any extra instructions from the clinic's approved emergency protocol (optional).
  emergencyProtocol: '',

  // ---- Online booking ----
  // Doctors who can be booked. Each one uses `schedule` below unless given their own, e.g.
  //   { name: 'Dr. Sarah Ahmed' },
  //   { name: 'Dr. Omar Khaled', schedule: { sunday: ['09:00-13:00'], tuesday: ['14:00-18:00'] } },
  // Leave empty to book "the next available doctor" without names.
  doctors: [],

  // Bookable hours per weekday, 24-hour clock, e.g.  sunday: ['09:00-13:00', '14:00-17:00'],
  // While this is empty, nothing can be booked online: the receptionist takes a callback
  // request instead so the clinic team can arrange the appointment.
  schedule: {},

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
