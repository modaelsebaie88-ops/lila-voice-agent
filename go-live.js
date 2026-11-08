// One command to go live from this computer:
//   1. starts the agent (server.js)
//   2. opens a free public HTTPS link with Cloudflare Tunnel (no account needed)
//   3. points your Twilio number's "A call comes in" webhook at that link
//
// Usage:  npm run live
// Keep this window open: closing it (or turning off the PC) takes the number offline.

import 'dotenv/config';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 3000;
const CLOUDFLARED = path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_NUMBER: NUMBER } = process.env;

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

for (const key of ['GEMINI_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER']) {
  if (!process.env[key] || process.env[key].includes('PASTE')) fail(`${key} is missing in the .env file.`);
}
if (!fs.existsSync(CLOUDFLARED)) fail(`cloudflared not found at ${CLOUDFLARED}`);

const twilioAuth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const twilioBase = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;

async function connectTwilio(publicUrl) {
  const number = NUMBER.replace(/[^\d+]/g, '');
  const list = await fetch(`${twilioBase}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`, {
    headers: { Authorization: twilioAuth },
  });
  if (list.status === 401) fail('Twilio rejected the Account SID / Auth Token. Re-copy them from the Twilio Console home page.');
  const found = (await list.json()).incoming_phone_numbers?.[0];
  if (!found) fail(`Number ${number} was not found in this Twilio account. Check TWILIO_NUMBER (format +12125551234).`);

  const update = await fetch(`${twilioBase}/IncomingPhoneNumbers/${found.sid}.json`, {
    method: 'POST',
    headers: { Authorization: twilioAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ VoiceUrl: `${publicUrl}/voice`, VoiceMethod: 'POST' }),
  });
  if (!update.ok) fail(`Twilio update failed: ${update.status} ${await update.text()}`);

  // The web phone's TwiML App needs the same link (optional; npm run setup-web-phone creates it)
  if (process.env.TWILIO_TWIML_APP_SID) {
    const app = await fetch(`${twilioBase}/Applications/${process.env.TWILIO_TWIML_APP_SID}.json`, {
      method: 'POST',
      headers: { Authorization: twilioAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ VoiceUrl: `${publicUrl}/voice`, VoiceMethod: 'POST' }),
    });
    if (!app.ok) console.error(`Could not update the web phone app: ${app.status} ${await app.text()}`);
  }
  return found.phone_number;
}

// 1. Agent
const server = spawn(process.execPath, ['server.js'], { stdio: 'inherit', env: { ...process.env, PORT } });
server.on('exit', (code) => fail(`Agent stopped (exit code ${code}).`));

// 2. Public link
const tunnel = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
let connected = false;
const watch = async (chunk) => {
  const url = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (!url || connected) return;
  connected = true;

  // Give the tunnel a moment to finish registering before Twilio starts using it
  await new Promise((r) => setTimeout(r, 4000));

  // 3. Twilio
  const phone = await connectTwilio(url);
  console.log(`
==========================================================
  LIVE!  Call ${phone} to talk to the receptionist.

  Public link : ${url}
  Front desk  : ${url}/dashboard?key=${process.env.DASHBOARD_KEY || 'change-me'}
  Web phone   : ${process.env.TWILIO_TWIML_APP_SID ? `${url}/phone?key=${process.env.DASHBOARD_KEY || 'change-me'}` : 'not set up (npm run setup-web-phone)'}

  Keep this window open. Press Ctrl+C to stop.
==========================================================
`);
};
tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);
tunnel.on('exit', (code) => fail(`Tunnel stopped (exit code ${code}).`));

process.on('SIGINT', () => {
  tunnel.kill();
  server.kill();
  process.exit(0);
});
