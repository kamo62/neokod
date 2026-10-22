/* Concept C: plan and decisions workspace. Local demo state only (memory, reset on reload). */
(function () {
  "use strict";
  const F = window.NK_FIX;
  const P = window.NK_PLAN;
  const NK = window.NK;
  const { esc, icon, glyph, pill } = NK;
  const $ = (id) => document.getElementById(id);
  const RUN = F.runs.find((r) => r.id === "NEO-4821");

  let state;
  function initialState() {
    return {
      tab: "plan",
      revisions: NK.clone(P.revisions),
      current: 5,
      viewing: null,
      editing: false,
      draftText: "",
      planApproval: { rev: 5, at: "13:43", by: "You", state: "approved" },
      planReapprove: false,
      decisions: NK.clone(P.decisions).map((d) =>
        Object.assign(d, { draft: null, note: "", localDraft: null }),
      ),
      selDecision: "D-3",
      resume: null,
      resumeChecked: false,
      hlEvidence: null,
      hlAgent: null,
      clock: 30,
    };
  }
  function demoTime() {
    state.clock += 1;
    return "14:" + String(state.clock).padStart(2, "0");
  }

  const dec = (id) => state.decisions.find((d) => d.id === id);
  const rev = (n) => state.revisions.find((r) => r.rev === n);
  const curRev = () => rev(state.current);
  const nextRevNo = () => Math.max(...state.revisions.map((r) => r.rev)) + 1;
  const slug = (s) =>
    "sec-" +
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  const optLabel = (d, id) => (d.options.find((o) => o.id === id) || { label: id }).label;
  function headings(text) {
    return (text || "")
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3).trim());
  }
  const anchorOk = (d) => headings(curRev().text).includes(d.anchor);
  const planApproved = () =>
    state.planApproval.state === "approved" && state.planApproval.rev === state.current;

  /* Markdown subset ---------------------------------------------------- */
  function dchip(id) {
    const d = dec(id);
    if (!d) return `[${id}]`;
    return d.saved
      ? `<button type="button" class="chip" data-decision="${id}">${icon("check")}${id} saved</button>`
      : `<button type="button" class="chip open" data-decision="${id}">${icon("question")}${id} open</button>`;
  }
  function achip(id) {
    const a = RUN.agents.find((x) => x.id === id);
    if (!a) return `[${id}]`;
    return `<button type="button" class="chip agent${a.managed === "observed" ? " observed" : ""}" data-agent="${id}">${icon("agent")}${id}</button>`;
  }
  function inline(s) {
    let h = esc(s);
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\[(D-\d)\]/g, (m, id) => dchip(id));
    h = h.replace(
      /\[(E-\d)\]/g,
      (m, id) =>
        `<button type="button" class="chip" data-evidence="${id}">${icon("file")}${id}</button>`,
    );
    h = h.replace(/\[(R|C\d|N\d)\]/g, (m, id) => achip(id));
    return h;
  }
  function md(text) {
    let out = "";
    let para = [];
    let list = [];
    const flushP = () => {
      if (para.length) out += `<p>${inline(para.join(" "))}</p>`;
      para = [];
    };
    const flushL = () => {
      if (list.length) out += `<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`;
      list = [];
    };
    text.split("\n").forEach((raw) => {
      const l = raw.trimEnd();
      if (l.startsWith("# ")) {
        flushP();
        flushL();
        out += `<h1>${inline(l.slice(2))}</h1>`;
      } else if (l.startsWith("## ")) {
        flushP();
        flushL();
        const t = l.slice(3).trim();
        out += `<h2 id="${slug(t)}" tabindex="-1">${inline(t)}</h2>`;
      } else if (l.startsWith("- ")) {
        flushP();
        list.push(l.slice(2));
      } else if (l.trim() === "[[diagram]]") {
        flushP();
        flushL();
        out += diagram();
      } else if (!l.trim()) {
        flushP();
        flushL();
      } else {
        flushL();
        para.push(l);
      }
    });
    flushP();
    flushL();
    return out;
  }

  /* Inline lifecycle diagram; the branch after "Delivery unknown" follows saved D-3 */
  function diagram() {
    const d3 = dec("D-3");
    const opt = d3.saved ? d3.saved.option : null;
    const OUT = {
      none: { label: "No rule yet", cls: "open", edge: "D-3 open", loop: null },
      keep: {
        label: "Waiting for retry",
        cls: "",
        edge: "keep ID",
        loop: "Explicit retry, same message ID",
      },
      auto: {
        label: "Resend queued",
        cls: "",
        edge: "same ID",
        loop: "Automatic resend, same message ID",
      },
      drop: { label: "Failed, removed", cls: "", edge: "discard", loop: null },
    };
    const o = OUT[opt || "none"];
    const node = (x, y, w, label, cls) =>
      `<g class="dg-node ${cls || ""}"><rect x="${x}" y="${y}" width="${w}" height="36" rx="8"/><text x="${x + w / 2}" y="${y + 22}" text-anchor="middle">${esc(label)}</text></g>`;
    const desc = `Queued, then Sending, then Acknowledged. If the socket drops before the acknowledgement, the send becomes Delivery unknown. ${
      opt
        ? `Saved decision D-3: ${optLabel(d3, opt)}.`
        : "What happens next is decision D-3, still open."
    }`;
    const svg = `<svg viewBox="0 0 600 190" role="img" aria-labelledby="dg-t dg-d">
      <title id="dg-t">Send lifecycle</title><desc id="dg-d">${esc(desc)}</desc>
      <defs>
        <marker id="dg-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 1L9 5L0 9z" class="dg-arrow"/></marker>
        <marker id="dg-ao" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 1L9 5L0 9z" class="dg-arrow-open"/></marker>
      </defs>
      <path class="dg-edge" d="M120 38 H170" marker-end="url(#dg-a)"/>
      <path class="dg-edge" d="M290 38 H350" marker-end="url(#dg-a)"/>
      <path class="dg-edge" d="M230 56 V130" marker-end="url(#dg-a)"/>
      <text class="dg-label" x="222" y="100" text-anchor="end">Socket drops before ack</text>
      <path class="dg-edge${opt ? "" : " open"}" d="M310 148 H380" marker-end="url(#${opt ? "dg-a" : "dg-ao"})"/>
      <text class="dg-label" x="345" y="140" text-anchor="middle">${esc(o.edge)}</text>
      ${o.loop ? `<path class="dg-edge loop" d="M455 130 V92 H270 V56" marker-end="url(#dg-a)"/><text class="dg-label" x="362" y="86" text-anchor="middle">${esc(o.loop)}</text>` : ""}
      ${node(10, 20, 110, "Queued")}${node(170, 20, 120, "Sending")}${node(350, 20, 130, "Acknowledged")}
      ${node(170, 130, 140, "Delivery unknown", "unknown")}${node(380, 130, 150, o.label, o.cls)}
    </svg>`;
    const cap = opt
      ? `The branch after Delivery unknown follows D-3, saved at ${d3.saved.at}. The plan text was not changed by the decision; edit the plan to record it.`
      : "The branch after Delivery unknown follows decision D-3, which is still open.";
    return `<figure class="diagram">${svg}<figcaption>${esc(cap)}</figcaption></figure>`;
  }

  /* Plan tab ------------------------------------------------------------ */
  function renderPlan() {
    const cur = curRev();
    if (state.editing) {
      const dirty = state.draftText !== cur.text;
      const n = nextRevNo();
      return `<div class="doc-bar"><span class="grow" id="edit-state">Editing a draft based on r${cur.rev}. ${dirty ? "Unsaved changes." : "No changes yet."}</span>
        <button type="button" class="btn ghost" data-act="discard-edit">Discard</button>
        <button type="button" class="btn primary" data-act="save-plan" aria-disabled="${!dirty}">Save as r${n}</button></div>
        <div class="banner">${icon("alert")}<span class="grow">Saving creates revision r${n}. It does not start work or grant approval. The execution approval for r${state.planApproval.rev} will no longer cover the current plan.</span></div>
        <label class="sr-only" for="plan-edit">Plan text (Markdown)</label>
        <textarea id="plan-edit" class="edit-area" spellcheck="true">${esc(state.draftText)}</textarea>`;
    }
    if (state.viewing) {
      const v = rev(state.viewing);
      return `<div class="banner">${icon("history")}<span class="grow"><strong>Viewing r${v.rev}</strong>, read-only. Saved by ${esc(v.by)} at ${v.at}: ${esc(v.note)}.</span>
        <button type="button" class="btn sm" data-act="back-current">Back to r${state.current}</button>
        <button type="button" class="btn sm" data-act="restore-rev">Restore as a draft</button></div>
        <article class="doc">${md(v.text)}</article>`;
    }
    return `<div class="doc-bar"><span class="grow">Canonical plan, r${cur.rev}, saved by ${esc(cur.by)} at ${cur.at}</span>
      <button type="button" class="btn" data-act="edit">${icon("edit")}Edit plan</button></div>
      <article class="doc">${md(cur.text)}</article>`;
  }

  /* Decisions tab ------------------------------------------------------- */
  function resumeState() {
    if (!dec("D-3").saved) return { k: "Locked", on: false, sup: false };
    if (state.resume && state.resume.state === "approved")
      return { k: `Approved ${state.resume.at} (demo)`, on: true, sup: false };
    if (state.resume && state.resume.state === "superseded")
      return { k: "Superseded", on: false, sup: true };
    return { k: "Not approved", on: false, sup: false };
  }

  function decisionDetail(d) {
    const ok = anchorOk(d);
    const draftK = d.saved
      ? "Applied"
      : d.localDraft
        ? `Draft saved ${d.localDraft.at}`
        : d.draft
          ? "Unsaved choice"
          : "Empty";
    const rs = d.approval ? resumeState() : { k: "None attached", on: false, sup: false };
    let html = `<div class="dec-meta"><span>${d.id}</span>${pill(d.saved ? "saved" : "needs", d.saved ? "Saved" : "Open")}<span>Raised by ${esc(d.raisedBy)} at ${d.raisedAt}. ${esc(d.scope)}.</span></div>
      <h2 id="dec-title" tabindex="-1">${esc(d.title)}</h2>
      <p class="ctx">${esc(d.context)}</p>
      <p class="ctx" style="margin-top:6px">${
        ok
          ? `Anchored to <button type="button" class="linkish" data-scroll="${slug(d.anchor)}">${esc(d.anchor)}</button> in plan r${state.current}.`
          : `<span class="tone-attn">${icon("alert")} Anchor “${esc(d.anchor)}” is not in plan r${state.current}. It stays unresolved and is not attached anywhere else.</span>`
      }</p>
      ${d.evidence.length ? `<div class="ev-links">${d.evidence.map((e) => `<button type="button" class="chip" data-evidence="${e}">${icon("file")}${e}</button>`).join("")}</div>` : ""}
      <ol class="sep-rail" aria-label="Decision stages">
        <li class="${d.localDraft || d.draft || d.saved ? "on" : ""}"><span class="dot">1</span><span class="k">Draft answer</span><span class="v">${esc(draftK)}</span></li>
        <li class="${d.saved ? "on" : ""}"><span class="dot">2</span><span class="k">Saved decision</span><span class="v">${d.saved ? `Saved ${d.saved.at} by ${esc(d.saved.by)}` : "Not saved"}</span></li>
        <li class="${rs.on ? "on" : ""}${rs.sup ? " sup" : ""}"><span class="dot">3</span><span class="k">Execution approval</span><span class="v">${esc(rs.k)}</span></li>
      </ol>`;

    // 1. Draft
    if (!d.saved) {
      html += `<section class="stage-block"><h3><span class="num">1</span>Draft answer</h3>
        <div role="radiogroup" aria-labelledby="dec-title">${d.options
          .map(
            (
              o,
            ) => `<label class="choice"><input type="radio" name="opt-${d.id}" value="${o.id}" ${d.draft === o.id ? "checked" : ""}/>
            <span class="c-label">${esc(o.label)}${o.suggested ? ` <span class="suggested">Suggested by C2</span>` : ""}</span>
            ${o.detail ? `<span class="c-detail">${esc(o.detail)}</span>` : ""}</label>`,
          )
          .join("")}</div>
        <label class="label" for="dec-note" style="display:block;margin-top:10px">Reason (optional)</label>
        <textarea id="dec-note" class="field" rows="2" style="margin-top:4px">${esc(d.note)}</textarea>
        <div class="row">
          <button type="button" class="btn" data-act="save-draft">Save draft</button>
          <button type="button" class="btn primary" data-act="save-decision" aria-disabled="${!d.draft}">Save decision</button>
          <span class="faint" id="dec-req">${d.draft ? "" : "Choose an option to save a decision."}</span>
        </div>
        <p class="hint">A draft stays in this tab and is not a decision. Saving the decision records it with your name; it does not start work or approve anything.</p>
      </section>`;
    }

    // 2. Saved decision
    html += `<section class="stage-block${d.saved ? "" : " locked"}"><h3><span class="num">2</span>Saved decision</h3>${
      d.saved
        ? `<div class="answer" id="focus-after" tabindex="-1">${icon("check")}<div><strong>${esc(optLabel(d, d.saved.option))}</strong><br/><span class="muted">Saved by ${esc(d.saved.by)} at ${d.saved.at}${d.saved.note ? `. Reason: ${esc(d.saved.note)}` : ""}</span></div></div>
           <div class="row"><button type="button" class="btn ghost" data-act="reopen">Reopen decision</button></div>`
        : `<p class="muted">Not saved. Nothing has been decided.</p>`
    }</section>`;

    // 3. Execution approval (only D-3 carries one in this sample)
    if (d.approval) {
      if (!d.saved) {
        html += `<section class="stage-block locked"><h3><span class="num">3</span>${icon("lock")}Execution approval</h3>
          <p class="muted">Locked until D-3 is saved. Saving it will unlock this step but will not approve anything.</p></section>`;
      } else {
        const approved = state.resume && state.resume.state === "approved";
        const can = state.resumeChecked && planApproved();
        html += `<section class="stage-block"><h3><span class="num">3</span>${icon(approved ? "unlock" : "lock")}Execution approval</h3>
          <dl class="scope">
            <dt>Action</dt><dd>Resume package B (C2)</dd>
            <dt>Plan</dt><dd>r${state.current}${planApproved() ? "" : ` <span class="tone-attn">not approved for execution</span>`}</dd>
            <dt>Attempt</dt><dd>3 of 4</dd>
            <dt>Head</dt><dd><code>7f3a9c2</code></dd>
            <dt>Decision</dt><dd>D-3 as saved at ${d.saved.at}</dd>
          </dl>
          ${
            approved
              ? `<div class="answer" style="margin-top:10px">${icon("check")}<div><strong>Resume approved at ${state.resume.at}</strong> by you (demo).<br/><span class="muted">No agent starts in this prototype. The server would resume package B and the run view would show it running only after it reports.</span></div></div>
                 <div class="row"><button type="button" class="btn ghost" data-act="revoke-resume">Revoke approval</button></div>`
              : `${state.resume && state.resume.state === "superseded" ? `<p class="hint tone-attn">Earlier approval at ${state.resume.at} was superseded: ${esc(state.resume.reason)}.</p>` : ""}
                 ${planApproved() ? "" : `<p class="hint tone-attn">Plan r${state.current} has no execution approval. Approve it in the run panel first.</p>`}
                 <label class="confirm"><input type="checkbox" id="resume-ok" ${state.resumeChecked ? "checked" : ""}/><span>I have checked the scope above: plan r${state.current}, attempt 3, head 7f3a9c2, decision D-3.</span></label>
                 <div class="row"><button type="button" class="btn primary" data-act="approve-resume" aria-disabled="${!can}">Approve resume (demo)</button></div>
                 <p class="hint">Recorded in this prototype only. Nothing runs and nothing merges.</p>`
          }
        </section>`;
      }
    } else if (d.saved) {
      html += `<p class="hint faint" style="margin-top:12px">No execution approval is attached to this decision. It was applied by editing the plan.</p>`;
    }

    html += `<section style="margin-top:18px"><h3 class="label">History</h3><ul class="dec-hist">${d.history
      .map(
        (h) =>
          `<li><span class="t">${h.at}</span><span class="by">${esc(h.by)}</span><span>${esc(h.text)}</span></li>`,
      )
      .join("")}</ul></section>`;
    return html;
  }

  function renderDecisions() {
    const open = state.decisions.filter((d) => !d.saved);
    const saved = state.decisions.filter((d) => d.saved);
    const item = (
      d,
    ) => `<button type="button" class="dec-item" data-decision="${d.id}" aria-current="${d.id === state.selDecision}">
      ${glyph(d.saved ? "saved" : "needs")}<span class="t">${d.id} ${esc(d.title)}</span>
      <span class="m">${anchorOk(d) ? `Anchored to ${esc(d.anchor)}` : `<span class="warn">Anchor not found in r${state.current}</span>`}</span></button>`;
    return `<div class="dec"><div class="dec-list" role="list">
      <p class="label">Open ${open.length}</p>${open.length ? open.map(item).join("") : `<p class="muted" style="padding:4px 8px">No open decisions.</p>`}
      <p class="label">Saved ${saved.length}</p>${saved.map(item).join("")}
      </div><div class="dec-detail">${decisionDetail(dec(state.selDecision))}</div></div>`;
  }

  /* Evidence tab -------------------------------------------------------- */
  function sectionsWith(id) {
    const out = [];
    let cur = null;
    (curRev().text || "").split("\n").forEach((l) => {
      if (l.startsWith("## ")) cur = l.slice(3).trim();
      else if (cur && l.includes(`[${id}]`) && !out.includes(cur)) out.push(cur);
    });
    return out;
  }
  function renderEvidence() {
    return `<div class="ev"><p>Results and checks linked from the plan and decisions. Only host checks at the current head can pass. Agent reports stay unverified, and cancelled or earlier-head results are never shown as current.</p>
      ${P.evidence
        .map((e) => {
          const usedD = state.decisions.filter((d) => d.evidence.includes(e.id));
          const usedS = sectionsWith(e.id);
          const used = usedD
            .map((d) => dchip(d.id))
            .concat(
              usedS.map(
                (s) =>
                  `<button type="button" class="linkish" data-scroll="${slug(s)}">${esc(s)}</button>`,
              ),
            );
          return `<div class="ev-row ${e.status}${state.hlEvidence === e.id ? " hl" : ""}" id="ev-${e.id}" tabindex="-1">
            ${glyph(e.status)}<span class="id">${e.id}</span>
            <span><span class="t">${esc(e.title)}</span><span class="src">${esc(e.source)}${e.head ? `, ${e.head.length === 7 ? `<code>${e.head}</code>` : esc(e.head)}` : ""}</span><span class="note">${esc(e.note)}</span></span>
            <span>${pill(e.status, e.label)}</span>
            <div class="used">${used.length ? `Used by ${used.join(" ")}` : "Not referenced by the current plan"}${e.agent ? ` ${achip(e.agent)}` : ""}</div>
          </div>`;
        })
        .join("")}</div>`;
  }

  /* Outline, status and rail -------------------------------------------- */
  function renderOutline() {
    const text = state.viewing ? rev(state.viewing).text : curRev().text;
    const hs = headings(text);
    $("outline").innerHTML = `
      <div class="o-group"><p class="label">${state.viewing ? `Plan r${state.viewing}` : "Plan"}</p>${hs
        .map(
          (h) =>
            `<button type="button" class="o-item" data-scroll="${slug(h)}"><span class="grow">${esc(h)}</span></button>`,
        )
        .join("")}</div>
      <div class="o-group"><p class="label">Decisions</p>${state.decisions
        .map(
          (d) =>
            `<button type="button" class="o-item" data-decision="${d.id}" aria-current="${state.tab === "decisions" && d.id === state.selDecision}">${glyph(d.saved ? "saved" : "needs")}<span class="grow">${d.id} ${esc(d.title)}</span>${anchorOk(d) ? "" : `<span class="meta tone-attn">Unresolved</span>`}</button>`,
        )
        .join("")}</div>
      <div class="o-group"><p class="label">Revisions</p>${state.revisions
        .slice()
        .reverse()
        .map((r) => {
          const meta = r.rev === state.current ? "Current" : r.text ? r.at : "Not in sample";
          return r.text && r.rev !== state.current
            ? `<button type="button" class="o-item" data-view-rev="${r.rev}" aria-current="${state.viewing === r.rev}"><span class="grow">r${r.rev} ${esc(r.by)}</span><span class="meta">${meta}</span></button>`
            : `<div class="o-item unavailable"><span class="grow">r${r.rev} ${esc(r.by)}</span><span class="meta">${meta}</span></div>`;
        })
        .join("")}</div>`;
  }

  function renderStatus() {
    const a = state.planApproval;
    const parts = [`<span>Plan r${state.current}, saved ${curRev().at}</span>`];
    if (state.editing) parts.push(pill("draft", "Unsaved plan draft"));
    parts.push(
      a.state === "approved" && a.rev === state.current
        ? pill("saved", `Execution approved: r${a.rev}, attempt 3`)
        : pill("superseded", `r${a.rev} approval superseded by r${state.current}`),
    );
    $("plan-status").innerHTML = parts.join("");
    const open = state.decisions.filter((d) => !d.saved).length;
    document.querySelectorAll("[data-tab]").forEach((b) => {
      const on = b.dataset.tab === state.tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (b.dataset.tab === "decisions")
        b.innerHTML = `Decisions${open ? ` <span class="n" aria-label="${open} open">${open}</span>` : ""}`;
    });
  }

  function runView() {
    const d3 = dec("D-3");
    if (!d3.saved) return ["needs", "Waiting on D-3"];
    if (state.resume && state.resume.state === "approved")
      return ["paused", "Paused, resume approved (demo)"];
    return ["paused", "Paused, decision saved"];
  }
  function renderRail() {
    const [rs, rt] = runView();
    const d3saved = !!dec("D-3").saved;
    const stages = [
      ["done", "Intake", "Issue #4821"],
      ["done", "Design", "v2 approved in round 2"],
      [
        d3saved ? "paused" : "needs",
        "Build",
        d3saved ? "Package B paused" : "Package B waiting on D-3",
      ],
      ["failed", "Integrate", "Failed at 7f3a9c2"],
      ["returned", "Review", "Round 1 of 2 sent back"],
      ["notrun", "PR", "Not opened, merge locked"],
    ];
    const a = state.planApproval;
    const pa = a.state === "approved" && a.rev === state.current;
    const resume = resumeState();
    $("rail").innerHTML = `
      <section class="rail-sec rail-run"><p class="m">NEO-4821, Core reliability</p><p class="t">${esc(RUN.title)}</p>
        <p>${pill(rs, rt)}</p><p class="m" style="margin-top:6px">Attempt 3 of 4, head <code>7f3a9c2</code>, base <code>e19c4d0</code></p></section>
      <section class="rail-sec"><h3>Stages</h3><ul class="stages">${stages
        .map(
          ([s, k, v]) =>
            `<li>${glyph(s)}<span class="k">${k}</span><span class="v">${esc(v)}</span></li>`,
        )
        .join("")}</ul></section>
      <section class="rail-sec"><h3>Agents</h3><ul class="agents">${RUN.agents
        .map(
          (
            x,
          ) => `<li><button type="button" data-agent="${x.id}" style="--d:${x.depth}" aria-current="${state.hlAgent === x.id}">${glyph(x.status)}
            <span class="who">${x.id} ${esc(x.role)}${x.managed === "observed" ? ` <span class="tag observed">Observed</span>` : ""}</span>
            <span class="sub${x.status === "orphaned" ? " orphaned" : ""}">${esc(x.statusText)}, ${esc(x.elapsed)}</span></button></li>`,
        )
        .join(
          "",
        )}</ul><p class="demo-note" style="margin-top:6px">Cost: not reported for any agent. Select an agent to see its result.</p></section>
      <section class="rail-sec"><h3>Approvals</h3><ul class="appr">
        <li>${glyph(pa ? "saved" : "superseded")}<span><span class="k">Plan execution</span><span class="v">${
          pa
            ? `r${a.rev} approved for attempt 3 at ${a.at} by ${esc(a.by)}`
            : `r${a.rev} approval superseded. r${state.current} is not approved.`
        }</span>${
          pa
            ? ""
            : state.planReapprove
              ? `<span class="v" style="margin-top:6px">Approves plan r${state.current} for attempt 3 at 7f3a9c2. No work starts from this action.</span>
                 <span style="display:flex;gap:6px;margin-top:6px"><button type="button" class="btn sm primary" data-act="confirm-plan">Approve r${state.current} (demo)</button><button type="button" class="btn sm ghost" data-act="cancel-plan">Cancel</button></span>`
              : `<span style="display:block;margin-top:6px"><button type="button" class="btn sm" data-act="approve-plan">Review approval for r${state.current}</button></span>`
        }</span></li>
        <li>${glyph(resume.on ? "saved" : resume.sup ? "superseded" : "locked")}<span><span class="k">Resume package B</span><span class="v">${esc(resume.k)}${
          resume.k === "Locked" ? ", needs D-3 saved" : ""
        }</span>${d3saved ? `<button type="button" class="linkish" data-decision="D-3" style="font-size:var(--fs-meta)">Open D-3</button>` : ""}</span></li>
        <li>${glyph("locked")}<span><span class="k">Merge</span><span class="v">Locked. Yours under the merge policy, in GitHub.</span></span></li>
      </ul></section>
      <section class="rail-sec rail-links"><a href="runs.html#NEO-4821">${icon("list")} Open in runs view</a><a href="workflow.html#NEO-4821">${icon("map")} Open in workflow map</a></section>`;
  }

  function render(focusSel) {
    renderStatus();
    renderOutline();
    const w = $("workspace");
    w.setAttribute("aria-labelledby", "tab-" + state.tab);
    w.innerHTML =
      state.tab === "plan"
        ? renderPlan()
        : state.tab === "decisions"
          ? renderDecisions()
          : renderEvidence();
    renderRail();
    if (focusSel) {
      const el = typeof focusSel === "string" ? document.querySelector(focusSel) : null;
      if (el) el.focus();
    }
  }

  /* Navigation helpers -------------------------------------------------- */
  function goTab(tab, focusSel) {
    state.tab = tab;
    render(focusSel);
  }
  function scrollToSection(id) {
    if (state.editing) {
      NK.toast("Save or discard your plan edit first.");
      return;
    }
    state.tab = "plan";
    render();
    const h = $(id);
    if (!h) {
      NK.toast("That section is not in this revision.");
      return;
    }
    h.scrollIntoView({ block: "start" });
    h.focus({ preventScroll: true });
    h.classList.add("flash");
    setTimeout(() => h.classList.remove("flash"), 1200);
  }
  function showEvidence(id, agent) {
    state.hlEvidence = id;
    state.hlAgent = agent || null;
    goTab("evidence");
    const row = $("ev-" + id);
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
    }
  }

  /* Actions --------------------------------------------------------------- */
  const ACTIONS = {
    edit() {
      state.viewing = null;
      state.editing = true;
      state.draftText = curRev().text;
      render("#plan-edit");
    },
    "discard-edit"() {
      state.editing = false;
      state.draftText = "";
      render();
      NK.toast(`Edit discarded. r${state.current} is unchanged.`);
    },
    "save-plan"() {
      const cur = curRev();
      if (state.draftText === cur.text) return NK.toast("No changes to save.");
      const n = nextRevNo();
      const at = demoTime();
      state.revisions.push({ rev: n, by: "You", at, note: "Edited by you", text: state.draftText });
      state.current = n;
      state.editing = false;
      if (state.planApproval.state === "approved") state.planApproval.state = "superseded";
      if (state.resume && state.resume.state === "approved")
        Object.assign(state.resume, { state: "superseded", reason: `plan changed to r${n}` });
      state.resumeChecked = false;
      render();
      NK.toast(
        `Saved as r${n}. No work started. The r${state.planApproval.rev} execution approval no longer covers the plan.`,
      );
    },
    "back-current"() {
      state.viewing = null;
      render();
    },
    "restore-rev"() {
      const v = rev(state.viewing);
      state.viewing = null;
      state.editing = true;
      state.draftText = v.text;
      render("#plan-edit");
      NK.toast(`r${v.rev} copied into a draft. Nothing changes until you save.`);
    },
    "save-draft"() {
      const d = dec(state.selDecision);
      if (!d.draft && !d.note.trim())
        return NK.toast("Choose an option or write a reason before saving a draft.");
      d.localDraft = { option: d.draft, note: d.note, at: demoTime() };
      render();
      NK.toast("Draft saved in this tab. It is not a decision.");
    },
    "save-decision"() {
      const d = dec(state.selDecision);
      if (!d.draft) {
        NK.toast("Choose an option before saving the decision.");
        const f = document.querySelector(`input[name="opt-${d.id}"]`);
        if (f) f.focus();
        return;
      }
      const at = demoTime();
      d.saved = { option: d.draft, note: d.note.trim(), at, by: "You" };
      d.history.unshift({ at, by: "You", text: `Saved: ${optLabel(d, d.draft)}.` });
      d.localDraft = null;
      state.resumeChecked = false;
      render("#focus-after");
      NK.toast("Decision saved. No work started and nothing was approved.");
    },
    reopen() {
      const d = dec(state.selDecision);
      const prev = d.saved;
      const at = demoTime();
      d.draft = prev.option;
      d.note = prev.note;
      d.saved = null;
      d.history.unshift({
        at,
        by: "You",
        text: `Reopened. Previous answer kept: ${optLabel(d, prev.option)}.`,
      });
      if (d.approval && state.resume && state.resume.state === "approved")
        Object.assign(state.resume, { state: "superseded", reason: `D-3 reopened at ${at}` });
      render("#dec-title");
      NK.toast("Decision reopened. Your previous answer is kept as a draft.");
    },
    "approve-resume"() {
      if (!dec("D-3").saved) return;
      if (!planApproved())
        return NK.toast(`Plan r${state.current} needs execution approval first.`);
      if (!state.resumeChecked) {
        NK.toast("Tick the scope check first.");
        const c = $("resume-ok");
        if (c) c.focus();
        return;
      }
      state.resume = { at: demoTime(), rev: state.current, state: "approved" };
      render();
      NK.toast("Resume approved (demo). Nothing runs in this prototype.");
    },
    "revoke-resume"() {
      state.resume = null;
      state.resumeChecked = false;
      render();
      NK.toast("Resume approval revoked.");
    },
    "approve-plan"() {
      state.planReapprove = true;
      render('[data-act="confirm-plan"]');
    },
    "cancel-plan"() {
      state.planReapprove = false;
      render('[data-act="approve-plan"]');
    },
    "confirm-plan"() {
      state.planApproval = { rev: state.current, at: demoTime(), by: "You", state: "approved" };
      state.planReapprove = false;
      render();
      NK.toast(`Plan r${state.current} approved for execution (demo). No work started.`);
    },
  };

  NK.onReady(() => {
    state = initialState();

    document.addEventListener("click", (e) => {
      const t = e.target.closest(
        "[data-act],[data-tab],[data-scroll],[data-decision],[data-evidence],[data-agent],[data-view-rev]",
      );
      if (!t) return;
      const ds = t.dataset;
      if (ds.act) return ACTIONS[ds.act]();
      if (ds.tab) return goTab(ds.tab);
      if (ds.scroll) return scrollToSection(ds.scroll);
      if (ds.decision) {
        state.selDecision = ds.decision;
        return goTab("decisions", "#dec-title");
      }
      if (ds.evidence) return showEvidence(ds.evidence);
      if (ds.agent) return showEvidence(P.AGENT_EVIDENCE[ds.agent], ds.agent);
      if (ds.viewRev) {
        if (state.editing) return NK.toast("Save or discard your plan edit first.");
        state.viewing = Number(ds.viewRev);
        state.tab = "plan";
        return render();
      }
    });

    $("workspace").addEventListener("input", (e) => {
      if (e.target.id === "plan-edit") {
        state.draftText = e.target.value;
        const dirty = state.draftText !== curRev().text;
        const b = document.querySelector('[data-act="save-plan"]');
        if (b) b.setAttribute("aria-disabled", String(!dirty));
        const s = $("edit-state");
        if (s)
          s.textContent = `Editing a draft based on r${state.current}. ${dirty ? "Unsaved changes." : "No changes yet."}`;
      } else if (e.target.id === "dec-note") {
        dec(state.selDecision).note = e.target.value;
      }
    });
    $("workspace").addEventListener("change", (e) => {
      const d = dec(state.selDecision);
      if (e.target.name === "opt-" + d.id) {
        d.draft = e.target.value;
        const b = document.querySelector('[data-act="save-decision"]');
        if (b) b.setAttribute("aria-disabled", "false");
        const r = $("dec-req");
        if (r) r.textContent = "";
        const v = document.querySelector(".sep-rail li:first-child .v");
        if (v && !d.localDraft) v.textContent = "Unsaved choice";
      } else if (e.target.id === "resume-ok") {
        state.resumeChecked = e.target.checked;
        const b = document.querySelector('[data-act="approve-resume"]');
        if (b) b.setAttribute("aria-disabled", String(!(state.resumeChecked && planApproved())));
      }
    });

    // Tabs: arrow keys move between tabs
    document.querySelector(".p-tabs").addEventListener("keydown", (e) => {
      const tabs = ["plan", "decisions", "evidence"];
      const i = tabs.indexOf(state.tab);
      let n = -1;
      if (e.key === "ArrowRight") n = (i + 1) % 3;
      else if (e.key === "ArrowLeft") n = (i + 2) % 3;
      else if (e.key === "Home") n = 0;
      else if (e.key === "End") n = 2;
      if (n >= 0) {
        e.preventDefault();
        goTab(tabs[n], "#tab-" + tabs[n]);
      }
    });

    $("reset-demo").addEventListener("click", () => {
      state = initialState();
      render();
      NK.toast("Demo state reset.");
    });

    render();
  });
})();
