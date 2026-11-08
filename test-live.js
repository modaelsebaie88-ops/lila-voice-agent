// Fake phone calls for the Gemini Live engine (Windows only).
// Acts like Twilio's Media Stream: Gemini plays each patient, every line is spoken as real audio
// (Windows built-in voice) and streamed in Twilio's 8 kHz mu-law format, and the receptionist's
// spoken replies come back the same way. Then the appointment book and messages are checked.
// Uses the test clinic, never the real data.
//
// Usage:  npm run test-live      (needs GEMINI_API_KEY in .env)

import 'dotenv/config';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import WebSocket from 'ws';
import { GoogleGenAI } from '@google/genai';
import { prepareGreeting } from './live-call.js';
import { TEST_ENV, CALLER_ID, seed, readState, SCENARIOS, nextCallerLine, report } from './test-scenarios.js';

const PORT = 3995;
const AUDIO_DIR = path.join(process.cwd(), 'test-audio');
const FRAME = 160; // 20 ms of 8 kHz mu-law
const MAX_TURNS = 14;
const QUIET_MS = 1500; // the receptionist has finished once her audio has played and this much silence followed
const SCENARIO_LIMIT_MS = 360000; // Arabic turns are longer to say

// --- caller audio: text -> 8 kHz 16-bit WAV (Windows voice) -> mu-law frames ---------------
function sampleToMulaw(sample) {
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  return ~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f)) & 0xff;
}

const toFrames = (mulaw) => {
  const frames = [];
  for (let i = 0; i < mulaw.length; i += FRAME) frames.push(mulaw.subarray(i, i + FRAME));
  return frames;
};

