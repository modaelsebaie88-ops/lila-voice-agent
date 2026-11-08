// One-time setup for the web phone (call the receptionist from a browser).
// Creates, in your Twilio account:
//   - an API key (used to sign short-lived browser calling tokens)
//   - a TwiML App (tells Twilio to send browser calls to the receptionist)
// and saves TWILIO_API_KEY, TWILIO_API_SECRET and TWILIO_TWIML_APP_SID to .env.
// To remove them later: Twilio Console -> Account -> API keys, and Voice -> TwiML Apps.
//
// Usage:  npm run setup-web-phone     (then restart: npm run live)

import 'dotenv/config';
import fs from 'fs';

const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN } = process.env;
const base = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');

async function create(resource, fields) {
  const res = await fetch(`${base}/${resource}.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.message}`);
  return data;
}

if (process.env.TWILIO_API_KEY && process.env.TWILIO_TWIML_APP_SID) {
  console.log('\nThe web phone is already set up. Restart with: npm run live\n');
  process.exit(0);
}

// The current public link, if the agent is live, so the app works straight away (go-live.js keeps it updated)
const link = fs.existsSync('run.log') && fs.readFileSync('run.log', 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];

const key = await create('Keys', { FriendlyName: 'Lily Clinic web phone' });
const app = await create('Applications', {
  FriendlyName: 'Lily Clinic web phone',
  VoiceUrl: `${link || 'https://example.com'}/voice`,
  VoiceMethod: 'POST',
});

fs.appendFileSync(
  '.env',
  `\n# Web phone (created by npm run setup-web-phone)\nTWILIO_API_KEY=${key.sid}\nTWILIO_API_SECRET=${key.secret}\nTWILIO_TWIML_APP_SID=${app.sid}\n`
);
console.log(`\nWeb phone set up (API key ${key.sid}, TwiML App ${app.sid}). Restart with: npm run live\n`);
