// The clinic's appointment book.
//
// Works out free slots from the schedule in clinic.js and keeps appointments in a JSON file.
// To connect a real calendar or practice-management system later, replace the functions
// returned by createAppointmentBook(): the receptionist only sees what they return.
//
// Dates are 'YYYY-MM-DD' and times 'HH:MM' (24-hour), always in the clinic's own time zone.

import fs from 'fs';
import crypto from 'crypto';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MAX_OFFERED = 6; // slots returned per search; the receptionist offers two or three of them

// ---------------------------------------------------------------------------
// Date and time helpers
// ---------------------------------------------------------------------------
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const utcDate = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(utcDate(s));
const cleanTime = (s) => (/^\d{1,2}:\d{2}$/.test(s || '') ? toHHMM(toMinutes(s)) : null);

export const addDays = (date, n) => {
  const d = utcDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (date) => DAYS[utcDate(date).getUTCDay()];
export const spokenDate = (date) =>
  utcDate(date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
const spokenTime = (hhmm) => {
  const min = toMinutes(hhmm);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

// Current date and time at the clinic
export function clinicNow(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// ---------------------------------------------------------------------------
// Matching callers to appointments
// ---------------------------------------------------------------------------
const digits = (s) => String(s || '').replace(/\D/g, '');
const nameTokens = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-zÀ-ɏ؀-ۿ\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

// Same number, ignoring spaces, dashes, and country-code / leading-zero differences
export function phonesMatch(a, b) {
  const da = digits(a);
  const db = digits(b);
  if (da.length < 7 || db.length < 7) return false;
  const n = Math.min(da.length, db.length, 9);
  return da.slice(-n) === db.slice(-n);
}

// First and last name both match
function namesMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
}

const datesOfBirthMatch = (a, b) => digits(a).length >= 6 && digits(a) === digits(b);

// ---------------------------------------------------------------------------
// The appointment book
// ---------------------------------------------------------------------------
export function createAppointmentBook({ clinic, file }) {
  const types = clinic.appointmentTypes;
  const doctors = clinic.doctors?.length ? clinic.doctors : [{ name: '' }];
  const enabled = doctors.some((d) => Object.values(d.schedule || clinic.schedule || {}).some((w) => w?.length));
  const now = () => clinicNow(clinic.timeZone);

  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  };
  const save = (list) => fs.writeFileSync(file, JSON.stringify(list, null, 2));

  const doctorLabel = (name) => name || 'the next available doctor';
  const describe = (a) => ({
    reference: a.reference,
    patient_name: a.patient_name,
    appointment_type: types[a.appointment_type]?.label || a.appointment_type,
    doctor: doctorLabel(a.doctor),
    date: a.date,
    time: a.time,
    spoken: `${spokenDate(a.date)} at ${spokenTime(a.time)}${a.doctor ? ` with ${a.doctor}` : ''}`,
  });

  // Doctors matching what the caller asked for (all of them if they have no preference)
  function pickDoctors(requested) {
    const wanted = nameTokens(requested).filter((t) => !['dr', 'doctor', 'the', 'any', 'anyone', 'next', 'available', 'first'].includes(t));
    if (!wanted.length || !clinic.doctors?.length) return doctors;
    return doctors.filter((d) => {
      const have = nameTokens(d.name);
      return wanted.every((t) => have.includes(t));
    });
  }

  // Free start times for one doctor on one date
  function freeTimes(date, doctor, minutes, ignoreReference, appointments) {
    const today = now();
    if (date < today.date || date > addDays(today.date, clinic.bookingDaysAhead)) return [];
    if (clinic.closedDates?.includes(date)) return [];
    const earliest = date === today.date ? toMinutes(today.time) + (clinic.minNoticeMinutes || 0) : 0;
    const taken = appointments
      .filter((a) => a.status === 'booked' && a.date === date && a.doctor === doctor.name && a.reference !== ignoreReference)
      .map((a) => [toMinutes(a.time), toMinutes(a.time) + a.minutes]);
    const windows = (doctor.schedule || clinic.schedule || {})[weekday(date)] || [];

    const times = [];
    for (const window of windows) {
      const [start, end] = window.split('-').map((t) => toMinutes(t.trim()));
      for (let t = start; t + minutes <= end; t += minutes) {
        if (t >= earliest && !taken.some(([s, e]) => t < e && t + minutes > s)) times.push(toHHMM(t));
      }
    }
    return times;
  }

  // Pick up to MAX_OFFERED slots spread across the day, so callers get real choices
  function spread(slots) {
    if (slots.length <= MAX_OFFERED) return slots;
    const step = (slots.length - 1) / (MAX_OFFERED - 1);
    return Array.from({ length: MAX_OFFERED }, (_, i) => slots[Math.round(i * step)]);
  }

  function checkAvailability({ appointment_type, date, doctor, part_of_day }) {
    if (!enabled) {
      return {
        available: [],
        note: 'Online booking is not set up yet. Apologise, and offer to take a callback request so the clinic team can arrange the appointment.',
      };
    }
    const docs = pickDoctors(doctor);
    if (!docs.length) {
      return { available: [], note: `There is no doctor by that name. The clinic's doctors are: ${clinic.doctors.map((d) => d.name).join(', ')}.` };
    }
    const minutes = types[appointment_type]?.minutes || 20;
    const appointments = load();
    const today = now().date;
    const lastDay = addDays(today, clinic.bookingDaysAhead);
    if (isDate(date) && date > lastDay) {
      return { available: [], note: `Appointments can only be booked up to ${clinic.bookingDaysAhead} days ahead, until ${spokenDate(lastDay)}.` };
    }

    const inPart = (time) =>
      part_of_day === 'morning' ? time < '12:00' : part_of_day === 'afternoon' ? time >= '12:00' : true;
    const slotsOn = (day) =>
      docs
        .flatMap((doc) => freeTimes(day, doc, minutes, null, appointments).filter(inPart).map((time) => ({ doctor: doc.name, date: day, time })))
        .sort((a, b) => a.time.localeCompare(b.time));

    const first = isDate(date) && date >= today ? date : today;
    let slots = slotsOn(first);
    let note = '';
    if (!slots.length) {
      // Nothing that day: find the nearest day that has something
      for (let day = addDays(first, 1); day <= lastDay && !slots.length; day = addDays(day, 1)) slots = slotsOn(day);
      if (isDate(date)) note = `Nothing is free on ${spokenDate(date)}${part_of_day && part_of_day !== 'any' ? ` in the ${part_of_day}` : ''}. These are the nearest other options.`;
    }
    if (!slots.length) note = 'No appointments are free in the booking window. Offer a callback request.';

    return {
      available: spread(slots).map((s) => ({
        doctor: doctorLabel(s.doctor),
        date: s.date,
        time: s.time,
        spoken: `${spokenDate(s.date)} at ${spokenTime(s.time)}${s.doctor ? ` with ${s.doctor}` : ''}`,
      })),
      note,
    };
  }

  function book(args, call) {
    const date = args.date;
    const time = cleanTime(args.time);
    if (!enabled) return { success: false, error: 'Online booking is not set up yet. Offer a callback request.' };
    if (!types[args.appointment_type]) return { success: false, error: 'Unknown appointment type.' };
    if (!isDate(date) || !time) return { success: false, error: 'Date must be YYYY-MM-DD and time HH:MM. Use a slot from check_availability.' };
    // Say exactly what's missing, so the receptionist doesn't ask again for details the caller already gave
    if (!args.patient_name?.trim()) return { success: false, error: "The patient's full name is missing. Ask for it." };
    if (digits(args.phone).length < 7) {
      return {
        success: false,
        error: `The phone number "${args.phone || ''}" has only ${digits(args.phone).length} digits; a phone number needs at least 7. ` +
          'Tell the caller the number you heard seems too short, and ask them to say the full number again. Do not ask for their name again.',
      };
    }
    if (clinic.requireDateOfBirth && digits(args.date_of_birth).length < 6) {
      return { success: false, error: "The patient's date of birth is required." };
    }

    const appointments = load();
    const minutes = types[args.appointment_type].minutes;
    const doctor = pickDoctors(args.doctor).find((d) => freeTimes(date, d, minutes, null, appointments).includes(time));
    if (!doctor) {
      return { success: false, error: 'That time is no longer available. Apologise and run check_availability again.' };
    }

    let reference;
    do reference = String(crypto.randomInt(100000, 1000000));
    while (appointments.some((a) => a.reference === reference));

    const appointment = {
      reference,
      status: 'booked',
      patient_name: args.patient_name.trim(),
      booked_by: args.booked_by?.trim() || '',
      phone: args.phone.trim(),
      caller_id: call.from || '',
      new_patient: !!args.new_patient,
      date_of_birth: args.date_of_birth || '',
      appointment_type: args.appointment_type,
      reason: args.reason || '',
      notes: args.notes || '',
      doctor: doctor.name,
      date,
      time,
      minutes,
      booked_at: new Date().toISOString(),
    };
    appointments.push(appointment);
    save(appointments);
    call.verified.add(reference);
    console.log('APPOINTMENT BOOKED:', describe(appointment));
    return { success: true, ...describe(appointment), reference_spoken: reference.split('').join(' ') };
  }

  // Find a caller's upcoming appointments. Matching marks them as verified for this call,
  // which is what allows reschedule() and cancel() to touch them.
  function find({ patient_name, phone, reference, date_of_birth }, call) {
    const today = now().date;
    const found = load().filter((a) => {
      if (a.status !== 'booked' || a.date < today || !namesMatch(a.patient_name, patient_name)) return false;
      const proven = (reference && digits(reference) === a.reference) || phonesMatch(a.phone, phone);
      const dobOk = !clinic.requireDateOfBirth || !a.date_of_birth || datesOfBirthMatch(a.date_of_birth, date_of_birth);
      return proven && dobOk;
    });
    found.forEach((a) => call.verified.add(a.reference));
    if (!found.length) {
      return {
        appointments: [],
        note: 'No upcoming appointment matches those details. Do not reveal anything about other appointments. Ask the caller to check the details, or offer a callback from the clinic team.',
      };
    }
    return { appointments: found.map(describe) };
  }

  function reschedule({ reference, new_date, new_time, doctor }, call) {
    const ref = digits(reference);
    if (!call.verified.has(ref)) return { success: false, error: 'Verify the caller with find_appointment first.' };
    const appointments = load();
    const appt = appointments.find((a) => a.reference === ref && a.status === 'booked');
    if (!appt) return { success: false, error: 'That appointment is no longer active.' };
    const time = cleanTime(new_time);
    if (!isDate(new_date) || !time) return { success: false, error: 'Date must be YYYY-MM-DD and time HH:MM. Use a slot from check_availability.' };

    const candidates = doctor ? pickDoctors(doctor) : doctors.filter((d) => d.name === appt.doctor);
    const newDoctor = candidates.find((d) => freeTimes(new_date, d, appt.minutes, appt.reference, appointments).includes(time));
    if (!newDoctor) return { success: false, error: 'That time is not available. Apologise and run check_availability again.' };

    const before = describe(appt).spoken;
    appt.history = [...(appt.history || []), { changed_at: new Date().toISOString(), from: `${appt.date} ${appt.time} ${appt.doctor}` }];
    Object.assign(appt, { date: new_date, time, doctor: newDoctor.name });
    save(appointments);
    console.log(`APPOINTMENT RESCHEDULED: ${appt.reference} from ${before} to ${describe(appt).spoken}`);
    return { success: true, previously: before, ...describe(appt), phone: appt.phone };
  }

  function cancel({ reference }, call) {
    const ref = digits(reference);
    if (!call.verified.has(ref)) return { success: false, error: 'Verify the caller with find_appointment first.' };
    const appointments = load();
    const appt = appointments.find((a) => a.reference === ref && a.status === 'booked');
    if (!appt) return { success: false, error: 'That appointment is no longer active.' };
    Object.assign(appt, { status: 'cancelled', cancelled_at: new Date().toISOString() });
    save(appointments);
    console.log('APPOINTMENT CANCELLED:', describe(appt));
    return { success: true, cancelled: describe(appt) };
  }

  // For the staff dashboard: today's and future appointments, soonest first
  const upcoming = () =>
    load()
      .filter((a) => a.date >= now().date)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  return { enabled, doctors, now, checkAvailability, book, find, reschedule, cancel, upcoming };
}
