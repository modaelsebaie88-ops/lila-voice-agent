// The Review page for the clinic team: the feedback loop's controls.
//   /review?key=...            calls with their automatic review, caller rating, and staff verdict
//   /review?key=...&tab=gaps   questions callers asked that the receptionist couldn't answer: answer them here
//   /review?key=...&tab=rules  rules learned from calls: suggested ones wait here for approval
//   /review/call/<id>?key=...  one call: transcript, review, and the good / bad verdict with a note

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const STYLE = `
:root{--ink:#1b1f24;--muted:#5f6b77;--line:#e3e7eb;--bg:#f7f8fa;--card:#fff;--good:#1e7a46;--bad:#b42318;--warn:#a15c00;--accent:#2457c5}
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.45}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:22px;margin:8px 0 4px}h2{font-size:17px;margin:24px 0 8px}
a{color:var(--accent)}nav{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}nav a{padding:6px 12px;border-radius:999px;text-decoration:none;border:1px solid var(--line);background:var(--card)}
nav a.on{background:var(--ink);color:#fff;border-color:var(--ink)}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:12px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:13px}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
td,th{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top;font-size:14px}th{background:#f0f2f5;font-weight:600}
.wrap{overflow-x:auto}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#eef1f4;color:var(--muted)}
.s5,.s4,.good{background:#e3f4ea;color:var(--good)}.s3,.medium{background:#fff1dc;color:var(--warn)}.s2,.s1,.bad,.high{background:#fde8e6;color:var(--bad)}
.low{background:#eef1f4}.muted{color:var(--muted)}.small{font-size:13px}textarea,input[type=text]{width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px}
textarea{min-height:70px}button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--ink);background:var(--ink);color:#fff;cursor:pointer}
button.ghost{background:#fff;color:var(--ink)}button.danger{background:#fff;color:var(--bad);border-color:var(--bad)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.line{padding:6px 10px;border-radius:8px;margin:4px 0;white-space:pre-wrap;word-break:break-word}.line.c{background:#eef4ff}.line.r{background:#f3f4f6}.line.t{color:var(--muted);font-size:12px;font-family:ui-monospace,monospace}
.msg{background:#e3f4ea;border:1px solid #b7e1c7;padding:8px 12px;border-radius:8px}.err{background:#fde8e6;border-color:#f5c2bc}
@media (max-width:640px){td,th{padding:6px}}`;

