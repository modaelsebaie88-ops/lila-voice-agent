# Lily's Clinic – AI Phone Receptionist (Twilio + Gemini)

A patient calls your Twilio number, or uses the web phone, and the virtual receptionist handles the call:

- **Books appointments**: collects name, phone (read back to confirm), new or returning patient, reason, appointment type, doctor, and preferred day. It offers only real free times, confirms before booking, and gives a booking reference. The code refuses any time that wasn't offered.
- **Reschedules and cancels** after verifying the caller (name plus booking reference or phone number).
- **Answers questions from the clinic's knowledge base** (RAG): it searches `clinics/<clinic>/knowledge/*.md` and answers only from what it finds. Anything not confirmed gets "I don't have that confirmed," plus an offer of a callback.
- **Speaks English and Egyptian Arabic**: it answers in the caller's language and switches when they do, closing lines included.
- **Handles requests for the clinic team**: prescription refills, test-result queries, medical records, referrals, sick notes and forms, billing questions, complaints, running late, and a waiting list. Each is saved with its own label on the front desk page; urgent ones are highlighted.
- **Handles difficult calls**: upset callers, abusive callers, sales calls and wrong numbers (ended politely, nothing saved), bookings for a child or relative, and mental-health crises (crisis line plus emergency number).
- **Urgent symptoms** (chest pain, breathing trouble, and so on): stops and tells the caller to contact emergency services.
- **Takes callback requests**, or transfers to a real person if `STAFF_NUMBER` is set.
- **Learns from every call** (feedback loop): see below.
- **Front desk page** at `/dashboard?key=DASHBOARD_KEY`: upcoming appointments, callback requests, emergencies, and calls that ended early or broke down.

