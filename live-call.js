// Gemini Live engine: the caller's voice goes straight to Gemini's native-audio model,
// and Gemini answers in its own voice. No separate speech-to-text or text-to-speech step.
//
//   Phone <-> Twilio Media Stream (8 kHz mu-law) <-> this file <-> Gemini Live (PCM 8 kHz in, 24 kHz out)
//
// - The greeting is recorded once in the receptionist's voice and played the instant a call connects.
// - We detect when the caller starts and stops talking and tell Gemini (Gemini 2.5's own detection
//   misses short answers like "yes").
// - Look-ups and bookings return a result to Gemini and the conversation carries on. When Gemini ends
//   the call (end_call, transfer_to_staff), Twilio finishes playing what the receptionist was saying,
//   then plays the closing line (same "Aoede" voice family) and hangs up or transfers.
// - If Gemini drops the session (it sometimes does, error 1011), we reconnect and carry on.

import { Modality } from '@google/genai';

// ---------------------------------------------------------------------------
// Audio conversion between Twilio (8 kHz mu-law) and Gemini (16-bit PCM), using lookup tables
// ---------------------------------------------------------------------------
const MULAW_TO_PCM = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sample = ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 0x07)) - 0x84;
  MULAW_TO_PCM[i] = u & 0x80 ? -sample : sample;
}

const PCM_TO_MULAW = new Uint8Array(65536); // indexed by sample + 32768
for (let i = 0; i < 65536; i++) {
  let sample = i - 32768;
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  sample = Math.min(sample, 32635) + 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  PCM_TO_MULAW[i] = ~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 0x0f)) & 0xff;
}

// Twilio mu-law -> 16-bit PCM samples (8 kHz)
function mulawToPcm(mulaw) {
  const pcm = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) pcm[i] = MULAW_TO_PCM[mulaw[i]];
  return pcm;
}

// Gemini 16-bit PCM (24 kHz) -> mu-law (8 kHz) for Twilio: averages each group of 3 samples,
// carrying leftovers into the next chunk so nothing is lost between chunks
function createDownsampler() {
  let carry = new Int16Array(0);
  return (bytes) => {
    if (bytes.byteOffset % 2) bytes = Buffer.from(bytes); // 16-bit view needs an even offset
    const input = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
    const samples = new Int16Array(carry.length + input.length);
    samples.set(carry);
    samples.set(input, carry.length);
    const count = Math.floor(samples.length / 3);
    const out = Buffer.alloc(count);
    for (let j = 0, k = 0; j < count; j++, k += 3) {
      out[j] = PCM_TO_MULAW[Math.round((samples[k] + samples[k + 1] + samples[k + 2]) / 3) + 32768];
    }
    carry = samples.slice(count * 3);
    return out;
  };
}

const pcmToBase64 = (pcm) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');

// Gemini Live 2.5 native audio closes the session (error 1011) when it calls a tool declared with
// `parametersJsonSchema`, so tools are declared in Gemini's own schema format (`parameters`, upper-case types)
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema, type: schema.type?.toUpperCase() };
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

const toLiveTools = (tools) =>
  tools.map(({ parametersJsonSchema, ...tool }) =>
    parametersJsonSchema ? { ...tool, parameters: toGeminiSchema(parametersJsonSchema) } : tool
  );

const speechConfig = (voice) => ({ languageCode: 'en-US', voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } });

// ---------------------------------------------------------------------------
// Instant greeting: recorded once in the receptionist's Gemini voice, played the moment a call connects
// ---------------------------------------------------------------------------
const greetings = new Map(); // "model|voice|text" -> Promise<mu-law audio, or null if recording failed>

export function prepareGreeting({ gemini, model, voice, text }) {
  const key = `${model}|${voice}|${text}`;
  if (!greetings.has(key)) {
    greetings.set(
      key,
      recordGreeting(gemini, model, voice, text).catch((err) => {
        console.error('Could not record the greeting; the receptionist will greet live instead:', err.message);
        greetings.delete(key); // try again on the next call
        return null;
      })
    );
  }
  return greetings.get(key);
}