// Windows has no Arabic voice, so Arabic lines are spoken by a Gemini voice (a different one from the receptionist's)
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function geminiSpeechFrames(text) {
  const file = path.join(AUDIO_DIR, crypto.createHash('sha1').update(text).digest('hex').slice(0, 16) + '.ulaw');
  if (!fs.existsSync(file)) {
    const audio = await prepareGreeting({ gemini, model: process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-latest', voice: 'Charon', text });
    if (!audio) throw new Error(`could not voice the caller's line: ${text}`);
    fs.writeFileSync(file, audio);
  }
  return toFrames(fs.readFileSync(file));
}

async function speechFrames(text) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  if (/[؀-ۿ]/.test(text)) return geminiSpeechFrames(text);
  const file = path.join(AUDIO_DIR, text.replace(/[^a-z0-9]+/gi, '_').slice(0, 80) + '.wav');
  if (!fs.existsSync(file)) {
    const ps =
      'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(8000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); " +
      `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}', $f); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`;
    execFileSync('powershell', ['-NoProfile', '-Command', ps]);
  }
  const wav = fs.readFileSync(file);
  const data = wav.indexOf(Buffer.from('data')) + 8;
  const mulaw = Buffer.alloc((wav.length - data) >> 1);
  for (let i = 0; i < mulaw.length; i++) mulaw[i] = sampleToMulaw(wav.readInt16LE(data + i * 2));
  return toFrames(mulaw);
}

// --- reading the server log for this call ---------------------------------------------------
const HANDOFF = /Handoff: \{ action: '(\w+)'(?:,\s*outcome: '(\w+)')?/;

function callLog(serverLog, from) {
  const lines = serverLog.text.slice(from).split('\n');
  const said = lines.filter((l) => /^Receptionist: (?!\[calls)/.test(l)).map((l) => l.replace(/ \(interrupted\)$/, ''));
  // A tool is running (or Gemini is answering with its result) if the latest event is a tool line
  const events = lines.filter((l) => /^Receptionist: |^ {2}\w+ ->|^Caller: /.test(l));
  const last = events[events.length - 1] || '';
  const toolPending = /^Receptionist: \[calls|^ {2}\w+ ->/.test(last);
  const m = serverLog.text.slice(from).match(HANDOFF);
  return { said, toolPending, handoff: m ? { action: m[1], outcome: m[2] } : null };
}

// --- one fake call --------------------------------------------------------------------------
function runScenario(sc, serverLog) {
  return new Promise((resolve) => {
    const logStart = serverLog.text.length;
    const ws = new WebSocket(`ws://localhost:${PORT}/media`);
    const transcript = [];
    const waits = [];
    const silence = Buffer.alloc(FRAME, 0xff);
    const started = Date.now();
    let speaking = []; // caller frames still to send
    let agentSpoke = false; // receptionist has replied since the caller last spoke
    let playbackEnd = 0; // when the receptionist's queued audio finishes playing
    let callerDoneAt = 0;
    let lastCallerAt = Date.now();
    let saidCount = 0;
    let turns = 0;
    let thinking = false; // generating the caller's next line
    let handoff = null;

    const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

    const syncTranscript = () => {
      const { said } = callLog(serverLog, logStart);
      for (; saidCount < said.length; saidCount++) transcript.push(said[saidCount]);
    };

    async function callerSpeaks() {
      thinking = true;
      syncTranscript();
      if (++turns > MAX_TURNS) return finish();
      const line = await nextCallerLine(sc.persona, transcript.join('\n'));
      transcript.push(`Caller: ${line}`);
      console.log(`  Caller:       ${line}`);
      speaking = await speechFrames(line);
      agentSpoke = false;
      thinking = false;
    }

    const timer = setInterval(() => {
      const now = Date.now();
      const frame = speaking.length ? speaking.shift() : silence;
      if (frame !== silence) {
        lastCallerAt = now;
        if (!speaking.length) callerDoneAt = now;
      }
      send({ event: 'media', streamSid: 'MZtest', media: { payload: frame.toString('base64') } });

      const state = callLog(serverLog, logStart);
      if (state.handoff) {
        handoff = state.handoff;
        // The closing line is played by Twilio, so a goodbye counts as the reply
        if (callerDoneAt) waits.push((now - callerDoneAt) / 1000);
        return finish();
      }
      if (now - started > SCENARIO_LIMIT_MS) return finish();

      // The caller answers once the receptionist has finished (or after a long silence)
      const agentDone = agentSpoke && now - playbackEnd > QUIET_MS && !state.toolPending;
      const longSilence = !speaking.length && now - Math.max(lastCallerAt, playbackEnd) > 12000;
      if (!thinking && !speaking.length && (agentDone || longSilence)) callerSpeaks();
    }, 20);

    function finish() {
      clearInterval(timer);
      setTimeout(() => {
        syncTranscript();
        ws.close();
        resolve({ handoff: handoff || { action: 'none' }, transcript: transcript.join('\n'), waits });
      }, 300);
    }

    ws.on('open', () => {
      send({ event: 'connected' });
      send({
        event: 'start',
        start: {
          streamSid: 'MZtest',
          callSid: 'CAtest',
          customParameters: { from: sc.callerId || CALLER_ID, to: process.env.TWILIO_NUMBER, direction: 'inbound' },
        },
      });
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'media') {
        if (callerDoneAt) {
          waits.push((Date.now() - callerDoneAt) / 1000);
          callerDoneAt = 0;
        }
        agentSpoke = true;
        // Audio takes as long to play as it would on a real phone (8 bytes per millisecond)
        playbackEnd = Math.max(Date.now(), playbackEnd) + Buffer.from(msg.media.payload, 'base64').length / 8;
      } else if (msg.event === 'mark') {
        // Twilio echoes a mark once all audio before it has played
        setTimeout(() => send({ event: 'mark', streamSid: 'MZtest', mark: msg.mark }), Math.max(0, playbackEnd - Date.now()));
      } else if (msg.event === 'clear') {
        playbackEnd = Date.now();
      }
    });
  });
}

// --- run --------------------------------------------------------------------------------------
const serverLog = { text: '' };
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, ...TEST_ENV, PORT, VOICE_ENGINE: 'live' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (serverLog.text += d));
server.stderr.on('data', (d) => (serverLog.text += d));
await new Promise((r) => server.stdout.on('data', (d) => d.toString().includes('listening') && r()));
const engine = serverLog.text.match(/voice engine: ([^;]+)/)?.[1] || 'Gemini Live';

let passed = 0;
const allWaits = [];
// ONLY=2 runs just the second scenario, ONLY=2,3 the second and third
const only = process.env.ONLY?.split(',').map(Number);
const scenarios = SCENARIOS.filter((_, i) => !only || only.includes(i + 1));
for (const sc of scenarios) {
  console.log(`\n=== ${sc.name}`);
  seed();
  const logStart = serverLog.text.length;
  const result = await runScenario(sc, serverLog);
  for (const line of serverLog.text.slice(logStart).split('\n')) {
    if (/^Receptionist: |^ {2}\w+ ->|rror|unexpectedly|dropped|giving up/.test(line) && !/Could not update the Twilio call/.test(line)) {
      console.log('  ' + line.replace(/^Receptionist: /, 'Receptionist: ').slice(0, 400));
    }
  }
  console.log(`  >> handoff: ${JSON.stringify(result.handoff)}   waits: ${result.waits.map((w) => w.toFixed(1) + 's').join(', ')}`);
  allWaits.push(...result.waits);
  if (report(sc.name, sc.check({ ...result, ...readState() }))) passed++;
}

allWaits.sort((a, b) => a - b);
const avg = allWaits.reduce((a, b) => a + b, 0) / (allWaits.length || 1);
const pick = (q) => allWaits[Math.min(allWaits.length - 1, Math.floor(q * allWaits.length))] || 0;
console.log(`\n${passed}/${scenarios.length} scenarios passed. Engine: ${engine}`);
console.log(
  `Reply delay (caller finished -> receptionist's voice): average ${avg.toFixed(1)}s, median ${pick(0.5).toFixed(1)}s, ` +
    `90% under ${pick(0.9).toFixed(1)}s, slowest ${pick(1).toFixed(1)}s over ${allWaits.length} replies\n`
);
server.kill();
process.exit(passed === scenarios.length ? 0 : 1);