## Voice engines (`VOICE_ENGINE` in `.env`)
- `live` (default): **Gemini Live native audio**. Gemini hears the caller and answers in its own voice.
  - The greeting is pre-recorded in the same voice and plays the instant the call connects.
  - We detect when the caller starts and stops talking (Gemini 2.5's own detection misses short answers like "yes").
  - If Google drops the session (error 1011), the call reconnects and carries on.
- `relay`: Twilio turns speech into text, `GEMINI_MODEL` replies in text, and Twilio speaks it. A reliable fallback. English only: Arabic needs the `live` engine.

## Files
| File | What it is |
|---|---|
| `clinics/lily/clinic.js` | Lily's Clinic settings: name, languages, greeting, hours, doctors, schedule, emergency numbers. |
| `clinics/lily/knowledge/*.md` | Lily's **knowledge base**: policies, procedures, and FAQs the receptionist searches during calls. |
| `clinics/_template/` | A blank clinic to copy for each new client. |
| `knowledge.js` | The knowledge base search (Gemini embeddings plus keyword matching). |
| `feedback.js` | The feedback loop: call records, automatic reviews, knowledge gaps, learned rules. |
| `review.js` | The Review page for the clinic team (`/review?key=DASHBOARD_KEY`). |
| `server.js` | The receptionist: prompt, tools, Twilio webhooks, front desk page, web phone. |
| `live-call.js` | The Gemini Live audio bridge (audio conversion, greeting, turn detection, reconnects). |
| `appointments.js` | The appointment book (free slots, booking, verification). |
| `go-live.js` | `npm run live`: starts everything, opens a public link, points your Twilio number and web phone at it. |
| `call-me.js` | `npm run call-me`: your Twilio number calls your phone (`MY_PHONE`). |
| `setup-web-phone.js` | `npm run setup-web-phone`: one-time setup for calling from a browser. |
| `test-*.js` | Automatic test calls against a made-up clinic (`test-clinic.js`), never the real data. `test-knowledge.js` checks the knowledge base search. |

## Adding a new clinic (client)
1. Copy `clinics/_template` to `clinics/<clinic-name>`.
2. Fill in `clinic.js`: name, languages, greeting, time zone, hours, doctors, schedule, emergency and crisis numbers.
3. Fill in the `knowledge/*.md` files with the clinic's own answers. Each `## ` heading is one searchable entry, written the way you'd say it on the phone. Leave anything unconfirmed as `TODO`; the receptionist then says she doesn't have it confirmed instead of guessing. Add new files or sections freely.
4. Set `CLINIC_CONFIG=clinics/<clinic-name>/clinic.js` in `.env` and restart.
5. Run `npm run test-knowledge` with the same `CLINIC_CONFIG` after editing its questions to match the clinic, to check the search finds the right answers.

## Knowledge base (RAG)
- At startup, every `## ` section is embedded with Gemini (`gemini-embedding-001`) and cached in `knowledge/.embeddings-cache.json`, so only changed sections are re-embedded.
- During a call, the receptionist calls `search_clinic_info` with the caller's question. The search combines meaning (works across English and Arabic) with exact keywords, and returns the best sections. If the best match is a `TODO` section, it returns "not confirmed".
- If the embedding service is unreachable, the search falls back to keywords only, so calls keep working.
- Lily's Clinic's policies are **demo values** modelled on common practice at international clinics. Confirm them with the clinic before going live. The address, fees, insurance, services, and parking are left as `TODO` on purpose.

## Feedback loop (`/review?key=DASHBOARD_KEY`)
Every call makes the receptionist better, with the clinic team in control:
1. **Every call is saved** (`calls.json`, the latest 1000) with its transcript, the tools used, the outcome, and the caller's rating.
2. **Automatic review**: Gemini (`REVIEW_MODEL`, default `gemini-3.5-flash`) checks each call against the receptionist's own instructions: what the caller needed, whether it was met, a 1–5 quality score, any mistakes (with the exact words), and one suggestion.
3. **Caller rating**: at the end of a normal call she asks for a rating from 1 to 5 (`askForRating` in `clinic.js`). Never after an emergency, a crisis, a sales call, or with an upset caller.
4. **Questions to answer**: every question she couldn't answer is grouped with similar ones (`knowledge-gaps.json`) and ranked by how often callers ask. Staff type the answer on the Review page; it fills in the matching TODO section or becomes a new entry in `knowledge/90-answers-from-calls.md`, and **the next call uses it, without a restart**.
5. **Staff verdicts and learned rules**: staff mark calls good or bad with a note. "Suggest improvements" asks Gemini to draft rules from the bad calls and serious review findings. **A rule only reaches her instructions once someone approves it** (`learned-rules.json` in the clinic folder). Staff can also write rules themselves.

Callers' words are treated as data everywhere: nothing a caller says changes her behaviour without a person approving it. Calls with sensitive details stay on your server, behind the dashboard key.

**When deploying an update**, don't overwrite the server's `clinics/<clinic>/knowledge/` folder or `learned-rules.json`: once staff answer questions on the Review page, the server's copy is the up-to-date one. Copy it back to your computer first if you want to edit it there.

## Setup
1. Copy `.env.example` to `.env` and fill it in.
2. Twilio Console → Voice → Settings → General: accept the **AI/ML Features Addendum** if it's shown.
3. `npm install`, then `npm run setup-web-phone` (optional, for browser calls).
4. Make sure the computer's clock is right (Windows Settings → Time & language → **Sync now**). The server warns at startup if it's off.

## Run and test
- `npm run live` makes the number and web phone live. Keep the window open. The free link changes on each start, and the script updates Twilio automatically.
- Web phone: `https://<link>/phone?key=DASHBOARD_KEY`. Calls over the internet, so no phone carrier is involved.
- `npm run call-me` makes the receptionist call you. Some carriers reject the first attempt; retry after a minute.
- `npm test` runs 21 test calls on the relay engine (text), including Arabic, the knowledge base, refills, complaints, a parent booking for a child, a sales call, and a crisis call.
- `npm run test-knowledge` checks 36 knowledge base searches (English and Arabic, including unconfirmed and off-topic questions).
- `npm run test-live` runs the same calls on Gemini Live with spoken audio (Windows only). `ONLY=2,5` runs just those scenarios. Run one test at a time, because both use the same test data files.

## Keeping it on 24/7
Deploy to Render or Railway as a Web Service (build `npm install`, start `npm start`), add the `.env` values as environment variables, and set the Twilio number's **A call comes in** webhook to `https://your-app/voice` (HTTP POST). Use a paid plan, because free plans sleep and the first call takes about 30 seconds to connect.