function recordGreeting(gemini, model, voice, text) {
  return new Promise((resolve, reject) => {
    const toPhone = createDownsampler();
    const chunks = [];
    let session;
    const done = (err) => {
      clearTimeout(timer);
      session?.close();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => done(new Error('timed out')), 20000);
    gemini.live
      .connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: speechConfig(voice),
          systemInstruction: 'You record a phone greeting. Say exactly the text you are given, warmly and naturally, and nothing else.',
        },
        callbacks: {
          onmessage: (m) => {
            for (const part of m.serverContent?.modelTurn?.parts || []) {
              if (part.inlineData?.data) chunks.push(toPhone(Buffer.from(part.inlineData.data, 'base64')));
            }
            if (m.serverContent?.turnComplete) done(chunks.length ? null : new Error('no audio'));
          },
          onerror: (e) => done(new Error(e.message)),
          onclose: (e) => done(chunks.length ? null : new Error(`closed ${e.code} ${e.reason}`)),
        },
      })
      .then((s) => {
        session = s;
        s.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
      })
      .catch(done);
  });
}

// ---------------------------------------------------------------------------
// Turn detection: when the caller starts and stops talking, from their voice level
// ---------------------------------------------------------------------------
const FRAME_MS = 20; // Twilio sends 20 ms of audio per media message
const SPEECH_START_FRAMES = 4; // 80 ms of speech = the caller started talking
const BARGE_IN_FRAMES = 10; // allowInterruptions: 200 ms of speech while the receptionist talks interrupts her
const MAX_HELD_FRAMES = 500; // up to 10 s of what the caller says while the receptionist is talking
const SPEECH_END_FRAMES = 40; // 800 ms of quiet = the caller finished (shorter splits spelled names)
const DIGITS_END_FRAMES = 75; // 1.5 s after asking for a number: people pause between groups of digits
const ASKED_FOR_DIGITS = /phone number|number to reach|booking reference|reference number|date of birth|spell/i;
const PRE_ROLL_FRAMES = 25; // 500 ms kept from just before speech was detected, so first syllables aren't lost
const MIN_SPEECH_LEVEL = 250; // quiet browser microphones speak at roughly 400-1000
// Phone lines are louder: callers speak at roughly 1800-9000, while line noise blips reach 300-500 and would cut her off
const MIN_PHONE_SPEECH_LEVEL = 700;
const SPEECH_OVER_NOISE = 2.5; // speech must be this many times louder than the line's background noise

function createSpeechTracker(minLevel = () => MIN_SPEECH_LEVEL) {
  let noiseFloor = 150;
  let peak = 0;
  let loud = 0;
  let quiet = 0;
  let speaking = false;
  let startedAt = 0;
  // Returns { event: 'start' }, { event: 'end', ... } or null for each 20 ms frame
  return (pcm, now, startFrames = SPEECH_START_FRAMES, endFrames = SPEECH_END_FRAMES) => {
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += Math.abs(pcm[i]);
    const level = sum / (pcm.length || 1);
    const isLoud = level > Math.max(minLevel(), noiseFloor * SPEECH_OVER_NOISE);
    if (!isLoud) {
      noiseFloor = noiseFloor * 0.98 + level * 0.02; // adapt to the line's background noise
      loud = 0;
      if (speaking && ++quiet >= endFrames) {
        speaking = false;
        return { event: 'end', ms: now - quiet * FRAME_MS - startedAt, peak: Math.round(peak), noise: Math.round(noiseFloor) };
      }
      return null;
    }
    quiet = 0;
    if (speaking) peak = Math.max(peak, level);
    else if (++loud >= startFrames) {
      speaking = true;
      peak = level;
      startedAt = now - loud * FRAME_MS;
      return { event: 'start' };
    }
    return null;
  };
}

