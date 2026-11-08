// Fake phone calls for the relay engine (Twilio ConversationRelay, text in / text out).
// Talks to the receptionist exactly the way ConversationRelay does, with Gemini playing each patient,
// then checks the appointment book and messages. Uses the test clinic, never the real data.
//
// Usage:  npm test     (needs GEMINI_API_KEY in .env)

import 'dotenv/config';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { TEST_ENV, CALLER_ID, seed, readState, SCENARIOS, nextCallerLine, report } from './test-scenarios.js';

const PORT = 3999;
const MAX_TURNS = 16; // includes the rating question at the end
const QUIET_MS = 1500; // a tool round can send a second reply segment, so wait this long after one ends

function runScenario(sc) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const lines = ["Receptionist: Hello! Thank you for calling Lily's Clinic. I'm your virtual receptionist. How can I help you today?"];
    const waits = [];
    let handoff = { action: 'none' };
    let reply = '';
    let quietTimer = null;
    let askedAt = 0;
    let turns = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      ws.close();
      resolve({ handoff, transcript: lines.join('\n'), waits });
    };

    const callerSpeaks = async () => {
      if (done) return;
      if (++turns > MAX_TURNS) return finish();
      const line = await nextCallerLine(sc.persona, lines.join('\n'));
      if (done) return;
      lines.push(`Caller: ${line}`);
      console.log(`  Caller:       ${line}`);
      askedAt = Date.now();
      ws.send(JSON.stringify({ type: 'prompt', voicePrompt: line, last: true }));
      // If the receptionist stays quiet (waiting for the caller to finish), keep talking like a real caller
      clearTimeout(quietTimer);
      quietTimer = setTimeout(callerSpeaks, 8000);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'setup', from: sc.callerId || CALLER_ID, to: process.env.TWILIO_NUMBER, direction: 'inbound', callSid: 'CAtest' }));
      callerSpeaks();
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'text') {
        if (askedAt) {
          waits.push((Date.now() - askedAt) / 1000);
          askedAt = 0;
        }
        reply += msg.token;
        clearTimeout(quietTimer);
        if (msg.last) {
          if (reply.trim()) {
            lines.push(`Receptionist: ${reply.trim()}`);
            console.log(`  Receptionist: ${reply.trim()}`);
          }
          reply = '';
          quietTimer = setTimeout(callerSpeaks, QUIET_MS);
        }
      } else if (msg.type === 'end') {
        handoff = JSON.parse(msg.handoffData || '{}');
        console.log(`  >> handoff: ${msg.handoffData}`);
        finish();
      }
    });

    ws.on('error', (e) => {
      console.log('  WebSocket error:', e.message);
      finish();
    });
  });
}

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, ...TEST_ENV, PORT, VOICE_ENGINE: 'relay' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes('listening') && r()));

let passed = 0;
const allWaits = [];
// ONLY=2 runs just the second scenario, ONLY=2,3 the second and third
const only = process.env.ONLY?.split(',').map(Number);
const scenarios = SCENARIOS.filter((sc, i) => (!only || only.includes(i + 1)) && !sc.liveOnly);
for (const sc of scenarios) {
  console.log(`\n=== ${sc.name}`);
  seed();
  const result = await runScenario(sc);
  await new Promise((r) => setTimeout(r, 1000)); // the server saves the call record when the line closes
  // Some checks need the automatic call review (it runs in the background after the call)
  for (let i = 0; sc.waitForReview && i < 90 && !readState().calls[0]?.review && !readState().calls[0]?.reviewError; i++) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (sc.waitForReview) await new Promise((r) => setTimeout(r, 3000)); // gaps are saved just after the review
  allWaits.push(...result.waits);
  if (report(sc.name, sc.check({ ...result, ...readState() }))) passed++;
}

allWaits.sort((a, b) => a - b);
const avg = allWaits.reduce((a, b) => a + b, 0) / (allWaits.length || 1);
const pick = (q) => allWaits[Math.min(allWaits.length - 1, Math.floor(q * allWaits.length))] || 0;
console.log(`\n${passed}/${scenarios.length} scenarios passed. Engine: ConversationRelay (${process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'})`);
console.log(
  `Reply delay (caller finished -> first words): average ${avg.toFixed(1)}s, median ${pick(0.5).toFixed(1)}s, ` +
    `90% under ${pick(0.9).toFixed(1)}s, slowest ${pick(1).toFixed(1)}s over ${allWaits.length} replies\n`
);
server.kill();
process.exit(passed === scenarios.length ? 0 : 1);