export function mountReviewPages(app, { feedback, clinicName, dashboardKey, when }) {
  const authorised = (req) => (req.query.key || req.body?.key) === dashboardKey;
  const k = encodeURIComponent(dashboardKey);
  const hidden = `<input type="hidden" name="key" value="${esc(dashboardKey)}">`;
  const back = (res, tab, msg, error) =>
    res.redirect(303, `/review?key=${k}${tab ? `&tab=${tab}` : ''}${msg ? `&${error ? 'err' : 'msg'}=${encodeURIComponent(msg)}` : ''}`);

  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;

  const scorePill = (c) =>
    c.review ? `<span class="pill s${c.review.score}">${c.review.score}/5</span>` : c.reviewError ? '<span class="pill bad">review failed</span>' : '<span class="pill">reviewing…</span>';
  const ratingPill = (c) => (c.rating ? `<span class="pill s${c.rating}">${c.rating}★</span>` : '<span class="muted">–</span>');
  const staffPill = (c) => (c.staff ? `<span class="pill ${c.staff.verdict}">${c.staff.verdict}</span>` : '');
  const issuesCell = (c) => {
    if (!c.review) return '';
    const high = c.review.issues.filter((i) => i.severity === 'high').length;
    const other = c.review.issues.length - high;
    return `${high ? `<span class="pill high">${high} serious</span> ` : ''}${other ? `<span class="pill medium">${other}</span>` : ''}${
      !c.review.issues.length ? '<span class="muted">none</span>' : ''
    }`;
  };

  // ---- Overview, with three tabs ---------------------------------------------------------------
  app.get('/review', (req, res) => {
    if (!authorised(req)) return res.status(401).send('Unauthorized');
    const tab = ['gaps', 'rules'].includes(req.query.tab) ? req.query.tab : 'calls';
    const s = feedback.stats(7);
    const fmt = (v, digits = 1) => (v === null ? '–' : v.toFixed(digits));
    const notice = req.query.msg ? `<p class="msg">${esc(req.query.msg)}</p>` : req.query.err ? `<p class="msg err">${esc(req.query.err)}</p>` : '';

    let body = '';
    if (tab === 'calls') {
      const problems = req.query.filter === 'problems';
      const calls = feedback
        .calls()
        .filter((c) => !problems || c.staff?.verdict === 'bad' || (c.review && (c.review.score <= 3 || c.review.issues.some((i) => i.severity === 'high'))))
        .slice(0, 200);
      body = `
<div class="row"><a href="/review?key=${k}">All calls</a> · <a href="/review?key=${k}&filter=problems">Only calls with problems</a></div>
<div class="wrap"><table><tr><th>When</th><th>Caller</th><th>Language</th><th>Outcome</th><th>Quality</th><th>Caller rating</th><th>Issues</th><th>Staff</th><th></th></tr>
${
  calls
    .map(
      (c) => `<tr><td>${esc(when(c.time))}</td><td>${esc(c.from)}</td><td>${esc(c.language || '')}</td><td>${esc(c.outcome)}</td>
<td>${scorePill(c)}</td><td>${ratingPill(c)}</td><td>${issuesCell(c)}</td><td>${staffPill(c)}</td>
<td><a href="/review/call/${encodeURIComponent(c.id)}?key=${k}">Open</a></td></tr>`
    )
    .join('') || '<tr><td colspan="9" class="muted">No calls yet.</td></tr>'
}</table></div>`;
    } else if (tab === 'gaps') {
      const gaps = feedback.gaps();
      const open = gaps.filter((g) => g.status === 'open').sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
      const done = gaps.filter((g) => g.status !== 'open').sort((a, b) => (b.answeredAt || '').localeCompare(a.answeredAt || '')).slice(0, 30);
      body = `
<p class="muted">Questions callers asked that the receptionist couldn't answer, most asked first. Write the clinic's answer the way
you'd say it on the phone. It goes into the knowledge base straight away, so the next caller who asks gets it.</p>
${
  open
    .map(
      (g) => `<div class="card"><div><b>${esc(g.question)}</b> <span class="pill">asked ${g.count}×</span>
<span class="muted small">last ${esc(when(g.last))}</span></div>
${g.examples.length > 1 ? `<div class="small muted">Also asked as: ${g.examples.slice(1).map((e) => `“${esc(e)}”`).join(', ')}</div>` : ''}
${g.topic ? `<div class="small">Fills in the knowledge base section <b>${esc(g.topic)}</b> (still marked TODO).</div>` : ''}
<form method="post" action="/review/gaps/${esc(g.id)}/answer">${hidden}
${g.topic ? '' : `<label class="small muted">Heading for the new entry</label><input type="text" name="heading" value="${esc(g.question)}">`}
<label class="small muted">Answer</label><textarea name="answer" required placeholder="e.g. Yes, there is free parking behind the building."></textarea>
<div class="row"><button>Save to knowledge base</button>
<button class="ghost" formaction="/review/gaps/${esc(g.id)}/dismiss" formnovalidate>Not something to answer</button></div></form></div>`
    )
    .join('') || '<p class="card muted">No unanswered questions right now.</p>'
}
${
  done.length
    ? `<h2>Recently handled</h2><div class="wrap"><table><tr><th>Question</th><th>Status</th><th>Answer</th></tr>${done
        .map((g) => `<tr><td>${esc(g.question)}</td><td><span class="pill ${g.status === 'answered' ? 'good' : ''}">${esc(g.status)}</span></td><td>${esc(g.answer || '')}</td></tr>`)
        .join('')}</table></div>`
    : ''
}`;
    } else {
      const rules = feedback.rules();
      const suggested = rules.filter((r) => r.status === 'suggested');
      const approved = rules.filter((r) => r.status === 'approved');
      const callLinks = (r) =>
        r.callIds?.length ? `<div class="small">From: ${r.callIds.map((id) => `<a href="/review/call/${encodeURIComponent(id)}?key=${k}">call</a>`).join(', ')}</div>` : '';
      body = `
<p class="muted">Rules the receptionist has learned from past calls. Suggested rules do nothing until someone approves them;
approved rules apply from the next call.</p>
<form method="post" action="/review/rules/suggest">${hidden}<button>Suggest improvements from problem calls</button>
<span class="small muted">Uses calls marked bad and serious issues found by the reviews.</span></form>
<h2>Waiting for approval (${suggested.length})</h2>
${
  suggested
    .map(
      (r) => `<div class="card"><form method="post" action="/review/rules/${esc(r.id)}/approve">${hidden}
<textarea name="text">${esc(r.text)}</textarea><div class="small muted">Why: ${esc(r.reason)}</div>${callLinks(r)}
<div class="row"><button>Approve</button><button class="danger" formaction="/review/rules/${esc(r.id)}/reject">Reject</button></div></form></div>`
    )
    .join('') || '<p class="card muted">Nothing waiting.</p>'
}
<h2>Approved rules (${approved.length})</h2>
${
  approved
    .map(
      (r) => `<div class="card"><div>${esc(r.text)}</div><div class="small muted">${esc(r.reason)}</div>${callLinks(r)}
<form method="post" action="/review/rules/${esc(r.id)}/delete">${hidden}<div class="row"><button class="danger">Remove</button></div></form></div>`
    )
    .join('') || '<p class="card muted">None yet.</p>'
}
<h2>Add a rule yourself</h2>
<form class="card" method="post" action="/review/rules/add">${hidden}
<textarea name="text" required placeholder="e.g. When a caller asks for Dr. Hassan, mention she only works mornings."></textarea>
<div class="row"><button>Add rule</button></div></form>`;
    }

    res.send(
      page(
        `Review – ${clinicName}`,
        `<h1>${esc(clinicName)} – call review</h1>
<div class="small"><a href="/dashboard?key=${k}">← Front desk</a></div>
<div class="stats">
<div class="stat"><b>${s.calls}</b><span>calls, last ${s.days} days</span></div>
<div class="stat"><b>${fmt(s.score)}</b><span>average quality (1–5)</span></div>
<div class="stat"><b>${fmt(s.rating)}</b><span>caller rating (${s.rated} rated)</span></div>
<div class="stat"><b>${s.resolved === null ? '–' : Math.round(s.resolved * 100) + '%'}</b><span>needs fully met</span></div>
<div class="stat"><b>${s.serious}</b><span>calls with serious issues</span></div>
</div>
<nav><a class="${tab === 'calls' ? 'on' : ''}" href="/review?key=${k}">Calls</a>
<a class="${tab === 'gaps' ? 'on' : ''}" href="/review?key=${k}&tab=gaps">Questions to answer (${s.openGaps})</a>
<a class="${tab === 'rules' ? 'on' : ''}" href="/review?key=${k}&tab=rules">Rules (${s.pendingRules} waiting)</a></nav>
${notice}${body}`
      )
    );
  });

  // ---- One call --------------------------------------------------------------------------------
  app.get('/review/call/:id', (req, res) => {
    if (!authorised(req)) return res.status(401).send('Unauthorized');
    const c = feedback.call(req.params.id);
    if (!c) return res.status(404).send('Call not found');
    const r = c.review;
    const lines = c.transcript
      .map((l) => {
        const cls = l.startsWith('Caller: ') ? 'c' : l.startsWith('Receptionist: ') ? 'r' : 't';
        return `<div class="line ${cls}">${esc(l)}</div>`;
      })
      .join('');
    res.send(
      page(
        `Call – ${clinicName}`,
        `<div class="small"><a href="/review?key=${k}">← All calls</a></div>
<h1>Call from ${esc(c.from)}</h1>
<div class="muted">${esc(when(c.time))}${c.durationSec ? ` · ${Math.round(c.durationSec / 60)} min ${c.durationSec % 60} s` : ''} · ${esc(c.language || '')} · ${esc(c.engine || '')} · outcome: ${esc(c.outcome)}
${c.rating ? ` · caller rated it ${c.rating}/5` : ''}</div>
<div class="card"><h2 style="margin-top:0">Automatic review ${scorePill(c)}</h2>
${
  r
    ? `<div><b>Caller wanted:</b> ${esc(r.caller_need)}</div><div><b>Need met:</b> ${esc(r.resolved)}</div><p>${esc(r.summary)}</p>
${
  r.issues.length
    ? `<ul>${r.issues
        .map((i) => `<li><span class="pill ${i.severity}">${esc(i.severity)}</span> <b>${esc(i.category.replace(/_/g, ' '))}</b>: ${esc(i.description)}${i.quote ? `<div class="small muted">“${esc(i.quote)}”</div>` : ''}</li>`)
        .join('')}</ul>`
    : '<p class="muted">No problems found.</p>'
}
${r.suggestion ? `<div><b>Suggestion:</b> ${esc(r.suggestion)}</div>` : ''}`
    : c.reviewError
      ? `<p class="msg err">The review failed: ${esc(c.reviewError)}</p>`
      : '<p class="muted">The review is still running. Refresh in a minute.</p>'
}
<form method="post" action="/review/call/${encodeURIComponent(c.id)}/review-again">${hidden}<div class="row"><button class="ghost">Review again</button></div></form></div>
<div class="card"><h2 style="margin-top:0">Your verdict ${staffPill(c)}</h2>
<form method="post" action="/review/call/${encodeURIComponent(c.id)}/feedback">${hidden}
<div class="row"><label><input type="radio" name="verdict" value="good" ${c.staff?.verdict !== 'bad' ? 'checked' : ''}> Handled well</label>
<label><input type="radio" name="verdict" value="bad" ${c.staff?.verdict === 'bad' ? 'checked' : ''}> Should have gone differently</label></div>
<label class="small muted">What should she have done? (used to suggest new rules)</label>
<textarea name="note" placeholder="e.g. She should have offered the waiting list when nothing was free this week.">${esc(c.staff?.note || '')}</textarea>
<div class="row"><button>Save verdict</button></div></form></div>
<h2>Transcript</h2><div class="card">${lines}</div>`
      )
    );
  });

  // ---- Actions ---------------------------------------------------------------------------------
  const action = (path, handler) =>
    app.post(path, async (req, res) => {
      if (!authorised(req)) return res.status(401).send('Unauthorized');
      try {
        await handler(req, res);
      } catch (err) {
        back(res, req.path.includes('/rules') ? 'rules' : req.path.includes('/gaps') ? 'gaps' : '', err.message, true);
      }
    });

  action('/review/call/:id/feedback', (req, res) => {
    feedback.setStaffFeedback(req.params.id, req.body);
    res.redirect(303, `/review/call/${encodeURIComponent(req.params.id)}?key=${k}`);
  });
  action('/review/call/:id/review-again', (req, res) => {
    feedback.reviewAgain(req.params.id);
    res.redirect(303, `/review/call/${encodeURIComponent(req.params.id)}?key=${k}`);
  });
  action('/review/gaps/:id/answer', async (req, res) => {
    await feedback.answerGap(req.params.id, req.body.answer, req.body.heading);
    back(res, 'gaps', 'Saved. The receptionist will use this answer from the next call.');
  });
  action('/review/gaps/:id/dismiss', (req, res) => {
    feedback.dismissGap(req.params.id);
    back(res, 'gaps', 'Dismissed.');
  });
  action('/review/rules/suggest', async (req, res) => {
    const result = await feedback.suggestRules();
    back(res, 'rules', result.note || `${result.added} suggestion(s) added. Review them below.`);
  });
  action('/review/rules/add', (req, res) => {
    if (!String(req.body.text || '').trim()) throw new Error('Write the rule first.');
    feedback.addRule(req.body.text);
    back(res, 'rules', 'Rule added. It applies from the next call.');
  });
  action('/review/rules/:id/:verb', (req, res) => {
    const status = { approve: 'approved', reject: 'rejected', delete: 'deleted' }[req.params.verb];
    if (!status) throw new Error('Unknown action');
    feedback.setRule(req.params.id, status, req.body.text);
    back(res, 'rules', status === 'approved' ? 'Approved. It applies from the next call.' : status === 'rejected' ? 'Rejected.' : 'Removed.');
  });
}