// The caller's last words sound like the end of the call
const FAREWELL =
  /\b(bye|goodbye|that'?s (all|everything|it)|nothing else|no,? thanks?|no thank you|i'?m (all )?(good|fine|set)|(you )?can hang up)\b|^\W*(no|nope|now)?\W*(thanks?|thank you)\b|مع السلام|شكر|متشكر|خلاص|لا شكرا|بس كده/i;
// ...unless they also asked for something
const STILL_WANTS = /[?؟]|\b(yes|yeah|yep|sure|please|but|book|appointment|want|need|question|how|what|when|where)\b|عايز|عاوز|ممكن|لو سمحت|بس عايز|ميعاد|احجز/i;
// The receptionist's last words invited the caller to finish
const WRAP_UP_LINE = /anything (else|i can)|help you with|take a message|call you back|callback|حاجة تانية|خدمة تانية|أساعد/i;
// The end-of-call rating question, and an answer to it
const RATING_QUESTION = /rate (this|the) call|تقيّ?م|تقييم/i;
const RATING_ANSWER = /\b[1-5]\b|\b(one|two|three|four|five)\b|[١-٥]|واحد|اتنين|تلاتة|ثلاثة|أربعة|اربعة|خمسة/i;
const RATING_WORDS = [
  [/\b5\b|\bfive\b|٥|خمسة/i, 5],
  [/\b4\b|\bfour\b|٤|أربعة|اربعة/i, 4],
  [/\b3\b|\bthree\b|٣|تلاتة|ثلاثة/i, 3],
  [/\b2\b|\btwo\b|٢|اتنين/i, 2],
  [/\b1\b|\bone\b|١|واحد/i, 1],
];
const spokenRating = (text) => RATING_WORDS.find(([pattern]) => pattern.test(text))?.[1] || null;
// The receptionist's last words still wait for an answer, so the call must not end yet
const AWAITS_REPLY = /[?؟]|\b(would you like|shall i|do you want|can help you|i can (take|arrange|connect|pass))\b|تحب|تحبي|أقدر أساعد|ممكن أ/i;
const MAX_RECONNECTS = 4; // Gemini Live sometimes drops twice in one call; reconnecting works well
const SILENCE_MS = 10000; // this long without a word from the caller: "Can you still hear me?"

