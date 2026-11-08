// Checks the knowledge base search: real caller questions (English and Arabic) must find the right section,
// and questions the clinic hasn't confirmed (TODO sections) or that aren't about the clinic must find nothing.
//
// Usage:  npm run test-knowledge          (needs GEMINI_API_KEY in .env)
//         CLINIC_CONFIG=clinics/<clinic>/clinic.js npm run test-knowledge

import 'dotenv/config';
import path from 'path';
import { pathToFileURL } from 'url';
import { GoogleGenAI } from '@google/genai';
import { createKnowledgeBase } from './knowledge.js';

const configPath = path.resolve(process.env.CLINIC_CONFIG || 'clinics/lily/clinic.js');
const clinic = (await import(pathToFileURL(configPath).href)).default;
const kb = createKnowledgeBase({
  dir: path.resolve(path.dirname(configPath), clinic.knowledgeDir || 'knowledge'),
  gemini: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }),
});
await kb.ready;

// [question, part of the expected section's topic, or null = nothing should be found]
const CASES = [
  ['What should I bring to my first appointment?', 'What to bring'],
  ['How early should I come before my appointment?', 'Arriving'],
  ["I'm stuck in traffic and will be 20 minutes late", 'Running late'],
  ['Can my husband come in with me?', 'Bringing someone'],
  ['Do the doctors speak Arabic?', 'Languages'],
  ['What is the difference between a checkup and a consultation?', 'Types of appointment'],
  ['Can I see a doctor today?', 'Same-day'],
  ['Can I just walk in without an appointment?', 'Walk-ins'],
  ['How much notice do I need to give to cancel?', 'Cancelling'],
  ['Is there a waiting list if nothing is free this week?', 'Waiting list'],
  ['Can I book an appointment for my mother?', 'family member'],
  ['Can my 15 year old son come alone?', 'Children'],
  ['I need a refill of my blood pressure medicine', 'Repeat prescriptions'],
  ['How long does a prescription renewal take?', 'How long a repeat prescription'],
  ["I've run out of my insulin", 'Running out'],
  ['Are my blood test results back?', 'results'],
  ['How long do blood results usually take?', 'How long results take'],
  ['Do I need to fast before my blood test?', 'Preparing for a blood test'],
  ['I want a copy of my medical file', 'copy of your medical records'],
  ['I need a sick note for work', 'Sick notes'],
  ['What happened with my referral to the cardiologist?', 'Referrals'],
  ['Can I pay by credit card?', 'How to pay'],
  ['I think I was charged twice', 'Questions about a bill'],
  ['I want to make a complaint about how I was treated', 'complaint'],
  ['Who can see my medical information?', 'Privacy'],
  ['ممكن أحجز لماما؟', 'family member'],
  ['عايز أجدد الروشتة بتاعة دوا الضغط', 'prescription'],
  ['نتيجة التحاليل طلعت؟', 'results'],
  ['أنا متأخر ربع ساعة', 'Running late'],
  ['عايز أقدم شكوى', 'complaint'],
  ['Is there free parking?', 'Parking'],
  ['What is the address of the clinic?', 'Location'],
  ['Do you accept AXA insurance?', 'Insurance companies'],
  ['How much does a consultation cost?', 'Consultation fees'],
  ['Do you do home visits?', 'Home visits'],
  ['Can I get my flu shot at the clinic?', 'Vaccinations'],
  ['Can I have a video appointment?', 'Online or phone'],
  ['Is the clinic wheelchair accessible?', 'Accessibility'],
  ['What services do you offer?', 'Services the clinic offers'],
  ['العيادة فين؟', 'Location'],
  ['الكشف بكام؟', 'Consultation fees'],
  ['بتاخدوا تأمين؟', 'Insurance'],
  // Not about the clinic: nothing should come back
  ["What's the weather like tomorrow?", null],
  ['Who won the football match yesterday?', null],
];

let passed = 0;
for (const [question, expected] of CASES) {
  const answer = await kb.lookup(question);
  // A question the clinic has answered must bring back that section (first or second);
  // anything else must come back as not found, so the receptionist says it isn't confirmed
  const pass =
    expected === null
      ? !answer.found
      : answer.found && answer.results.slice(0, 2).some((r) => r.topic.toLowerCase().includes(expected.toLowerCase()));
  if (pass) passed++;
  const got = answer.found ? answer.results.map((r) => r.topic).join(' | ') : `not found${answer.topic ? ` (TODO: ${answer.topic})` : ''}`;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${question}\n       -> ${got}`);
}
console.log(`\n${passed}/${CASES.length} knowledge searches correct (${kb.size} sections, ${kb.skipped.length} TODO left out)`);
process.exit(passed === CASES.length ? 0 : 1);
