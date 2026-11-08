// Makes your Twilio number call YOUR phone. When you pick up, the receptionist answers
// exactly as if you had called the clinic.
//
// Usage (works from any PC while the agent is live on the server):
//   npm run call-me -- +201012345678
// Or put MY_PHONE=+201012345678 in .env and just run:  npm run call-me
//
// Egyptian carriers often answer "busy" on some international routes. Twilio picks a
// route per attempt, so we retry automatically until one gets through.

import 'dotenv/config';

const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_NUMBER: FROM } = process.env;
const to = (process.argv[2] || process.env.MY_PHONE || '').replace(/[^\d+]/g, '');
const MAX_TRIES = Number(process.env.CALL_ME_TRIES || 8);

const API = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

async function twilio(path, body) {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: auth, ...(body && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: body && new URLSearchParams(body),
  });
  return { ok: res.ok, data: await res.json() };
}

if (!/^\+\d{8,15}$/.test(to)) fail('Give your phone number with + and country code, e.g.  npm run call-me -- +201012345678');

// The tunnel link changes on every restart; the live agent always points the Twilio number at it
const { data: nums } = await twilio(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(FROM)}`);
const url = nums.incoming_phone_numbers?.[0]?.voice_url;
if (!url) fail(`Could not read the voice link of ${FROM} from Twilio.`);

const health = await fetch(new URL('/', url)).catch(() => null);
if (!health?.ok) fail(`The agent is not live (${url} did not answer). Start it on the server first.`);

for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
  const { ok, data } = await twilio('/Calls.json', { To: to, From: FROM, Url: url, Method: 'POST' });
  if (!ok) {
    if (data.code === 21215 || data.code === 21408)
      fail(`Twilio is not allowed to call this country yet. Twilio Console -> Voice -> Settings -> Geo permissions -> tick your country -> Save, then try again.\n(${data.message})`);
    if (data.code === 21219) fail(`Trial accounts can only call verified numbers. ${data.message}`);
    fail(`Twilio refused the call: ${data.code} ${data.message}`);
  }

  console.log(`Attempt ${attempt}/${MAX_TRIES}: calling ${to} from ${FROM}... (Call ID ${data.sid})`);

  // Wait until the call either rings/connects or is rejected by the carrier
  let status = data.status;
  while (['queued', 'initiated'].includes(status)) {
    await sleep(2000);
    status = (await twilio(`/Calls/${data.sid}.json`)).data.status;
  }

  if (status === 'ringing') {
    console.log('  -> ringing. Pick up and talk to the receptionist...');
    // Follow the call until it is answered or ends, so a declined or dropped call doesn't look like a success
    while (status === 'ringing') {
      await sleep(2000);
      status = (await twilio(`/Calls/${data.sid}.json`)).data.status;
    }
    if (['in-progress', 'completed'].includes(status)) {
      console.log(`\nAnswered - you're talking to the receptionist.\n`);
      process.exit(0);
    }
    // It rang, so the route works: busy now means the call was declined or the phone was on another call
    fail(`Your phone rang, but the call ended as "${status}" (declined, no answer, or the line was busy). Run it again to retry.`);
  }
  if (['in-progress', 'completed'].includes(status)) {
    console.log(`\nAnswered - you're talking to the receptionist.\n`);
    process.exit(0);
  }
  console.log(`  -> ${status} (carrier rejected this route)`);
  if (status === 'no-answer' || status === 'canceled') break;
  if (attempt < MAX_TRIES) await sleep(4000);
}

fail(`Could not get through after ${MAX_TRIES} tries. Check the phone has signal and is not on another call, then run it again.`);