// ---------------------------------------------------------------------------
// One phone call
// ---------------------------------------------------------------------------
// deps (provided by server.js):
//   gemini, model, voice     – Gemini client, Live model name, prebuilt voice name
//   buildPrompt(call)        – system prompt for this call
//   tools, endingTools       – function declarations, and the names of the ones that end the call
//   runTool(name, args, call) -> result sent back to Gemini (the conversation continues)
//   endTool(name, args, call) -> handoff data, e.g. { action: 'goodbye', outcome: 'booked' }
//   onFailure(from)          – log a call that broke down, so the clinic can call back
//   onEndedEarly(from, transcript) – log a call the caller hung up before anything was booked or saved
//   redirectCall(callSid, data, host) – replace the call's TwiML (closing line, transfer, fail-safe)
//   localTime()              – current time at the clinic
//   extraConfig              – extra Live settings (e.g. thinking budget)
//   greeting                 – the opening line, played from a recording as soon as the call connects
//   allowInterruptions       – false: the receptionist always finishes speaking; what the caller says
//                              meanwhile is passed on as soon as she's done
export function handleLiveCall(twilioWs, host, deps) {
  const call = { live: true, from: null, callSid: null, streamSid: null, verified: new Set(), localTime: deps.localTime() };
  const toPhone = createDownsampler();
  // Phone callers get a higher speech threshold than the web phone's browser microphones
  const trackSpeech = createSpeechTracker(() => (String(call.from || '').startsWith('+') ? MIN_PHONE_SPEECH_LEVEL : MIN_SPEECH_LEVEL));
  const history = []; // what has been said, to resume the conversation after a dropped connection
  const pendingInput = []; // caller input that arrives while Gemini is (re)connecting
  const preRoll = []; // the last few audio frames before the caller started talking
  let session = null;
  let ready = false; // Gemini is connected and can take input
  let ending = null; // handoff data once a tool has ended the conversation
  let finished = false;
  let handedOff = false; // the call ended through finish() (goodbye, transfer, or fail-safe)
  let fallbackTimer = null;
  let reconnects = 0;
  let bookedThisCall = false;
  let endRefused = false; // end_call was already sent back once for hanging up on an open question
  let callerTurns = 0; // caller turns so far, even ones Gemini didn't transcribe
  let callerTurnsAtAgentLine = 0; // callerTurns when the receptionist's last line was logged
  let awaitingCaller = false; // the receptionist finished her turn and the caller hasn't spoken since
  let silencePrompts = 0; // times the receptionist was told the caller has gone quiet
  let silenceTimer = null;
  let lastCallerSpeech = Date.now();
  let startedAt = Date.now();
  let lastHandoff = null; // how the call ended, for the call record
  let toolsInFlight = false; // Gemini asked for a look-up or booking that hasn't been answered yet
  let greetingPlaying = false;
  let callerTurnOpen = false; // Gemini was told the caller started talking, and not yet that they stopped
  let playbackEnd = 0; // when the receptionist's audio already sent to Twilio finishes playing
  let callerText = '';
  let agentText = '';
  let turnEndedAt = 0; // when the caller last finished talking, to log how long the reply took
  let askedForDigits = false; // the receptionist's last question asked for a number, date, or spelling
  let held = null; // what the caller said while the receptionist was talking: { frames, ended }

  const sendTwilio = (obj) => {
    if (twilioWs.readyState === twilioWs.OPEN) twilioWs.send(JSON.stringify(obj));
  };
  const stopPlayback = () => {
    sendTwilio({ event: 'clear', streamSid: call.streamSid }); // drop audio Twilio still has queued
    playbackEnd = Date.now();
    greetingPlaying = false;
  };

  const flushCaller = () => {
    if (callerText.trim()) {
      console.log(`Caller: ${callerText.trim()}`);
      history.push(`Caller: ${callerText.trim()}`);
    }
    callerText = '';
  };
  const flushAgent = (suffix = '') => {
    if (agentText.trim()) {
      console.log(`Receptionist: ${agentText.trim()}${suffix}`);
      history.push(`Receptionist: ${agentText.trim()}${suffix}`);
      callerTurnsAtAgentLine = callerTurns;
    }
    agentText = '';
  };

  // Goodbye, transfer, or fail-safe: replace the call's instructions through Twilio's API
  async function finish(data) {
    if (finished) return;
    if (!data.contacts && call.contacts) data = { ...data, contacts: call.contacts }; // the caller's own emergency number
    finished = handedOff = true;
    clearTimeout(fallbackTimer);
    clearInterval(silenceTimer);
    flushCaller();
    flushAgent();
    console.log('Handoff:', data);
    lastHandoff = data;
    if (data.action === 'error') deps.onFailure(call.from);
    try {
      await deps.redirectCall(call.callSid, data, host);
    } catch (err) {
      console.error('Could not update the Twilio call:', err.message);
    }
    session?.close();
  }

  async function onToolCalls(functionCalls) {
    flushCaller();
    flushAgent();

    const endCall = functionCalls.find((fc) => deps.endingTools.has(fc.name));
    if (endCall) {
      console.log(`Receptionist: [calls ${endCall.name}]`);
      // Gemini sometimes hangs up straight after asking or offering something. Send it back once to hear the answer.
      const lastLine = history.at(-1) || '';
      if (
        endCall.name === 'end_call' &&
        !['emergency', 'crisis'].includes(endCall.args?.outcome) &&
        !endRefused &&
        silencePrompts < 2 && // after two silences, hanging up is right
        !greetingPlaying &&
        lastLine.startsWith('Receptionist: ') &&
        AWAITS_REPLY.test(lastLine) &&
        callerTurns === callerTurnsAtAgentLine &&
        !callerTurnOpen
      ) {
        endRefused = true;
        console.log('  end_call refused: the caller has not answered yet');
        session.sendToolResponse({
          functionResponses: [
            {
              id: endCall.id,
              name: endCall.name,
              response: { ended: false, error: 'You just asked or offered the caller something. Do not end the call: wait silently for their answer.' },
            },
          ],
        });
        return;
      }
      // Twilio echoes this mark once what the receptionist already said has played; then Twilio takes over
      call.language = spokenLanguage();
      ending = deps.endTool(endCall.name, endCall.args || {}, call);
      // Closing lines in other languages are recorded in the receptionist's voice and played here
      // (Twilio's own voice for the closing line only speaks English)
      const closing = await Promise.race([deps.recordedClosing?.(ending), new Promise((r) => setTimeout(() => r(null), 3000))]).catch(
        () => null
      );
      if (closing?.length && !finished) {
        playRecording(closing);
        ending.played = true;
        console.log(`Receptionist: (closing line in ${ending.language}, recorded)`);
      }
      sendTwilio({ event: 'mark', streamSid: call.streamSid, mark: { name: 'handoff' } });
      fallbackTimer = setTimeout(() => finish(ending), 15000); // never leave the line hanging
      return;
    }

    // Look-ups and bookings: hand the results back and let the conversation continue
    const asked = session;
    toolsInFlight = true;
    const functionResponses = [];
    for (const fc of functionCalls) {
      console.log(`Receptionist: [calls ${fc.name}]`);
      const response = await deps.runTool(fc.name, fc.args || {}, call);
      console.log(`  ${fc.name} ->`, JSON.stringify(response));
      history.push(`(Receptionist used ${fc.name}: ${JSON.stringify(response)})`);
      if (response?.success && (fc.name === 'book_appointment' || fc.name === 'reschedule_appointment')) bookedThisCall = true;
      functionResponses.push({ id: fc.id, name: fc.name, response });
    }
    // Only the connection that asked can take the answer (it may have dropped and been replaced meanwhile)
    if (!finished && asked === session) session.sendToolResponse({ functionResponses });
    toolsInFlight = false;
  }

  function onGeminiMessage(m) {
    const sc = m.serverContent;

    for (const part of sc?.modelTurn?.parts || []) {
      if (!part.inlineData?.data || ending) continue;
      const audio = toPhone(Buffer.from(part.inlineData.data, 'base64'));
      if (!audio.length) continue;
      if (turnEndedAt) {
        console.log(`  (reply started ${((Date.now() - turnEndedAt) / 1000).toFixed(1)} s after the caller finished)`);
        turnEndedAt = 0;
      }
      sendTwilio({ event: 'media', streamSid: call.streamSid, media: { payload: audio.toString('base64') } });
      playbackEnd = Math.max(Date.now(), playbackEnd) + audio.length / 8; // 8 bytes of mu-law per ms
    }

    if (sc?.inputTranscription?.text) callerText += sc.inputTranscription.text;
    if (sc?.outputTranscription?.text) {
      flushCaller(); // the receptionist started answering, so the caller's sentence is complete
      agentText += sc.outputTranscription.text;
      askedForDigits = ASKED_FOR_DIGITS.test(agentText);
    }
    if (sc?.interrupted) {
      stopPlayback();
      flushAgent(' (interrupted)');
    }
    if (sc?.turnComplete) {
      flushAgent();
      awaitingCaller = true;
    }

    if (m.toolCall?.functionCalls?.length) {
      turnEndedAt = 0; // a look-up is running; its reply is timed by the tool, not the caller
      onToolCalls(m.toolCall.functionCalls).catch((err) => {
        console.error('Tool call failed:', err);
        finish({ action: 'error' });
      });
    }
  }

  // Gemini sometimes drops a session mid-call. Reconnect and carry on, unless the call was already ending.
  // The caller's last words: did they say goodbye, or answer the rating question?
  function callerFinished() {
    const last = (who) => history.findLast((line) => line.startsWith(who)) || '';
    const lastCaller = last('Caller: ');
    const lastAgent = last('Receptionist: ');
    const askedRating = history.slice(-4).some((line) => line.startsWith('Receptionist: ') && RATING_QUESTION.test(line));
    const rated = askedRating && RATING_ANSWER.test(lastCaller);
    const saidGoodbye = FAREWELL.test(lastCaller) && !STILL_WANTS.test(lastCaller);
    return { lastAgent, lastCaller, rated, saidGoodbye };
  }

  function onDropped(reason) {
    if (finished || ending) return;
    flushCaller();
    // Wrapping up: the receptionist asked "anything else?" (or offered a callback), the caller said
    // goodbye without agreeing to anything, and nothing was being done (or she asked for a rating and got one)
    const { lastAgent, lastCaller, rated, saidGoodbye } = callerFinished();
    const wrappingUp = !toolsInFlight && (rated || (WRAP_UP_LINE.test(lastAgent) && saidGoodbye));
    if (wrappingUp) {
      if (rated && !call.rating) call.rating = spokenRating(lastCaller);
      console.error(`Gemini Live dropped (${reason}) as the caller said goodbye; ending the call normally`);
      return finish({ action: 'goodbye', outcome: bookedThisCall ? 'booked' : 'inquiry' });
    }
    if (reconnects >= MAX_RECONNECTS) {
      console.error(`Gemini Live dropped (${reason}); giving up`);
      return finish({ action: 'error' });
    }
    reconnects++;
    ready = false;
    flushAgent(' (cut off)');
    console.error(`Gemini Live dropped (${reason}); reconnecting (${reconnects}/${MAX_RECONNECTS})`);
    startGemini(true).catch((err) => {
      console.error('Could not reconnect to Gemini Live:', err.message);
      finish({ action: 'error' });
    });
  }

  async function startGemini(resume = false) {
    let current = null; // callbacks from an older, replaced connection are ignored
    current = session = await deps.gemini.live.connect({
      model: deps.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: speechConfig(deps.voice),
        systemInstruction: deps.buildPrompt(call),
        tools: [{ functionDeclarations: toLiveTools(deps.tools) }],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } }, // we detect turns ourselves
        ...deps.extraConfig,
      },
      callbacks: {
        onmessage: (m) => {
          if (current === null || current === session) onGeminiMessage(m);
        },
        onerror: (e) => {
          if (current === session) onDropped(`error: ${e.message}`);
        },
        onclose: (e) => {
          if (current === session) onDropped(`closed ${e.code} ${e.reason}`);
        },
      },
    });
    ready = true;

    const instruction = resume
      ? `(The phone line dropped for a moment and has just reconnected. The conversation so far:\n${history.join('\n')}\n\n` +
        'Carry on from where you left off. Do not greet the caller again. If you were cut off mid-sentence, ' +
        'briefly apologise for the interruption and say it again. IMPORTANT: a booking, change, cancellation, or message only ' +
        'happened if it appears above as "(Receptionist used ...)" with a successful result. If the caller agreed to something ' +
        'that was not completed, it did NOT happen: confirm it with the caller again and then call the tool. Never invent a booking reference.)'
      : call.greeted
        ? null // the recorded greeting already played; wait for the caller
        : '(The phone call has just connected. Greet the caller now.)';
    if (instruction) session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: instruction }] }], turnComplete: true });

    const queued = pendingInput.splice(0);
    if (resume && callerTurnOpen && !queued.some((input) => input.activityStart)) {
      session.sendRealtimeInput({ activityStart: {} }); // the caller was mid-sentence when the line dropped
    }
    for (const input of queued) session.sendRealtimeInput(input);
  }

  function toGemini(input) {
    if (ready) session.sendRealtimeInput(input);
    else if (pendingInput.length < 600) pendingInput.push(input); // up to ~12 s while (re)connecting
  }

  // A silent line: first ask whether the caller can still hear, then end the call politely
  function checkSilence() {
    const quietFor = Date.now() - Math.max(playbackEnd, turnEndedAt || 0, lastCallerSpeech);
    if (!ready || ending || finished || toolsInFlight || callerTurnOpen || greetingPlaying || !awaitingCaller) return;
    if (quietFor < SILENCE_MS) return;
    silencePrompts++;
    awaitingCaller = false;
    console.log(`  (caller silent for ${Math.round(quietFor / 1000)} s)`);
    const note =
      silencePrompts === 1
        ? '(The caller has said nothing for a while. Ask kindly, in the language you were speaking, whether they can still hear you.)'
        : "(The caller is still silent. Say briefly that you can't hear them and that they're welcome to call back, then call end_call with outcome \"inquiry\".)";
    session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: note }] }], turnComplete: true });
  }

  function openTurn() {
    awaitingCaller = false;
    silencePrompts = 0;
    lastCallerSpeech = Date.now();
    callerTurnOpen = true;
    toGemini({ activityStart: {} });
    for (const frame of preRoll.splice(0)) toGemini(frame);
  }

  function endTurn(speech, now) {
    console.log(`  (caller turn ${(speech.ms / 1000).toFixed(1)} s, voice level ${speech.peak}, background ${speech.noise})`);
    callerTurnOpen = false;
    callerTurns++;
    toGemini({ activityEnd: {} });
    turnEndedAt = now;
  }

  // Forward the caller's audio to Gemini, marking where each caller turn starts and ends
  function onCallerAudio(pcm) {
    const now = Date.now();
    const playing = now < playbackEnd || greetingPlaying;
    const interrupting = playing && deps.allowInterruptions;
    const speech = trackSpeech(
      pcm,
      now,
      interrupting ? BARGE_IN_FRAMES : SPEECH_START_FRAMES,
      askedForDigits ? DIGITS_END_FRAMES : SPEECH_END_FRAMES
    );
    const audio = { audio: { data: pcmToBase64(pcm), mimeType: 'audio/pcm;rate=8000' } };

    if (speech?.event === 'start') {
      if (interrupting) {
        stopPlayback(); // the caller is talking over the receptionist
        flushAgent(' (interrupted)');
        console.log('Caller interrupted');
      }
      if (playing && !deps.allowInterruptions) held = { frames: preRoll.splice(0), ended: null };
      else openTurn();
    }

    // The caller is talking while the receptionist speaks: let her finish, then pass it all on
    if (held) {
      if (!held.ended) {
        held.frames.push(audio);
        if (held.frames.length > MAX_HELD_FRAMES) held.frames.shift();
      }
      if (speech?.event === 'end') held.ended = speech;
      if (!playing) {
        const { frames, ended } = held;
        held = null;
        callerTurnOpen = true;
        toGemini({ activityStart: {} });
        for (const frame of frames) toGemini(frame);
        if (ended) endTurn(ended, now); // otherwise the turn ends when they stop talking
      }
      return;
    }

    if (callerTurnOpen) toGemini(audio);
    else {
      preRoll.push(audio);
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
    }
    if (speech?.event === 'end' && callerTurnOpen) endTurn(speech, now);
  }

  // Send recorded mu-law audio (greeting, closing line) to the caller
  function playRecording(audio) {
    for (let i = 0; i < audio.length; i += 8000) {
      sendTwilio({ event: 'media', streamSid: call.streamSid, media: { payload: audio.subarray(i, i + 8000).toString('base64') } });
    }
    playbackEnd = Math.max(Date.now(), playbackEnd) + audio.length / 8;
  }

  // The language the receptionist was last speaking (Arabic script in her words), or null if unclear
  function spokenLanguage() {
    const said = history
      .filter((line) => line.startsWith('Receptionist: ') && line !== `Receptionist: ${call.greeting}`)
      .slice(-2)
      .join(' ');
    return /[؀-ۿ]{3,}/.test(said) ? 'Arabic' : null;
  }

  async function onCallStart(start) {
    const p = start.customParameters || {};
    call.streamSid = start.streamSid;
    startedAt = Date.now();
    call.callSid = start.callSid;
    // On a "call me" test call Twilio dials out, so the person on the line is the "to" number
    call.from = p.direction?.startsWith('outbound') ? p.to : p.from;
    call.direction = p.direction || 'inbound';
    call.greeting = typeof deps.greeting === 'function' ? deps.greeting(call) : deps.greeting;
    console.log(`Session started for ${call.from} (Gemini Live)`);

    // Play the recorded greeting if it is ready within a moment; otherwise Gemini greets live
    const recording =
      call.greeting &&
      (await Promise.race([prepareGreeting({ ...deps, text: call.greeting }), new Promise((r) => setTimeout(() => r(null), 1500))]));
    if (recording && !finished) {
      call.greeted = greetingPlaying = true;
      playRecording(recording);
      sendTwilio({ event: 'mark', streamSid: call.streamSid, mark: { name: 'greeting' } });
      console.log(`Receptionist: ${call.greeting} (recorded)`);
      history.push(`Receptionist: ${call.greeting}`);
    }
    await startGemini();
    silenceTimer = setInterval(checkSilence, 1000);
  }

  twilioWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case 'start':
        onCallStart(msg.start).catch((err) => {
          console.error('Could not start Gemini Live:', err.message);
          finish({ action: 'error' });
        });
        break;
      case 'media':
        // Stop listening once the call is wrapping up, so background noise can't trigger a new reply
        if (!ending && !finished) onCallerAudio(mulawToPcm(Buffer.from(msg.media.payload, 'base64')));
        break;
      case 'mark':
        if (msg.mark?.name === 'greeting') {
          greetingPlaying = false;
          if (!callerTurnOpen) awaitingCaller = true; // the greeting asked "How can I help?"
        }
        if (msg.mark?.name === 'handoff') finish(ending);
        break;
      case 'stop':
        finished = true; // caller hung up
        session?.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    finished = true;
    clearTimeout(fallbackTimer);
    clearInterval(silenceTimer);
    flushCaller();
    flushAgent();
    session?.close();
    console.log(`Session closed for ${call.from}`);
    if (!handedOff) {
      const { lastCaller, rated, saidGoodbye } = callerFinished();
      if (rated || saidGoodbye) {
        // The caller said goodbye (or rated the call) and hung up before she did: a normal ending, not a lost caller
        if (rated && !call.rating) call.rating = spokenRating(lastCaller);
        lastHandoff = { action: 'goodbye', outcome: bookedThisCall ? 'booked' : 'inquiry', endedBy: 'caller' };
        console.log('Caller said goodbye and hung up');
      } else if (bookedThisCall) {
        // Booked, then hung up before the goodbye (often during the rating question): still a booked call
        lastHandoff = { action: 'goodbye', outcome: 'booked', endedBy: 'caller' };
      } else if (!call.recorded && history.some((line) => line.startsWith('Caller: '))) {
        // The caller hung up part-way, before anything was booked or saved: let the clinic team follow up
        deps.onEndedEarly(call.from, history.filter((line) => !line.startsWith('(')));
      }
    }
    // Feedback loop: save the call for review
    deps.onCallEnded?.({ id: call.callSid, from: call.from, startedAt, transcript: history, handoff: lastHandoff, session: call });
  });
}
