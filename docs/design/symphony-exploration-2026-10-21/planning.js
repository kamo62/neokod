/* Concept C: plan and decisions workspace.
   Shared with A and B under neokod-symphony-proto:shared. Saved decisions, plan
   revisions, the plan draft and pinned approvals survive reload and navigation.
   Local demo state only: nothing here starts an agent or approves real execution. */
(function () {
  "use strict";
  const F = window.NK_FIX;
  const P = window.NK_PLAN;
  const NK = window.NK;
  const S = NK.shared;
  const { esc, icon, glyph, pill } = NK;
  const $ = (id) => document.getElementById(id);
  const RUN = F.runs.find((r) => r.id === "NEO-4821");
  const RUN_MACHINE = NK.runMachine(RUN.id);
  const SAMPLE = { itemId: "NEO-4821", attempt: 3 };

  let state;

  function mergeRevisions(shared) {
    const base = NK.clone(P.revisions);
    const added = (shared.plan.revisions || []).slice();
    const byRev = new Map(base.map((r) => [r.rev, r]));
    added.forEach((r) => byRev.set(r.rev, Object.assign({}, byRev.get(r.rev) || {}, r)));
    return Array.from(byRev.values()).sort((a, b) => a.rev - b.rev);
  }
  function mergeDecisions(shared) {
    return NK.clone(P.decisions).map((d) => {
      const ov = shared.decisions && shared.decisions[d.id];
      if (!ov) return Object.assign(d, { draft: null, note: "", localDraft: null });
      const out = Object.assign(d, {
        draft: ov.draft !== undefined ? ov.draft : null,
        note: ov.note !== undefined ? ov.note : "",
        localDraft: ov.localDraft || null,
      });
      if (ov.saved !== undefined) out.saved = ov.saved;
      if (ov.history) out.history = ov.history.concat(d.history || []);
      return out;
    });
  }
  function sampleSelection(sel) {
    return (
      sel &&
      sel.kind === "original" &&
      sel.itemId === SAMPLE.itemId &&
      Number(sel.attempt) === SAMPLE.attempt
    );
  }
  function initialTab(shared) {
    const qp = new URLSearchParams(location.search);
    const fromQuery = qp.get("tab");
    if (["plan", "decisions", "evidence"].indexOf(fromQuery) >= 0) return fromQuery;
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash === "evidence") return "evidence";
    if (hash === "decisions") return "decisions";
    return ["plan", "decisions", "evidence"].indexOf(shared.cTab) >= 0 ? shared.cTab : "plan";
  }
  function routeSelection(shared) {
    const qp = new URLSearchParams(location.search);
    const qItem = qp.get("item");
    const qAttempt = qp.get("attempt");
    const attempt = qAttempt === null || qAttempt === "" ? null : Number(qAttempt);
    if (qItem) {
      const known = F.runs.find((r) => r.id === qItem && !r.history);
      return {
        kind: qItem === "NEO-4838" ? "reference" : "original",
        itemId: qItem,
        attempt:
          attempt !== null && !isNaN(attempt)
            ? attempt
            : known
              ? known.attempt || 0
              : qItem === "NEO-4838"
                ? 0
                : 0,
      };
    }
    const hash = decodeURIComponent(location.hash.slice(1));
    const knownHash = F.runs.find((r) => r.id === hash && !r.history);
    if (knownHash)
      return { kind: "original", itemId: knownHash.id, attempt: knownHash.attempt || 0 };
    if (hash === "NEO-4838") return { kind: "reference", itemId: hash, attempt: 0 };
    return shared.selection;
  }
  function bootState(opts) {
    opts = opts || {};
    const shared = S.load().state;
    const revisions = mergeRevisions(shared);
    const last = revisions.filter((r) => r.text).slice(-1)[0];
    const current = revisions.some((r) => r.rev === shared.plan.current && r.text)
      ? shared.plan.current
      : last
        ? last.rev
        : shared.plan.current;
    const selection = opts.ignoreRoute ? shared.selection : routeSelection(shared);
    return {
      shared: shared,
      selection: selection,
      sample: sampleSelection(selection),
      tab: initialTab(shared),
      revisions: revisions,
      current: current,
      viewing: null,
      editing: false,
      draftText: "",
      editBase: null,
      planApproval: shared.plan.approval,
      planReapprove: false,
      decisions: mergeDecisions(shared),
      selDecision: "D-3",
      resumeApproval: shared.resumeApproval,
      resumeChecked: false,
      hlEvidence: null,
      hlAgent: null,
    };
  }
  function applyShared(shared) {
    state.shared = shared;
    state.selection = shared.selection;
    state.sample = sampleSelection(shared.selection);
    state.revisions = mergeRevisions(shared);
    if (state.revisions.some((r) => r.rev === shared.plan.current && r.text)) {
      state.current = shared.plan.current;
    } else {
      const last = state.revisions.filter((r) => r.text).slice(-1)[0];
      if (last) state.current = last.rev;
    }
    state.planApproval = shared.plan.approval;
    state.decisions = mergeDecisions(shared);
    state.resumeApproval = shared.resumeApproval;
  }
  function persist(fn) {
    const res = S.update(fn);
    applyShared(res.state);
    return res;
  }

  const dec = (id) => state.decisions.find((d) => d.id === id);
  const rev = (n) => state.revisions.find((r) => r.rev === n);
  const curRev = () => rev(state.current) || state.revisions.filter((r) => r.text).slice(-1)[0];
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
  const decSaved = () => {
    const d = dec("D-3");
    return d && d.saved ? d.saved : null;
  };
  function scopeCtx(withDecision) {
    const saved = decSaved();
    const ctx = {
      itemId: state.selection.itemId,
      attempt: state.selection.attempt,
      planRev: state.current,
      head: RUN.head,
      machine: RUN_MACHINE,
    };
    if (withDecision) ctx.decisionAt = saved ? saved.at : "";
    return ctx;
  }
  function planApproved() {
    const a = state.planApproval;
    if (!a || a.state !== "approved") return false;
    return !S.scopeProblem(a, scopeCtx(false));
  }
  function planApprovalProblem() {
    const a = state.planApproval;
    if (!a) return "No plan execution approval is recorded.";
    if (a.state !== "approved") return a.reason || "The plan execution approval was superseded.";
    return S.scopeProblem(a, scopeCtx(false));
  }

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
  function recoveredDraft() {
    const dr = state.shared.plan.draft;
    if (!dr || typeof dr.text !== "string") return null;
    const cur = curRev();
    if (dr.text === cur.text) return null;
    return dr;
  }
  function draftBanner(dr) {
    return `<div class="banner" role="status">${icon("edit")}<span class="grow"><strong>Unsaved plan draft recovered</strong> from ${esc(
      dr.at || "an earlier visit",
    )}, based on r${dr.baseRev}. It is stored locally and is not a saved revision.</span>
      <button type="button" class="btn sm" data-act="resume-draft">Resume draft</button>
      <button type="button" class="btn sm ghost" data-act="discard-draft">Discard draft</button></div>`;
  }
  function renderPlan() {
    const cur = curRev();
    const dr = recoveredDraft();
    if (state.editing) {
      const dirty = state.draftText !== cur.text;
      const n = nextRevNo();
      const draftBase = state.editBase || (dr ? dr.baseRev : cur.rev);
      return `<div class="doc-bar"><span class="grow" id="edit-state">Editing a draft based on r${draftBase}. ${dirty ? "Unsaved changes are kept locally." : "No changes yet."}</span>
        <button type="button" class="btn ghost" data-act="discard-edit">Discard</button>
        <button type="button" class="btn primary" data-act="save-plan" aria-disabled="${!dirty}">Save as r${n}</button></div>
        <div class="banner">${icon("alert")}<span class="grow">Saving creates revision r${n}. It does not start work or grant approval. The execution approval ${
          state.planApproval && state.planApproval.rev != null
            ? `for r${state.planApproval.rev}`
            : "already recorded"
        } will no longer cover the current plan, and a matching resume approval is invalidated.</span></div>
        ${dr ? `<div class="banner">${icon("edit")}<span class="grow">Draft also stored locally at ${esc(dr.at || "an earlier visit")}. If you close or reload, it can be recovered.</span></div>` : ""}
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
    return `${dr ? draftBanner(dr) : ""}<div class="doc-bar"><span class="grow">Canonical plan, r${cur.rev}, saved by ${esc(cur.by)} at ${cur.at}. Pinned to NEO-4821 attempt 3 on ${esc(NK.machineLabel(RUN_MACHINE))} (${esc(RUN_MACHINE)}).</span>
      <button type="button" class="btn" data-act="edit">${icon("edit")}Edit plan</button></div>
      <article class="doc">${md(cur.text)}</article>`;
  }

  /* Decisions tab ------------------------------------------------------- */
  function resumeState() {
    const d3 = dec("D-3");
    if (!d3.saved)
      return { k: "Locked", on: false, sup: false, reason: "D-3 must be saved first." };
    const a = state.resumeApproval;
    if (!a)
      return {
        k: "Not approved",
        on: false,
        sup: false,
        reason: "No resume approval is recorded.",
      };
    if (a.state !== "approved")
      return {
        k: "Superseded",
        on: false,
        sup: true,
        reason: a.reason || "The earlier approval was withdrawn.",
      };
    const problem = S.scopeProblem(a, scopeCtx(true));
    if (problem) return { k: "Superseded", on: false, sup: true, reason: problem };
    return { k: `Approved ${a.at} (demo)`, on: true, sup: false, reason: null };
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
    const savedD3 = decSaved();
    let html = `<div class="dec-meta"><span>${d.id}</span>${pill(d.saved ? "saved" : "needs", d.saved ? "Saved" : "Open")}<span>Raised by ${esc(d.raisedBy)} at ${d.raisedAt}. ${esc(d.scope)}. On ${esc(NK.machineLabel(RUN_MACHINE))} (${esc(RUN_MACHINE)}), attempt 3.</span></div>
      <h2 id="dec-title" tabindex="-1">${esc(d.title)}</h2>
      <p class="ctx">${esc(d.context)}</p>
      <p class="nk-scope-line">Applies to NEO-4821 attempt 3 on ${esc(NK.machineLabel(RUN_MACHINE))} (${esc(RUN_MACHINE)}), head ${RUN.head}. This answer is shared with Runs and Execution.</p>
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
        <p class="hint">A saved draft stays local until you replace it. It is not a decision. Saving the decision records it with your name; it does not start work or approve anything.</p>
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
        const approved = rs.on;
        const can = state.resumeChecked && planApproved();
        html += `<section class="stage-block"><h3><span class="num">3</span>${icon(approved ? "unlock" : "lock")}Execution approval</h3>
          <dl class="scope">
            <dt>Action</dt><dd>Resume package B (C2)</dd>
            <dt>Machine</dt><dd>${NK.machineChip(RUN_MACHINE)} <span class="faint">immutable id <code>${esc(
              RUN_MACHINE,
            )}</code></span></dd>
            <dt>Item</dt><dd>NEO-4821</dd>
            <dt>Attempt</dt><dd>3 of ${RUN.maxAttempts}</dd>
            <dt>Plan</dt><dd>r${state.current}${planApproved() ? "" : ` <span class="tone-attn">not approved for execution</span>`}</dd>
            <dt>Head</dt><dd><code>${RUN.head}</code></dd>
            <dt>Decision</dt><dd>D-3 as saved at ${esc(savedD3.at)}</dd>
          </dl>
          ${
            approved
              ? `<div class="answer" style="margin-top:10px">${icon("check")}<div><strong>Resume approved at ${esc(
                  state.resumeApproval.at,
                )}</strong> by you (demo).<br/><span class="muted">Pinned to attempt 3 on ${esc(
                  NK.machineLabel(RUN_MACHINE),
                )} (${esc(RUN_MACHINE)}), plan r${state.resumeApproval.rev}, head ${esc(
                  state.resumeApproval.head,
                )}, decision saved ${esc(state.resumeApproval.decisionAt)}. No agent starts in this prototype.</span></div></div>
                 <div class="row"><button type="button" class="btn ghost" data-act="revoke-resume">Revoke approval</button></div>`
              : `<p class="hint tone-attn">${icon("alert")} ${esc(rs.reason || "")}</p>
                 ${planApproved() ? "" : `<p class="hint tone-attn">Plan r${state.current} has no matching execution approval. Approve the plan in the run context first.</p>`}
                 <label class="confirm"><input type="checkbox" id="resume-ok" ${state.resumeChecked ? "checked" : ""}/><span>I have checked the scope: NEO-4821 attempt 3 on ${esc(
                   NK.machineLabel(RUN_MACHINE),
                 )} (${esc(RUN_MACHINE)}), plan r${state.current}, head ${RUN.head}, decision D-3 saved ${esc(
                   savedD3.at,
                 )}.</span></label>
                 <div class="row"><button type="button" class="btn primary" data-act="approve-resume" aria-disabled="${!can}">Approve resume on ${esc(
                   NK.machineLabel(RUN_MACHINE),
                 )} (${esc(RUN_MACHINE)}) (demo)</button></div>
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
    return `<div class="ev"><p>Results and checks linked from the plan and decisions, for NEO-4821 attempt 3 on ${esc(
      NK.machineLabel(RUN_MACHINE),
    )} (${esc(RUN_MACHINE)}). Only host checks at the current head can pass. Agent reports stay unverified, and cancelled or earlier-head results are never shown as current.</p>
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
            <span><span class="t">${esc(e.title)}</span><span class="src">${esc(e.source)}${
              e.head ? `, ${e.head.length === 7 ? `<code>${e.head}</code>` : esc(e.head)}` : ""
            } · on ${esc(NK.machineLabel(RUN_MACHINE))} (${esc(RUN_MACHINE)})</span><span class="note">${esc(e.note)}</span></span>
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

  function renderIdent() {
    const el = $("plan-ident");
    if (!el) return;
    el.innerHTML = `${NK.machineChip(NK.runMachine(state.selection.itemId))} <span>${esc(
      state.selection.itemId,
    )}, attempt ${esc(String(state.selection.attempt))}</span>`;
  }
  function renderItemTabs() {
    const el = $("item-tabs");
    if (!el) return;
    el.innerHTML = state.sample
      ? NK.itemTabs(state.selection, state.tab === "evidence" ? "evidence" : "decisions")
      : "";
  }
  function renderStatus() {
    if (!state.sample) {
      $("plan-status").innerHTML =
        NK.machineChip(NK.runMachine(state.selection.itemId)) +
        `<span>${esc(state.selection.itemId)}, attempt ${esc(
          String(state.selection.attempt),
        )}</span>` +
        pill("locked", "No plan sample");
      document.querySelectorAll("[data-tab]").forEach((b) => {
        const on = b.dataset.tab === state.tab;
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
        if (b.dataset.tab === "decisions") b.innerHTML = "Decisions";
      });
      return;
    }
    const a = state.planApproval;
    const problem = planApprovalProblem();
    const parts = [
      `<span>Plan r${state.current}, saved ${curRev().at}</span>`,
      NK.machineChip(RUN_MACHINE),
      `<span>NEO-4821 attempt 3</span>`,
    ];
    if (state.editing) parts.push(pill("draft", "Unsaved plan draft, kept locally"));
    parts.push(
      !problem
        ? pill("saved", `Execution approved: r${a.rev}, attempt 3`)
        : pill(
            a && a.state === "approved" ? "superseded" : "superseded",
            a && a.state === "approved"
              ? `r${a.rev} approval no longer covers r${state.current}`
              : "Plan not execution-approved",
          ),
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
    if (resumeState().on) return ["paused", "Paused, resume approved (demo)"];
    return ["paused", "Paused, decision saved"];
  }
  function renderRail() {
    if (!state.sample) {
      $("rail").innerHTML = `<section class="rail-sec rail-run"><p class="m">${esc(
        state.selection.itemId,
      )} attempt ${esc(String(state.selection.attempt))}</p><p class="t">Selected item on ${esc(
        NK.machineLabel(NK.runMachine(state.selection.itemId)),
      )} (${esc(NK.runMachine(state.selection.itemId))})</p>${NK.machineChip(
        NK.runMachine(state.selection.itemId),
      )}<p class="demo-note" style="margin-top:8px">No plan sample is attached to this selection. Nothing is claimed about its execution.</p></section>
        <section class="rail-sec rail-links"><a href="${S.itemHref("runs.html", state.selection)}">${icon(
          "list",
        )} Open in runs view</a><a href="${S.itemHref("workflow.html", state.selection)}">${icon(
          "map",
        )} Open in workflow map</a></section>`;
      return;
    }
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
    const pa = planApproved();
    const paProblem = planApprovalProblem();
    const resume = resumeState();
    $("rail").innerHTML = `
      <section class="rail-sec rail-run"><p class="m">NEO-4821, Core reliability</p><p class="t">${esc(RUN.title)}</p>
        <p>${pill(rs, rt)}</p><p style="margin-top:6px">${NK.machineChip(RUN_MACHINE)}</p>
        <p class="m" style="margin-top:6px">Attempt 3 of 4, head <code>7f3a9c2</code>, base <code>e19c4d0</code>, machine ${esc(
          NK.machineLabel(RUN_MACHINE),
        )} (${esc(RUN_MACHINE)})</p></section>
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
        .join("")}</ul><p class="demo-note" style="margin-top:6px">On ${esc(
        NK.machineLabel(RUN_MACHINE),
      )} (${esc(RUN_MACHINE)}). Cost: not reported for any agent.</p></section>
      <section class="rail-sec"><h3>Approvals</h3><ul class="appr">
        <li>${glyph(pa ? "saved" : "superseded")}<span><span class="k">Plan execution</span><span class="v">${
          pa
            ? `r${a.rev} approved for attempt 3 on ${esc(NK.machineLabel(RUN_MACHINE))} (${esc(RUN_MACHINE)}) at ${a.at} by ${esc(a.by)}`
            : `${esc(paProblem || "The plan approval was superseded.")}`
        }</span>${
          pa
            ? ""
            : state.planReapprove
              ? `<span class="v" style="margin-top:6px">Approves plan r${state.current} for attempt 3 on ${esc(
                  NK.machineLabel(RUN_MACHINE),
                )} (${esc(RUN_MACHINE)}) at ${RUN.head}. No work starts from this action.</span>
                 <span style="display:flex;gap:6px;margin-top:6px"><button type="button" class="btn sm primary" data-act="confirm-plan">Approve r${state.current} on ${esc(
                   NK.machineLabel(RUN_MACHINE),
                 )} (demo)</button><button type="button" class="btn sm ghost" data-act="cancel-plan">Cancel</button></span>`
              : `<span style="display:block;margin-top:6px"><button type="button" class="btn sm" data-act="approve-plan">Review approval for r${state.current}</button></span>`
        }</span></li>
        <li>${glyph(resume.on ? "saved" : resume.sup ? "superseded" : "locked")}<span><span class="k">Resume package B</span><span class="v">${esc(
          resume.k,
        )}${resume.reason ? `: ${esc(resume.reason)}` : ""}</span>${d3saved ? `<button type="button" class="linkish" data-decision="D-3" style="font-size:var(--fs-meta)">Open D-3</button>` : ""}</span></li>
        <li>${glyph("locked")}<span><span class="k">Merge</span><span class="v">Locked. Yours under the merge policy, in GitHub.</span></span></li>
      </ul></section>
      <section class="rail-sec rail-links"><a href="${S.itemHref("runs.html", state.selection)}">${icon(
        "list",
      )} Open in runs view</a><a href="${S.itemHref("workflow.html", state.selection)}">${icon(
        "map",
      )} Open in workflow map</a></section>`;
  }

  function renderUnavailable() {
    $("outline").innerHTML =
      `<div class="o-group"><p class="label">Selected item</p><div class="o-item unavailable"><span class="grow">${esc(
        state.selection.itemId,
      )}</span><span class="meta">attempt ${esc(String(state.selection.attempt))}</span></div></div>`;
    $("workspace").innerHTML =
      `<div class="banner" role="status">${icon("alert")}<span class="grow"><strong>No plan sample for this selection.</strong> The Plan and decisions sample exists for NEO-4821 attempt 3 on ${esc(
        NK.machineLabel(RUN_MACHINE),
      )} (${esc(RUN_MACHINE)}). Selected: ${esc(state.selection.itemId)} attempt ${esc(
        String(state.selection.attempt),
      )} on ${esc(NK.machineLabel(NK.runMachine(state.selection.itemId)))} (${esc(
        NK.runMachine(state.selection.itemId),
      )}). Nothing is inferred about that item's plan, decisions or execution.</span></div>
      <div class="doc-bar"><span class="grow">Choose the sample or return to the operating view.</span>
        <button type="button" class="btn" data-act="use-sample">Use NEO-4821 attempt 3</button>
        <a class="btn" href="${S.itemHref("runs.html", state.selection)}">Open summary</a>
        <a class="btn" href="${S.itemHref("workflow.html", state.selection)}">Open execution</a>
      </div>`;
  }

  function render(focusSel) {
    renderIdent();
    renderItemTabs();
    renderStatus();
    if (!state.sample) {
      renderUnavailable();
      renderRail();
      if (focusSel) {
        const el = document.querySelector(focusSel);
        if (el) el.focus();
      }
      return;
    }
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
    persist((s) => {
      s.cTab = tab;
    });
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
      const dr = recoveredDraft();
      state.draftText = dr ? dr.text : curRev().text;
      state.editBase = dr ? dr.baseRev : state.current;
      render("#plan-edit");
      if (dr)
        NK.toast(
          "Recovered your locally stored plan draft. Saving still needs an explicit Save as r.",
        );
    },
    "resume-draft"() {
      const dr = recoveredDraft();
      if (!dr) return NK.toast("No stored plan draft is available.");
      state.tab = "plan";
      state.viewing = null;
      state.editing = true;
      state.draftText = dr.text;
      state.editBase = dr.baseRev;
      render("#plan-edit");
    },
    "discard-draft"() {
      persist((s) => {
        s.plan.draft = null;
      });
      state.editing = false;
      state.draftText = "";
      render();
      NK.toast("Local plan draft discarded. Saved revisions are unchanged.");
    },
    "discard-edit"() {
      persist((s) => {
        s.plan.draft = null;
      });
      state.editing = false;
      state.draftText = "";
      render();
      NK.toast(`Edit discarded. r${state.current} is unchanged.`);
    },
    "save-plan"() {
      const cur = curRev();
      if (!state.draftText.trim())
        return NK.toast("The draft is kept locally. Enter plan text before saving a revision.");
      if (state.draftText === cur.text) return NK.toast("No changes to save.");
      const n = nextRevNo();
      const at = NK.nowText();
      persist((s) => {
        s.plan.revisions = (s.plan.revisions || []).concat({
          rev: n,
          by: "You",
          at,
          note: "Edited by you",
          text: state.draftText,
        });
        s.plan.current = n;
        s.plan.draft = null;
        if (s.plan.approval)
          s.plan.approval = Object.assign({}, s.plan.approval, {
            state: "superseded",
            reason: `Plan changed to r${n}`,
          });
        if (s.resumeApproval)
          s.resumeApproval = Object.assign({}, s.resumeApproval, {
            state: "superseded",
            reason: `Plan changed to r${n}`,
          });
      });
      state.current = n;
      state.editing = false;
      state.draftText = "";
      state.resumeChecked = false;
      render();
      NK.toast(
        `Saved as r${n}. No work started. The earlier execution approval no longer covers the plan, and any resume approval is invalidated.`,
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
      state.editBase = state.current;
      persist((s) => {
        s.plan.draft = { baseRev: state.current, text: v.text, at: NK.nowText() };
      });
      render("#plan-edit");
      NK.toast(`r${v.rev} copied into a draft. Nothing changes until you save.`);
    },
    "save-draft"() {
      const d = dec(state.selDecision);
      if (!d.draft && !d.note.trim())
        return NK.toast("Choose an option or write a reason before saving a draft.");
      const at = NK.nowText();
      persist((s) => {
        s.decisions[d.id] = Object.assign({}, s.decisions[d.id], {
          localDraft: { option: d.draft, note: d.note, at },
        });
      });
      render();
      NK.toast("Draft saved locally. It is not a decision.");
    },
    "save-decision"() {
      const d = dec(state.selDecision);
      if (!d.draft) {
        NK.toast("Choose an option before saving the decision.");
        const f = document.querySelector(`input[name="opt-${d.id}"]`);
        if (f) f.focus();
        return;
      }
      const at = NK.nowText();
      persist((s) => {
        const cur = Object.assign({}, s.decisions[d.id]);
        cur.saved = { option: d.draft, note: d.note.trim(), at, by: "You" };
        cur.draft = null;
        cur.localDraft = null;
        cur.history = (cur.history || []).concat({
          at,
          by: "You",
          text: `Saved: ${optLabel(d, d.draft)}.`,
        });
        s.decisions[d.id] = cur;
        if (d.id === "D-3") {
          s.requests = s.requests || {};
          s.requests["NEO-4821"] = Object.assign({}, s.requests["NEO-4821"], {
            attnResolved: { at, label: "D-3 decision saved" },
          });
          if (s.resumeApproval)
            s.resumeApproval = Object.assign({}, s.resumeApproval, {
              state: "superseded",
              reason: `D-3 saved again at ${at}`,
            });
        }
      });
      state.resumeChecked = false;
      render("#focus-after");
      NK.toast("Decision saved. No work started and nothing was approved.");
    },
    reopen() {
      const d = dec(state.selDecision);
      const prev = d.saved;
      const at = NK.nowText();
      persist((s) => {
        const cur = Object.assign({}, s.decisions[d.id]);
        cur.draft = prev.option;
        cur.note = prev.note;
        cur.saved = null;
        cur.history = (cur.history || []).concat({
          at,
          by: "You",
          text: `Reopened. Previous answer kept: ${optLabel(d, prev.option)}.`,
        });
        s.decisions[d.id] = cur;
        if (d.id === "D-3") {
          s.requests = s.requests || {};
          const req = Object.assign({}, s.requests["NEO-4821"]);
          delete req.attnResolved;
          delete req.resume;
          s.requests["NEO-4821"] = req;
          if (s.resumeApproval)
            s.resumeApproval = Object.assign({}, s.resumeApproval, {
              state: "superseded",
              reason: `D-3 reopened at ${at}`,
            });
        }
      });
      state.resumeChecked = false;
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
      const saved = decSaved();
      const at = NK.nowText();
      persist((s) => {
        s.resumeApproval = {
          at,
          by: "You",
          state: "approved",
          rev: state.current,
          itemId: "NEO-4821",
          attempt: 3,
          head: RUN.head,
          machine: RUN_MACHINE,
          decisionAt: saved.at,
        };
      });
      state.resumeChecked = false;
      render();
      NK.toast(
        `Resume approved (demo) for attempt 3 on ${NK.machineLabel(RUN_MACHINE)} (${RUN_MACHINE}), plan r${state.current}, decision saved ${saved.at}. Nothing runs in this prototype.`,
      );
    },
    "revoke-resume"() {
      persist((s) => {
        s.resumeApproval = null;
      });
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
      const at = NK.nowText();
      persist((s) => {
        s.plan.approval = {
          rev: state.current,
          at,
          by: "You",
          state: "approved",
          itemId: "NEO-4821",
          attempt: 3,
          head: RUN.head,
          machine: RUN_MACHINE,
        };
      });
      state.planReapprove = false;
      render();
      NK.toast(
        `Plan r${state.current} approved for execution on ${NK.machineLabel(RUN_MACHINE)} (${RUN_MACHINE}) attempt 3 (demo). No work started.`,
      );
    },
    "use-sample"() {
      persist((s) => {
        s.selection = { kind: "original", itemId: SAMPLE.itemId, attempt: SAMPLE.attempt };
        s.runsView.selectedKey = "r:" + SAMPLE.itemId;
      });
      state.current = state.shared.plan.current;
      state.tab = "plan";
      render();
      NK.toast("Showing the NEO-4821 attempt 3 sample. No state was changed by switching.");
    },
  };

  NK.onReady(() => {
    state = bootState();
    if (
      state.selection.kind !== state.shared.selection.kind ||
      state.selection.itemId !== state.shared.selection.itemId ||
      Number(state.selection.attempt) !== Number(state.shared.selection.attempt)
    ) {
      persist((s) => {
        s.selection = state.selection;
        s.runsView.selectedKey = "r:" + state.selection.itemId;
      });
    }

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
        persist((s) => {
          s.plan.draft = {
            baseRev: state.editBase || state.current,
            text: state.draftText,
            at: NK.nowText(),
          };
        });
        const dirty = state.draftText !== curRev().text;
        const b = document.querySelector('[data-act="save-plan"]');
        if (b) b.setAttribute("aria-disabled", String(!dirty));
        const st = $("edit-state");
        if (st)
          st.textContent = `Editing a draft based on r${state.editBase || state.current}. Canonical is r${state.current}. ${
            dirty ? "Unsaved changes are kept locally." : "No changes yet."
          }`;
      } else if (e.target.id === "dec-note") {
        const d = dec(state.selDecision);
        d.note = e.target.value;
        persist((s) => {
          s.decisions[d.id] = Object.assign({}, s.decisions[d.id], { note: d.note });
        });
      }
    });
    $("workspace").addEventListener("change", (e) => {
      const d = dec(state.selDecision);
      if (e.target.name === "opt-" + d.id) {
        d.draft = e.target.value;
        persist((s) => {
          s.decisions[d.id] = Object.assign({}, s.decisions[d.id], { draft: d.draft });
        });
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
      const shared = S.reset();
      state = bootState({ ignoreRoute: true });
      state.shared = shared;
      applyShared(shared);
      try {
        history.replaceState(null, "", location.pathname + "#plan");
      } catch (e) {
        /* file:// may refuse; the in-memory reset still applies */
      }
      render();
      NK.toast("Plan and decisions demo state reset. Shared decisions and plans were reset too.");
    });

    S.subscribe((next) => {
      applyShared(next);
      render();
    });

    render();
  });
})();
