// The clinic's knowledge base (RAG): Markdown files the receptionist searches during a call.
//
// - Each clinic keeps its knowledge in clinics/<clinic>/knowledge/*.md. Every "## " section is one entry.
// - A section that still contains TODO is never read out. It stays searchable as a "not confirmed"
//   marker, so a question about it (say, parking) gets "I don't have that confirmed" instead of the
//   nearest other section.
// - Search mixes Gemini embeddings (finds the meaning, works across English and Arabic) with keyword
//   matching (exact words like "parking" or "AXA"). If the embedding service is unreachable, keyword
//   matching still works.
// - Embeddings are cached next to the knowledge files, so restarts don't re-embed unchanged sections.
// - Clinic staff can answer questions callers asked from the Review page (feedback loop): the answer fills
//   in the matching TODO section, or becomes a new entry, and the knowledge base reloads straight away.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const EMBED_MODEL = process.env.EMBED_MODEL || 'gemini-embedding-001';
const DIMS = 768;
const MIN_SCORE = 0.6; // below this, a section isn't about the question
const MAX_RESULTS = 3;
const QUERY_TIMEOUT_MS = 2500; // on a live call, fall back to keywords rather than keep the caller waiting
const LEARNED_FILE = '90-answers-from-calls.md'; // where answers to new questions go

const STOP_WORDS = new Set(
  ('a an and are at be can could do does for from have how i if in is it me my of on or our please the there this to ' +
    'we what when where which who will with would you your yours clinic lily lilys').split(' ')
);

// Lower-case words, with Arabic letter variants folded together so spellings match
const words = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map((w) => (/^[a-z]+s$/.test(w) && w.length > 3 ? w.slice(0, -1) : w)); // "results" = "result"

const normalize = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const hash = (text) => crypto.createHash('sha1').update(`${EMBED_MODEL}|${DIMS}|${text}`).digest('hex');

// Split the Markdown files into sections
export function loadSections(dir) {
  if (!dir || !fs.existsSync(dir)) return { sections: [], skipped: [] };
  const sections = [];
  const skipped = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() || file.replace(/\.md$/, '');
    for (const part of text.split(/^##\s+/m).slice(1)) {
      const [heading, ...body] = part.split('\n');
      const info = body.join('\n').trim();
      const topic = `${title} – ${heading.trim()}`;
      if (!info) continue;
      const pending = /\bTODO\b/.test(info);
      if (pending) skipped.push(topic);
      const about = pending ? info.replace(/\bTODO\b:?/g, '').trim() : info;
      sections.push({
        topic,
        file,
        heading: heading.trim(),
        info: pending ? '' : info,
        pending,
        text: `${topic}\n${about}`,
        terms: words(`${topic} ${about}`),
      });
    }
  }
  return { sections, skipped };
}

