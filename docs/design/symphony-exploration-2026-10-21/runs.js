/* Concept A: run-first operating view. All state is local demo state. */
(function () {
  "use strict";
  const F = window.NK_FIX;
  const NK = window.NK;
  const { icon, esc, pill, glyph } = NK;
  const WF = Object.fromEntries(F.workflows.map((w) => [w.id, w.name]));

  let state;
  function initialState() {
    return {
      runs: NK.clone(F.runs).map((r) => Object.assign(r, { ui: {} })),
      wf: "all",
      scope: "active",
      filter: "all",
      q: "",
      sel: "NEO-4821",
      detailOpen: false,
      clock: 30,
      decision: { draft: null, note: "", saved: null },
      resolved: [],
      confirmRetry: false,
    };
  }
  // Demo clock: each recorded action advances one minute from 14:30.
  function demoTime() {
    state.clock += 1;
    return "14:" + String(state.clock).padStart(2, "0");
  }

  const $ = (id) => document.getElementById(id);
  const runById = (id) => state.runs.find((r) => r.id === id);

  /* Projection helpers ----------------------------------------------- */
  function openAttention(r) {
    return !!r.attention && !r.ui.attnResolved;
  }
  function view(r) {
    if (r.id === "NEO-4821" && state.decision.saved)
      return {
        status: "paused",
        text: r.ui.resume ? "Paused, resume requested" : "Paused, decision saved",
      };
    if (r.id === "NEO-4799" && r.ui.resume)
      return { status: "paused", text: "Paused, resume requested" };
    if (r.id === "NEO-4776" && r.ui.merge)
      return { status: "requested", text: "Merge approved, not merged" };
    return { status: r.status, text: r.statusText };
  }
  function stageStatus(r, k) {
    if (r.id === "NEO-4821" && k === "build" && state.decision.saved) return "paused";
    if (r.id === "NEO-4776" && k === "pr" && r.ui.merge) return "queued";
    return r.stages[k];
  }
  const ATTN_GLYPH = { decision: "needs", orphaned: "orphaned", repeat: "failed", merge: "needs" };
  const SEV = { critical: 0, high: 1, medium: 2, low: 3 };

  const FILTERS = [
    { id: "all", label: "All", test: () => true },
    { id: "needs", label: "Needs you", icon: "alert", test: (r) => openAttention(r) },
    { id: "running", label: "Running", icon: "ring", test: (r) => view(r).status === "running" },
    { id: "paused", label: "Paused", icon: "pause", test: (r) => view(r).status === "paused" },
    { id: "failed", label: "Failed", icon: "x", test: (r) => r.status === "failed" },
    {
      id: "orphaned",
      label: "Tracking lost",
      icon: "orphan",
      test: (r) => r.status === "orphaned",
    },
    { id: "queued", label: "Queued", icon: "circle", test: (r) => r.status === "queued" },
  ];

  function inScope(r) {
    if (state.scope === "active") return !r.history;
    if (state.scope === "history") return !!r.history;
    return true;
  }
  function matchesQuery(r) {
    const q = state.q.trim().toLowerCase();
    if (!q) return true;
    return [r.id, r.title, r.branch, r.head, WF[r.workflow]].join(" ").toLowerCase().includes(q);
  }
  function baseSet() {
    return state.runs.filter(
      (r) => (state.wf === "all" || r.workflow === state.wf) && inScope(r) && matchesQuery(r),
    );
  }
  function visibleRuns() {
    const f = FILTERS.find((x) => x.id === state.filter);
    return baseSet().filter(f.test);
  }

  /* Sidebar ---------------------------------------------------------- */
  function renderSidebar() {
    const items = [{ id: "all", name: "All workflows" }].concat(F.workflows);
    $("workflows").innerHTML = items
      .map((w) => {
        const rs = state.runs.filter((r) => !r.history && (w.id === "all" || r.workflow === w.id));
        const attn = rs.filter(openAttention).length;
        return `<button type="button" data-wf="${w.id}" aria-pressed="${state.wf === w.id}">
          <span>${esc(w.name)}</span>
          ${attn ? `<span class="attn-dot" title="${attn} need you"><span class="sr-only">, ${attn} need you,</span>${attn}</span>` : ""}
          <span class="n"><span class="sr-only">active runs: </span>${rs.length}</span>
        </button>`;
      })
      .join("");
  }

  function renderChips() {
    const base = baseSet();
    $("chips").innerHTML = FILTERS.map((f) => {
      const n = base.filter(f.test).length;
      return `<button type="button" data-filter="${f.id}" aria-pressed="${state.filter === f.id}">
        ${f.icon ? icon(f.icon) : ""}${esc(f.label)} <span class="n">${n}</span></button>`;
    }).join("");
    document
      .querySelectorAll("[data-scope]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scope === state.scope)));
  }

  /* Attention -------------------------------------------------------- */
  function renderAttention() {
    const items = state.runs
      .filter(openAttention)
      .sort((a, b) => SEV[a.attention.severity] - SEV[b.attention.severity]);
    const scoped =
      state.wf !== "all" || state.filter !== "all" || state.q || state.scope !== "active";
    let html = `<div class="r-attn-head"><h2 id="attn-title">Needs you <span class="faint">${items.length}</span></h2>
      ${scoped ? `<span class="faint">Shown regardless of filters, so nothing waiting on you is hidden</span>` : ""}</div>`;
    if (!items.length) html += `<p class="empty">Nothing is waiting on you.</p>`;
    else
      html +=
        "<ul>" +
        items
          .map(
            (
              r,
            ) => `<li><button type="button" data-open="${r.id}" aria-current="${r.id === state.sel}">
          ${glyph(ATTN_GLYPH[r.attention.kind])}
          <span class="a-id">${r.id}</span>
          <span class="a-sum"><strong>${esc(r.attention.label)}</strong>${esc(r.attention.summary)}</span>
          <span class="a-wf">${esc(WF[r.workflow])}</span></button></li>`,
          )
          .join("") +
        "</ul>";
    if (state.resolved.length)
      html +=
        `<div class="r-resolved"><p class="label">Resolved in this session</p>` +
        state.resolved
          .map(
            (x) => `<p>${icon("check")}<span>${x.id}</span><span>${esc(x.label)} at ${x.at}</span>
            <button type="button" class="linkish" data-reopen="${x.id}">${x.id === "NEO-4821" ? "Reopen decision" : "Withdraw approval"}</button></p>`,
          )
          .join("") +
        `</div>`;
    $("attention").innerHTML = html;
  }

  /* Run list --------------------------------------------------------- */
  function strip(r) {
    const parts = F.STAGES.map((k) => {
      const s = stageStatus(r, k);
      const label = (NK.STATUS[s] || NK.STATUS.unknown).label;
      return { k, s, label };
    });
    const aria = parts.map((p) => `${F.STAGE_NAMES[p.k]} ${p.label.toLowerCase()}`).join(", ");
    return `<span class="strip" role="img" aria-label="Stages: ${aria}">${parts
      .map((p) => `<i class="${p.s}" title="${F.STAGE_NAMES[p.k]}: ${p.label}"></i>`)
      .join("")}</span>`;
  }
  function row(r) {
    const v = view(r);
    const sel = r.id === state.sel;
    const sub = `${r.attempt ? `${F.STAGE_NAMES[r.stage]}, attempt ${r.attempt}` : "Not started"}${state.wf === "all" ? `, ${WF[r.workflow]}` : ""}`;
    return `<div class="r-row" role="option" id="opt-${r.id}" data-id="${r.id}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}">
      ${glyph(v.status)}
      <span class="r-id">${r.id}</span>
      <span class="r-title"><span class="t">${esc(r.title)}</span><span class="s">${esc(v.text)} <span class="faint">· ${esc(sub)}</span></span></span>
      ${strip(r)}
      <span class="r-when ${r.elapsed.kind === "orphaned" ? "orphaned" : ""}">${esc(r.elapsed.text.split(" · ")[0])}</span>
    </div>`;
  }
  function renderList() {
    const list = $("run-list");
    const hadFocus = list.contains(document.activeElement);
    const rs = visibleRuns();
    // keep the selection valid without silently jumping when it is filtered out
    let html = "";
    if (!rs.length) {
      html = `<p class="r-empty">No runs match. ${state.q ? `Clear the search “${esc(state.q)}” or ` : ""}choose another filter.</p>`;
    } else if (state.scope === "all") {
      const act = rs.filter((r) => !r.history);
      const his = rs.filter((r) => r.history);
      if (act.length) html += group("Active", act);
      if (his.length) html += group("History", his);
    } else {
      html += group(state.scope === "active" ? "Active" : "History", rs);
    }
    list.innerHTML = html;
    if (!rs.some((r) => r.id === state.sel)) {
      const first = list.querySelector(".r-row");
      if (first) first.tabIndex = 0;
    }
    if (hadFocus) {
      const target = $("opt-" + state.sel) || list.querySelector(".r-row");
      if (target) target.focus();
    }
  }
  function group(label, rs) {
    const gid = "g-" + label.toLowerCase();
    return `<div role="group" aria-labelledby="${gid}"><div class="r-group-label"><span class="label" id="${gid}">${label}</span><span class="n">${rs.length}</span></div>${rs.map(row).join("")}</div>`;
  }

  /* Detail ----------------------------------------------------------- */
  function nextText(r) {
    if (r.id === "NEO-4821" && state.decision.saved)
      return r.ui.resume
        ? "Wait for the server to report package B running. Nothing in this prototype will report it."
        : "Resume package B when you are ready. Resuming is its own request.";
    return r.next;
  }
  function nowClass(r) {
    if (openAttention(r) && r.attention.kind !== "orphaned" && r.attention.kind !== "repeat")
      return "attn";
    if (r.status === "orphaned") return "orphan";
    if (r.status === "failed" && !r.history) return "danger";
    return "";
  }

  function actDecision(r) {
    const d = F.decision;
    const s = state.decision;
    if (!s.saved) {
      return `<div class="d-act">
        <p class="q" id="dq">${d.id}: ${esc(d.title)}</p>
        <p class="ctx">${esc(d.context)}</p>
        <div role="radiogroup" aria-labelledby="dq">
          ${d.options
            .map(
              (
                o,
              ) => `<label class="choice"><input type="radio" name="d3" value="${o.id}" ${s.draft === o.id ? "checked" : ""} />
              <span class="c-label">${esc(o.label)}${o.suggested ? ` <span class="suggested">Suggested by C2</span>` : ""}</span>
              <span class="c-detail">${esc(o.detail)}</span></label>`,
            )
            .join("")}
        </div>
        <label class="label" for="d3-note" style="display:block;margin-top:10px">Note for the record (optional)</label>
        <textarea id="d3-note" class="field" rows="2" style="margin-top:4px">${esc(s.note)}</textarea>
        <div class="row">
          <button type="button" class="btn primary" data-act="save-decision" aria-disabled="${!s.draft}" aria-describedby="d3-hint">Save decision</button>
          <span class="faint" id="d3-req">${s.draft ? "" : "Choose an option first."}</span>
        </div>
        <p class="hint" id="d3-hint">Saving records your answer. It does not resume package B, approve the plan or merge anything.</p>
      </div>`;
    }
    const opt = d.options.find((o) => o.id === s.saved.option);
    return `<div class="d-act">
      <div class="saved" id="act-focus" tabindex="-1">${icon("check")}<div><strong>Decision saved at ${s.saved.at}</strong> by you<br />${esc(opt.label)}${
        s.saved.note ? `<br /><span class="muted">Note: ${esc(s.saved.note)}</span>` : ""
      }</div></div>
      ${
        r.ui.resume
          ? `<p class="hint">Resume requested at ${r.ui.resume} (demo). The run stays paused until the server reports package B running. This prototype has no server, so it will not change on its own.</p>
             <div class="row"><button type="button" class="btn" data-act="withdraw-resume">Withdraw resume request</button>
             <button type="button" class="btn ghost" data-act="reopen-decision">Reopen decision</button></div>`
          : `<div class="row"><button type="button" class="btn primary" data-act="resume">${icon("play")}Resume package B</button>
             <button type="button" class="btn ghost" data-act="reopen-decision">Reopen decision</button></div>
             <p class="hint">Saving the decision did not start any work. Resume is a separate request for attempt 3 at <code>7f3a9c2</code>.</p>`
      }
    </div>`;
  }

  function actFor(r) {
    const u = r.ui;
    switch (r.action) {
      case "decide":
        return actDecision(r);
      case "paused":
        return u.resume
          ? `<div class="d-act"><p class="hint" id="act-focus" tabindex="-1">Resume requested at ${u.resume} (demo). Still paused until the server reports the run running.</p>
             <div class="row"><button type="button" class="btn" data-act="withdraw-resume">Withdraw resume request</button></div></div>`
          : `<div class="d-act"><div class="row" style="margin-top:0"><button type="button" class="btn primary" data-act="resume">${icon("play")}Resume on <code>5c0d8e1</code></button></div>
             <p class="hint">Requests a resume of attempt 2. The base branch has moved since you paused.</p></div>`;
      case "stop":
        return u.stop
          ? `<div class="d-act"><p class="hint" id="act-focus" tabindex="-1" style="margin-top:0">Stop requested at ${u.stop} (demo). Still shown as tracking lost: no exit has been observed, so elapsed time stays frozen at the last observation and cleanup stays blocked.</p>
             <div class="row"><button type="button" class="btn" data-act="withdraw-stop">Withdraw stop request</button></div></div>`
          : `<div class="d-act"><div class="row" style="margin-top:0"><button type="button" class="btn primary" data-act="stop">${icon("stop")}Request stop</button></div>
             <p class="hint">The run stays marked as tracking lost until the agent's exit is observed. Worktree cleanup stays blocked until then.</p></div>`;
      case "retry":
        if (u.retry)
          return `<div class="d-act"><p class="hint" id="act-focus" tabindex="-1" style="margin-top:0">Attempt 3 requested at ${u.retry} (demo). This stays in Needs you until attempt 3 reports a result.</p>
             <div class="row"><button type="button" class="btn" data-act="withdraw-retry">Withdraw request</button></div></div>`;
        if (state.confirmRetry)
          return `<div class="d-act" id="act-focus" tabindex="-1"><p class="q">Retry as attempt 3 of 3?</p>
             <p class="ctx">It would start from <code>c77a312</code> with the same workflow. Attempts 1 and 2 failed with the same ENOENT signature and nothing has changed since.</p>
             <div class="row"><button type="button" class="btn primary" data-act="retry">Request attempt 3</button>
             <button type="button" class="btn ghost" data-act="cancel-retry">Cancel</button></div></div>`;
        return `<div class="d-act"><div class="row" style="margin-top:0"><button type="button" class="btn" data-act="confirm-retry">Review retry</button></div></div>`;
      case "merge":
        return u.merge
          ? `<div class="d-act"><div class="saved" id="act-focus" tabindex="-1">${icon("check")}<div><strong>Merge approval recorded at ${u.merge}</strong> (demo)<br />Not merged. Merging happens in GitHub under the workflow's merge policy.</div></div>
             <div class="row"><button type="button" class="btn ghost" data-act="withdraw-merge">Withdraw approval</button></div></div>`
          : `<div class="d-act"><ul class="checklist">
               <li>${glyph("passed")}CI passed on PR #1279 at <code>0b7d2f6</code></li>
               <li>${glyph("passed")}Review round 1 approved at <code>0b7d2f6</code></li>
               <li>${glyph("passed")}Validation head matches PR head</li>
               <li>${glyph("passed")}GitHub reports mergeable</li></ul>
             <div class="row"><button type="button" class="btn primary" data-act="merge">Record merge approval</button></div>
             <p class="hint">Records your approval in this prototype only. Nothing is merged.</p></div>`;
      case "running":
        return `<div class="d-act"><p class="hint" style="margin-top:0">Elapsed time ticks in the product. This prototype shows a fixed start time and no live numbers.</p></div>`;
      default:
        return "";
    }
  }

  function renderDetail(focusAct) {
    const r = runById(state.sel);
    const el = $("detail");
    if (!r) {
      el.innerHTML = `<div class="d-body"><p class="r-empty">Select a run to see its blocker and next step.</p></div>`;
      return;
    }
    const v = view(r);
    const agents = r.agents.length
      ? `<section class="d-sec"><h3>Agents</h3><ul class="tree">${r.agents
          .map(
            (a) => `<li data-depth="${a.depth}">${glyph(a.status)}
              <span><span class="who">${a.id} ${esc(a.role)}</span>
              ${a.managed === "managed" ? ` <span class="tag">Managed</span>` : a.managed === "observed" ? ` <span class="tag observed">Observed native</span>` : ""}
              <span class="sub">${esc(a.model)}${a.model.startsWith("Sample") ? " (sample label)" : ""}</span></span>
              <span class="right"><span class="${a.status === "orphaned" ? "orphaned" : ""}">${esc(a.statusText)}</span><br />${esc(a.elapsed)}<br />Cost ${NK.costText(a.cost).toLowerCase()}</span></li>`,
          )
          .join("")}</ul></section>`
      : "";
    const review = r.review
      ? `<section class="d-sec"><h3>Review</h3>
          <p>${pill(r.review.status, r.review.verdict)} <span class="muted">Round ${r.review.round} of ${r.review.of} at <code>${r.review.head}</code>${r.review.head !== r.head ? ", an earlier head" : ""}</span></p>
          ${r.review.findings.length ? `<ul class="findings">${r.review.findings.map((f) => `<li><span class="sev">${esc(f.sev)}</span><span>${esc(f.text)}<span class="st">${esc(f.state)}</span></span></li>`).join("")}</ul>` : ""}
        </section>`
      : "";
    const validation = r.validation.length
      ? `<section class="d-sec"><h3>Validation</h3><ul class="checks">${r.validation
          .map(
            (c) =>
              `<li class="${c.status}">${glyph(c.status)}<span><span class="cmd">${esc(c.cmd)}</span><span class="note">${esc(c.note)}</span></span><span class="at">${pill(c.status)}</span></li>`,
          )
          .join(
            "",
          )}</ul><p class="rule">Only a host check at the current head can pass. Agent reports, unknown and superseded results never show green.</p></section>`
      : "";

    el.innerHTML = `
      <div class="d-head">
        <button type="button" class="btn ghost sm d-back" data-act="close-detail">${icon("chevronLeft")}Back to runs</button>
        <div class="d-meta"><span>${r.id}</span><span>${esc(WF[r.workflow])}</span>${pill(v.status, v.text)}</div>
        <h2 id="detail-title">${esc(r.title)}</h2>
        <div class="d-links">
          <a href="workflow.html#${r.id}">${icon("map")} Open in workflow map</a>
          ${r.id === "NEO-4821" ? `<a href="planning.html">${icon("doc")} Open plan and decisions</a>` : ""}
        </div>
      </div>
      <div class="d-body">
        <div class="d-now ${nowClass(r)}">
          <p class="k">${r.blocker ? "Current blocker" : "Status"}</p>
          <p class="blocker">${esc(r.blocker || v.text)}</p>
          <p class="next"><strong>Next:</strong> ${esc(nextText(r))}</p>
          ${actFor(r)}
        </div>
        <section class="d-sec d-ctx"><h3>Root task</h3>
          <p>${esc(r.context.objective)}</p>
          ${r.context.acceptance.length ? `<ul>${r.context.acceptance.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
          <p class="faint">${esc(r.context.source)}. ${esc(r.context.plan)}.</p>
        </section>
        <section class="d-sec"><h3>Attempt and head</h3>
          <dl class="kv">
            <dt>Attempt</dt><dd>${r.attempt ? `${r.attempt} of ${r.maxAttempts}` : "Not started"}</dd>
            <dt>Head</dt><dd>${r.head.length === 7 ? `<code>${r.head}</code>` : esc(r.head)}</dd>
            <dt>Base</dt><dd><code>${r.base}</code></dd>
            <dt>Branch</dt><dd>${r.branch.startsWith("symphony/") ? `<code>${esc(r.branch)}</code>` : esc(r.branch)}</dd>
            <dt>Worktree</dt><dd>${r.worktree.startsWith("~") ? `<code>${esc(r.worktree)}</code>` : esc(r.worktree)}</dd>
            <dt>Provider</dt><dd>${esc(r.provider)}${r.model.startsWith("Sample") ? `, ${esc(r.model)} (sample label)` : ""}</dd>
            <dt>Elapsed</dt><dd class="${r.elapsed.kind === "orphaned" ? "tone-orphan" : ""}">${esc(r.elapsed.text)}</dd>
            <dt>Cost</dt><dd>${NK.costText(r.cost)}</dd>
          </dl>
        </section>
        ${validation}
        ${review}
        ${agents}
        <section class="d-sec"><h3>Recent events</h3><ul class="timeline">${r.timeline
          .map((t) => `<li><span class="t">${t.t}</span><span>${esc(t.text)}</span></li>`)
          .join("")}</ul></section>
      </div>`;
    if (focusAct) {
      const f = $("act-focus") || el.querySelector(".d-act button");
      if (f) f.focus();
    }
  }

  function render(focusAct) {
    $("layout").dataset.detailOpen = String(state.detailOpen);
    renderSidebar();
    renderChips();
    renderAttention();
    renderList();
    renderDetail(focusAct);
  }

  /* Actions ---------------------------------------------------------- */
  function select(id, open) {
    state.sel = id;
    if (open) state.detailOpen = true;
    render();
    if (open && window.matchMedia("(max-width: 900px)").matches) $("detail").focus();
  }
  function resolve(r, label, at) {
    r.ui.attnResolved = true;
    state.resolved = state.resolved.filter((x) => x.id !== r.id).concat({ id: r.id, label, at });
  }
  function unresolve(r) {
    r.ui.attnResolved = false;
    state.resolved = state.resolved.filter((x) => x.id !== r.id);
  }

  function reopenDecision() {
    const r = runById("NEO-4821");
    const prev = state.decision.saved;
    state.decision = { draft: prev ? prev.option : null, note: prev ? prev.note : "", saved: null };
    r.ui.resume = null;
    unresolve(r);
    NK.toast(
      "Decision reopened. Your previous answer is kept as a draft and package B is still paused.",
    );
  }

  const ACTIONS = {
    "save-decision"() {
      const s = state.decision;
      if (!s.draft) {
        NK.toast("Choose an option before saving.");
        const first = document.querySelector('input[name="d3"]');
        if (first) first.focus();
        return false;
      }
      const at = demoTime();
      s.saved = { option: s.draft, note: s.note.trim(), at };
      resolve(runById("NEO-4821"), "D-3 decision saved", at);
      NK.toast("Decision saved. Package B is still paused; nothing has resumed.");
    },
    "reopen-decision": reopenDecision,
    resume(r) {
      r.ui.resume = demoTime();
      NK.toast(
        "Resume requested (demo). The run stays paused until the server reports it running.",
      );
    },
    "withdraw-resume"(r) {
      r.ui.resume = null;
      NK.toast("Resume request withdrawn.");
    },
    stop(r) {
      r.ui.stop = demoTime();
      NK.toast("Stop requested (demo). Still tracking lost until an exit is observed.");
    },
    "withdraw-stop"(r) {
      r.ui.stop = null;
      NK.toast("Stop request withdrawn.");
    },
    "confirm-retry"() {
      state.confirmRetry = true;
    },
    "cancel-retry"() {
      state.confirmRetry = false;
    },
    retry(r) {
      state.confirmRetry = false;
      r.ui.retry = demoTime();
      NK.toast("Attempt 3 requested (demo). Still listed under Needs you.");
    },
    "withdraw-retry"(r) {
      r.ui.retry = null;
      NK.toast("Retry request withdrawn.");
    },
    merge(r) {
      const at = demoTime();
      r.ui.merge = at;
      resolve(r, "Merge approval recorded", at);
      NK.toast("Merge approval recorded (demo). Nothing was merged.");
    },
    "withdraw-merge"(r) {
      r.ui.merge = null;
      unresolve(r);
      NK.toast("Merge approval withdrawn. Back in Needs you.");
    },
    "close-detail"() {
      state.detailOpen = false;
      render();
      const rowEl = $("opt-" + state.sel);
      if (rowEl) rowEl.focus();
      return false;
    },
  };

  /* Events ----------------------------------------------------------- */
  function onClick(e) {
    const t = e.target.closest(
      "[data-act],[data-open],[data-reopen],[data-wf],[data-scope],[data-filter],.r-row",
    );
    if (!t) return;
    if (t.dataset.act) {
      if (t.dataset.act !== "close-detail" && t.getAttribute("aria-disabled") === "true") {
        ACTIONS[t.dataset.act]();
        return;
      }
      const res = ACTIONS[t.dataset.act](runById(state.sel));
      if (res !== false) render(true);
      return;
    }
    if (t.dataset.open) return select(t.dataset.open, true);
    if (t.dataset.reopen) {
      if (t.dataset.reopen === "NEO-4821") reopenDecision();
      else ACTIONS["withdraw-merge"](runById(t.dataset.reopen));
      state.sel = t.dataset.reopen;
      return render();
    }
    if (t.dataset.wf) {
      state.wf = t.dataset.wf;
      return render();
    }
    if (t.dataset.scope) {
      state.scope = t.dataset.scope;
      return render();
    }
    if (t.dataset.filter) {
      state.filter = t.dataset.filter;
      return render();
    }
    if (t.classList.contains("r-row")) {
      t.focus();
      return select(t.dataset.id, true);
    }
  }

  function onListKey(e) {
    const rows = Array.from($("run-list").querySelectorAll(".r-row"));
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement);
    let n = -1;
    if (e.key === "ArrowDown") n = Math.min(rows.length - 1, i + 1);
    else if (e.key === "ArrowUp") n = Math.max(0, i - 1);
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = rows.length - 1;
    else if ((e.key === "Enter" || e.key === " ") && i >= 0) {
      e.preventDefault();
      return select(rows[i].dataset.id, true);
    }
    if (n >= 0) {
      e.preventDefault();
      state.sel = rows[n].dataset.id;
      render();
      $("opt-" + state.sel).focus();
    }
  }

  function onGlobalKey(e) {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea";
    if (e.key === "/" && !typing) {
      e.preventDefault();
      $("search").focus();
    } else if (e.key === "Escape") {
      if (e.target.id === "search" && state.q) {
        state.q = "";
        $("search").value = "";
        render();
      } else if (state.detailOpen && window.matchMedia("(max-width: 900px)").matches) {
        ACTIONS["close-detail"]();
      }
    }
  }

  NK.onReady(() => {
    state = initialState();
    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash && runById(fromHash)) state.sel = fromHash;
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onGlobalKey);
    $("run-list").addEventListener("keydown", onListKey);
    $("search").addEventListener("input", (e) => {
      state.q = e.target.value;
      render();
    });
    $("detail").addEventListener("change", (e) => {
      if (e.target.name === "d3") {
        state.decision.draft = e.target.value;
        const btn = document.querySelector('[data-act="save-decision"]');
        if (btn) btn.setAttribute("aria-disabled", "false");
        const req = $("d3-req");
        if (req) req.textContent = "";
      }
    });
    $("detail").addEventListener("input", (e) => {
      if (e.target.id === "d3-note") state.decision.note = e.target.value;
    });
    $("reset-demo").addEventListener("click", () => {
      state = initialState();
      $("search").value = "";
      render();
      NK.toast("Demo state reset.");
    });
    render();
  });
})();