export function createKnowledgeBase({ dir, gemini, log = console.log }) {
  const cacheFile = dir && path.join(dir, '.embeddings-cache.json');
  const queryCache = new Map();
  let index = null; // { sections, skipped, vectors, weight, ready }

  async function embed(texts, taskType) {
    const out = [];
    for (let i = 0; i < texts.length; i += 50) {
      const res = await gemini.models.embedContent({
        model: EMBED_MODEL,
        contents: texts.slice(i, i + 50),
        config: { taskType, outputDimensionality: DIMS },
      });
      out.push(...res.embeddings.map((e) => normalize(e.values)));
    }
    return out;
  }

  // (Re)read the files and embed any new or changed sections
  function build() {
    const { sections, skipped } = loadSections(dir);
    // How rare each word is across sections (rarer words count more when matching keywords)
    const docFreq = new Map();
    for (const s of sections) for (const w of new Set(s.terms)) docFreq.set(w, (docFreq.get(w) || 0) + 1);
    const next = {
      sections,
      skipped,
      vectors: null, // one per section, once embedded
      weight: (w) => Math.log(1 + sections.length / (docFreq.get(w) || sections.length)),
    };
    next.ready = (async () => {
      if (!sections.length || !gemini) return;
      let cache = {};
      try {
        cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      } catch {}
      const missing = sections.filter((s) => !cache[hash(s.text)]);
      if (missing.length) {
        const fresh = await embed(missing.map((s) => s.text), 'RETRIEVAL_DOCUMENT');
        missing.forEach((s, i) => (cache[hash(s.text)] = fresh[i].map((x) => Math.round(x * 1e5) / 1e5)));
        const keep = Object.fromEntries(sections.map((s) => [hash(s.text), cache[hash(s.text)]]));
        try {
          fs.writeFileSync(cacheFile, JSON.stringify(keep));
        } catch {}
      }
      next.vectors = sections.map((s) => cache[hash(s.text)]);
    })()
      .then(() =>
        log(
          `Knowledge base: ${sections.length - skipped.length} sections${next.vectors ? '' : ' (keyword search only)'}` +
            (skipped.length ? `; ${skipped.length} still marked TODO (answered as "not confirmed")` : '')
        )
      )
      .catch((err) => log(`Knowledge base: embeddings unavailable (${err.message}); using keyword search only`));
    return next;
  }
  index = build();

  async function queryVector(question) {
    const key = question.toLowerCase().trim();
    if (!queryCache.has(key)) {
      const pending = embed([question], 'RETRIEVAL_QUERY').then(([v]) => v);
      queryCache.set(key, pending);
      pending.catch(() => queryCache.delete(key));
    }
    let timer;
    const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), QUERY_TIMEOUT_MS)));
    try {
      return await Promise.race([queryCache.get(key), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns the best matching sections, best first: [{ topic, info, score, pending }]
  // (pending: the clinic hasn't filled this topic in yet, so there is nothing to tell the caller)
  async function search(question, max = MAX_RESULTS) {
    const { sections, weight, ready } = index;
    if (!sections.length || !String(question || '').trim()) return [];
    await Promise.race([ready, new Promise((r) => setTimeout(r, QUERY_TIMEOUT_MS))]);

    const q = [...new Set(words(question))];
    const keyword = sections.map((s) => q.reduce((sum, w) => sum + (s.terms.includes(w) ? weight(w) : 0), 0));
    const best = Math.max(...keyword, 1e-9);

    let semantic = null;
    if (index.vectors) {
      try {
        const v = await queryVector(question);
        semantic = index.vectors.map((d) => dot(v, d));
      } catch (err) {
        log(`  (knowledge search: ${err.message}; using keywords only)`);
      }
    }

    return sections
      .map((s, i) => ({
        topic: s.topic,
        info: s.info,
        pending: s.pending,
        // With embeddings: meaning first, a small boost for exact words. Without: keywords alone.
        score: semantic ? semantic[i] + 0.08 * (keyword[i] / best) : keyword[i] / best,
      }))
      .filter((r) => r.score >= (semantic ? MIN_SCORE : 0.35))
      .sort((a, b) => b.score - a.score)
      .slice(0, max);
  }

  // What the receptionist gets back from search_clinic_info
  async function lookup(question) {
    const results = await search(question);
    if (!results.length || results[0].pending) {
      return {
        found: false,
        ...(results[0]?.pending && { topic: results[0].topic }),
        instructions: "The clinic hasn't confirmed this. Never guess: say you don't have that detail confirmed and offer a callback from the clinic team.",
      };
    }
    return {
      found: true,
      results: results.filter((r) => !r.pending).map(({ topic, info }) => ({ topic, info })),
      instructions:
        "Answer only with what these results say, in your own short spoken words and in the caller's language. " +
        "If they don't actually answer the caller's question, say you don't have that detail confirmed and offer a callback.",
    };
  }

  // How alike two questions are in meaning (0 to 1), or null if embeddings are unavailable
  async function similarity(a, b) {
    try {
      const [x, y] = await Promise.all([queryVector(a), queryVector(b)]);
      return dot(x, y);
    } catch {
      return null;
    }
  }

  async function reload() {
    index = build();
    await index.ready;
  }

  // Save an answer written by clinic staff, then reload so the very next call can use it.
  // If `topic` is a TODO section, its TODO is replaced; otherwise the answer becomes a new entry.
  async function addAnswer({ topic, heading, answer }) {
    const text = String(answer || '').trim().replace(/\r/g, '');
    if (!dir || !text) throw new Error('Nothing to save');
    if (/^##\s/m.test(text)) throw new Error('The answer cannot contain "## " headings');
    const target = topic && index.sections.find((s) => s.topic === topic && s.pending);
    if (target) {
      const file = path.join(dir, target.file);
      const source = fs.readFileSync(file, 'utf8');
      const start = source.indexOf(`## ${target.heading}\n`);
      if (start < 0) throw new Error(`Could not find "${target.heading}" in ${target.file}`);
      const bodyStart = start + `## ${target.heading}\n`.length;
      const next = source.indexOf('\n## ', bodyStart);
      const end = next < 0 ? source.length : next + 1;
      fs.writeFileSync(file, source.slice(0, bodyStart) + text + '\n' + (next < 0 ? '' : '\n') + source.slice(end));
      log(`Knowledge base: "${target.topic}" answered by the clinic team`);
    } else {
      const title = String(heading || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!title) throw new Error('A heading is needed for a new entry');
      const file = path.join(dir, LEARNED_FILE);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(
          file,
          '# Answers from the clinic team\n<!-- Added from the Review page, in answer to questions callers asked. Edit freely. -->\n'
        );
      }
      fs.appendFileSync(file, `\n## ${title}\n${text}\n`);
      log(`Knowledge base: new entry "${title}" added by the clinic team`);
    }
    await reload();
  }

  return {
    get ready() {
      return index.ready;
    },
    get size() {
      return index.sections.length - index.skipped.length;
    },
    get skipped() {
      return index.skipped;
    },
    search,
    lookup,
    similarity,
    reload,
    addAnswer,
  };
}
