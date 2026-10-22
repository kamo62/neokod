/* Concept A: run-first operating view. All state is local demo state.
   The selected original item/attempt, saved decisions and run actions are shared with
   B and C under neokod-symphony-proto:shared. Work's demo receipts are read from
   neokod-symphony-proto:work:receipts and stay read-only here. */
(function () {
  "use strict";
  const F = window.NK_FIX;
  const NK = window.NK;
  const S = NK.shared;
  const { icon, esc, pill, glyph } = NK;
  const WF = Object.fromEntries(F.workflows.map((w) => [w.id, w.name]));
  const $ = (id) => document.getElementById(id);

  const REFERENCE = {
    id: "NEO-4838",
    title: "Warn before removing a worktree with uncommitted changes",
    workflow: "settings",
    status: "accepted",
    statusText: "Accepted on Work PC, not running",
    stage: "intake",
    stages: {
      intake: "notrun",
      design: "notrun",
      build: "notrun",
      integrate: "notrun",
      review: "notrun",
      pr: "notrun",
    },
    attempt: 0,
    maxAttempts: 0,
    head: "not observed",
    base: "Not reported",
    branch: "Not observed",
    worktree: "Not observed",
    provider: "Not observed",
    model: "Not observed",
    started: null,
    elapsed: { kind: "none", text: "Not observed" },
    cost: null,
    attention: null,
    blocker:
      "This is Work's known accepted record for NEO-4838. No attempt has been observed and no process closure or execution is claimed.",
    next: "Open the Work sample to see the accepted request. This reference has no run action.",
    context: {
      objective:
        "Removing a worktree from the sidebar deletes uncommitted changes without a warning.",
      source: "Work sample issue NEO-4838 · accepted record A-2 at 11:02",
      acceptance: [],
      plan: "No plan sample is attached to this reference",
    },
    validation: [
      {
        cmd: "Host validation",
        status: "notrun",
        head: "not observed",
        note: "No execution was observed for this reference",
      },
    ],
    review: null,
    agents: [],
    timeline: [],
    action: "reference",
    history: false,
  };

  let state;

  /* Boot and rows ---------------------------------------------------- */
  function bootState() {
    const stored = S.load().state;
    const receipts = S.workReceipts();
    if (receipts.error) NK.toast(receipts.error);
    return {
      runs: NK.clone(F.runs),
      wf: "all",
      scope: stored.runsView.scope,
      filter: stored.runsView.filter,
      machine: stored.runsView.machine,
      q: "",
      selKey: null,
      detailOpen: false,
      shared: stored,
      receiptRead: receipts,
      requestTab: stored.runsView.requestTab || "summary",
      confirmRetry: false,
    };
  }

  function rowFromFixture(r) {
    return Object.assign({}, r, {
      key: "r:" + r.id,
      kind: "original",
      machine: NK.runMachine(r.id),
    });
  }

  function titleFromPlan(it) {
    if (it.issueTitle) return it.issueTitle;
    const first = String(it.planText || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (!first) return it.issueId + " demo request";
    return first.replace(/^goal:\s*/i, "").slice(0, 140);
  }

  function rowFromReceipt(receipt, it) {
    const requestState = S.receiptState(it);
    const machine = it.machine || "";
    return {
      key: S.receiptKey(receipt.id, it.issueId),
      kind: "request",
      id: it.issueId,
      title: titleFromPlan(it),
      workflow: it.workflow || "",
      machine: machine,
      status: requestState.status,
      statusText: requestState.text,
      stage: "intake",
      stages: {
        intake: "notrun",
        design: "notrun",
        build: "notrun",
        integrate: "notrun",
        review: "notrun",
        pr: "notrun",
      },
      attempt: 0,
      maxAttempts: 0,
      head: "not observed",
      base: it.base || "Not reported",
      branch: "Not created",
      worktree: "Not observed",
      provider: it.implementer || "Not reported",
      model: it.effort ? "Effort " + it.effort : "Not reported",
      started: null,
      elapsed: { kind: "none", text: "Not observed" },
      cost: null,
      attention:
        requestState.status === "unknown"
          ? {
              kind: "repeat",
              severity: "high",
              label:
                it.lifecycle === "closure_unknown" ? "Closure unknown" : "Acknowledgement unknown",
              summary:
                it.lifecycle === "closure_unknown"
                  ? "Accepted request " + receipt.id + " still has no confirmed closure"
                  : "Receipt " + receipt.id + " has no authoritative result",
            }
          : null,
      blocker:
        requestState.status === "queued"
          ? "Work accepted this request in the local demo. No agent has started and no attempt is observed."
          : requestState.status === "unknown"
            ? it.lifecycle === "closure_unknown"
              ? "Acceptance was confirmed. Closure is unknown, so this request stays reserved."
              : "Work has no authoritative admission answer for this request. Unknown is not refusal or closure."
            : requestState.status === "paused"
              ? "Withdrawal was requested in the local demo. A request is not closure, so the receipt stays reserved."
              : requestState.status === "cancelled"
                ? "This request is closed in the local demo. No execution is claimed."
                : "Work did not start this item. " +
                  (it.reason || "It stays listed as not started."),
      next:
        requestState.status === "queued"
          ? "Open the receipt detail in Work. Evidence stays Not run until a machine reports it."
          : "Open the receipt detail in Work to change the request or check its status.",
      context: {
        objective: titleFromPlan(it),
        source:
          "Work local demo receipt " +
          receipt.id +
          ", recorded at " +
          (receipt.at || "an unrecorded time") +
          " · " +
          S.WORK_RECEIPTS_KEY,
        acceptance: [],
        plan:
          "Plan r" +
          (it.planRev == null ? "not recorded" : it.planRev) +
          (it.decision ? ", decision: " + it.decision : "") +
          ". Pinned to this request, not to the sample attempt 3.",
      },
      validation: [],
      review: null,
      agents: [],
      timeline: [],
      action: "request",
      history: false,
      item: it,
      receipt: receipt,
    };
  }

  function requestRows() {
    if (!state.receiptRead || !state.receiptRead.receipts) return [];
    const seen = new Set();
    const rows = [];
    state.receiptRead.receipts
      .slice()
      .reverse()
      .forEach((receipt) => {
        receipt.items.forEach((it) => {
          const key = S.receiptKey(receipt.id, it.issueId);
          if (seen.has(key)) return;
          seen.add(key);
          rows.push(rowFromReceipt(receipt, it));
        });
      });
    return rows;
  }

  function allRows() {
    const originals = state.runs.map(rowFromFixture);
    const reference = Object.assign({}, REFERENCE, {
      key: "r:" + REFERENCE.id,
      kind: "reference",
      machine: "work",
    });
    return requestRows().concat(originals, [reference]);
  }
  const rowByKey = (key) => allRows().find((r) => r.key === key) || null;
  const domKey = (key) => String(key).replace(/[^A-Za-z0-9_-]/g, "-");

  function requestOf(row) {
    return (state.shared.requests && state.shared.requests[row.id]) || {};
  }
  const decisionOf = (id) => (state.shared.decisions && state.shared.decisions[id]) || {};
  const decSaved = () => decisionOf("D-3").saved || null;

  /* Projection ------------------------------------------------------- */
  function openAttention(r) {
    if (r.kind === "request") return !!r.attention;
    if (r.id === "NEO-4821" && r.attention && r.attention.kind === "decision" && decSaved())
      return false;
    return !!r.attention && !requestOf(r).attnResolved;
  }
  function resumeApprovalCtx() {
    const d = decSaved();
    return {
      itemId: "NEO-4821",
      attempt: 3,
      planRev: state.shared.plan.current,
      head: "7f3a9c2",
      machine: "mac",
      decisionAt: d ? d.at : "",
    };
  }
  function planCtx() {
    return {
      itemId: "NEO-4821",
      attempt: 3,
      planRev: state.shared.plan.current,
      head: "7f3a9c2",
      machine: "mac",
    };
  }
  function planApprovalProblem() {
    const a = state.shared.plan.approval;
    if (!a) return "No plan execution approval is recorded.";
    if (a.state !== "approved") return a.reason || "The plan execution approval was superseded.";
    return S.scopeProblem(a, planCtx());
  }
  function planLine(r) {
    if (r.id !== "NEO-4821") return r.context.plan;
    const problem = planApprovalProblem();
    return problem
      ? `Plan r${state.shared.plan.current}, not execution-approved: ${problem}`
      : `Plan r${state.shared.plan.current}, plan execution approval recorded for attempt 3; resume approval is separate`;
  }
  function resumeApprovalProblem() {
    const a = state.shared.resumeApproval;
    if (!a) return null;
    if (a.state !== "approved") return a.reason || "The resume approval was superseded.";
    return S.scopeProblem(a, resumeApprovalCtx());
  }
  function view(r) {
    if (r.kind === "request" || r.kind === "reference")
      return { status: r.status, text: r.statusText };
    const req = requestOf(r);
    if (r.id === "NEO-4821" && decSaved()) {
      if (req.resume) return { status: "paused", text: "Paused, resume requested" };
      if (state.shared.resumeApproval && !resumeApprovalProblem())
        return { status: "paused", text: "Paused, resume approved (demo)" };
      return { status: "paused", text: "Paused, decision saved" };
    }
    if (r.id === "NEO-4799" && req.resume)
      return { status: "paused", text: "Paused, resume requested" };
    if (r.id === "NEO-4776" && req.merge)
      return { status: "requested", text: "Merge approved, not merged" };
    if (r.id === "NEO-4785" && req.retry)
      return { status: "needs", text: "Retry requested (demo)" };
    if (r.id === "NEO-4790" && req.stop)
      return { status: "orphaned", text: "Tracking lost, stop requested" };
    return { status: r.status, text: r.statusText };
  }
  function stageStatus(r, k) {
    if (r.kind !== "original") return "notrun";
    const req = requestOf(r);
    if (r.id === "NEO-4821" && k === "build" && decSaved()) return "paused";
    if (r.id === "NEO-4776" && k === "pr" && req.merge) return "queued";
    return r.stages[k];
  }
  const ATTN_GLYPH = {
    decision: "needs",
    orphaned: "orphaned",
    repeat: "failed",
    merge: "needs",
  };
  const SEV = { critical: 0, high: 1, medium: 2, low: 3 };

  const FILTERS = [
    { id: "all", label: "All", test: () => true },
    { id: "needs", label: "Needs you", icon: "alert", test: (r) => openAttention(r) },
    { id: "running", label: "Running", icon: "ring", test: (r) => view(r).status === "running" },
    { id: "paused", label: "Paused", icon: "pause", test: (r) => view(r).status === "paused" },
    {
      id: "failed",
      label: "Failed",
      icon: "x",
      test: (r) => r.kind === "original" && r.status === "failed",
    },
    {
      id: "orphaned",
      label: "Tracking lost",
      icon: "orphan",
      test: (r) => r.kind === "original" && r.status === "orphaned",
    },
    {
      id: "queued",
      label: "Queued",
      icon: "circle",
      test: (r) => view(r).status === "queued",
    },
    {
      id: "accepted",
      label: "Accepted, not running",
      icon: "history",
      test: (r) => view(r).status === "accepted",
    },
  ];

  function inScope(r) {
    if (state.scope === "active") return !r.history;
    if (state.scope === "history") return !!r.history;
    return true;
  }
  function matchesQuery(r) {
    const q = state.q.trim().toLowerCase();
    if (!q) return true;
    return [
      r.id,
      r.title,
      r.branch,
      r.head,
      WF[r.workflow],
      NK.machineLabel(r.machine),
      r.machine,
      r.receipt ? r.receipt.id : "",
      r.receipt ? r.receipt.key : "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  }
  function preMachineSet() {
    return allRows().filter(
      (r) => (state.wf === "all" || r.workflow === state.wf) && inScope(r) && matchesQuery(r),
    );
  }
  function baseSet() {
    return preMachineSet().filter((r) => state.machine === "all" || r.machine === state.machine);
  }
  function visibleRuns() {
    const f = FILTERS.find((x) => x.id === state.filter) || FILTERS[0];
    return baseSet().filter(f.test);
  }

  function persistView() {
    const res = S.update((s) => {
      s.runsView.scope = state.scope;
      s.runsView.filter = state.filter;
      s.runsView.machine = state.machine;
      if (state.selKey) s.runsView.selectedKey = state.selKey;
    });
    state.shared = res.state;
  }

  /* Sidebar ---------------------------------------------------------- */
  function renderSidebar() {
    const items = [{ id: "all", name: "All workflows" }].concat(F.workflows);
    const rows = allRows();
    $("workflows").innerHTML = items
      .map((w) => {
        const rs = rows.filter((r) => !r.history && (w.id === "all" || r.workflow === w.id));
        const attn = rs.filter(openAttention).length;
        return `<button type="button" data-wf="${w.id}" aria-pressed="${state.wf === w.id}">
          <span>${esc(w.name)}</span>
          ${attn ? `<span class="attn-dot" title="${attn} need you"><span class="sr-only">, ${attn} need you,</span>${attn}</span>` : ""}
          <span class="n"><span class="sr-only">runs: </span>${rs.length}</span>
        </button>`;
      })
      .join("");
  }

  function renderChips() {
    const base = preMachineSet();
    $("chips").innerHTML = FILTERS.map((f) => {
      const n = base.filter(f.test).length;
      return `<button type="button" data-filter="${f.id}" aria-pressed="${state.filter === f.id}">
        ${f.icon ? icon(f.icon) : ""}${esc(f.label)} <span class="n">${n}</span></button>`;
    }).join("");
    document
      .querySelectorAll("[data-scope]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scope === state.scope)));
  }

  function renderMachines() {
    const base = preMachineSet();
    const parts = [
      `<button type="button" data-machine="all" aria-pressed="${state.machine === "all"}">All machines <span class="n">${base.length}</span></button>`,
    ];
    NK.MACHINE_ORDER.forEach((id) => {
      const n = base.filter((r) => r.machine === id).length;
      const m = NK.machine(id);
      parts.push(
        `<button type="button" data-machine="${id}" aria-pressed="${state.machine === id}" title="${esc(
          m.name + " (" + id + "), " + m.statusText,
        )}">${esc(m.name)} <span class="n">${n}</span><span class="nk-mid">${id}</span></button>`,
      );
    });
    $("machines").innerHTML =
      `<span class="label">Machine</span>` +
      parts.join("") +
      (state.machine !== "all"
        ? `<span class="r-machine-note">Filtered to ${esc(NK.machineLabel(state.machine))} (${esc(state.machine)}).</span>`
        : "");
  }

  /* Attention -------------------------------------------------------- */
  function resolvedList() {
    return state.runs
      .map((r) => {
        const res = requestOf(r).attnResolved;
        return res && r.attention
          ? { id: r.id, label: res.label || r.attention.label, at: res.at || "" }
          : null;
      })
      .filter(Boolean);
  }

  function renderAttention() {
    const items = allRows()
      .filter(openAttention)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "request" ? -1 : 1;
        return SEV[a.attention.severity] - SEV[b.attention.severity];
      });
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
            ) => `<li><button type="button" data-open="${esc(r.key)}" aria-current="${r.key === state.selKey}">
          ${glyph(ATTN_GLYPH[r.attention.kind] || "needs")}
          <span class="a-id">${r.id}${r.receipt ? ` <span class="faint" title="${esc(r.receipt.id)}">${esc(r.receipt.id.slice(0, 10))}</span>` : ""}</span>
          <span class="a-sum"><strong>${esc(r.attention.label)}</strong>${esc(r.attention.summary)}${r.receipt ? ` <span class="faint">This is a Work request, not attempt 3.</span>` : ""}</span>
          ${NK.machineChip(r.machine, "a-m")}
          <span class="a-wf">${esc(WF[r.workflow] || "Demo request")}</span></button></li>`,
          )
          .join("") +
        "</ul>";
    const resolved = resolvedList();
    if (resolved.length)
      html +=
        `<div class="r-resolved"><p class="label">Resolved in this demo</p>` +
        resolved
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
    if (r.kind !== "original")
      return `<span class="r-receipt" title="${esc(r.receipt ? r.receipt.id : "Reference")}">${icon("doc")}<span>${esc(
        r.receipt ? "Receipt " + r.receipt.id.slice(0, 10) : "Reference",
      )}</span></span>`;
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
  function rowSub(r) {
    if (r.kind === "request")
      return `${r.receipt.id}, recorded ${r.receipt.at || "at an unrecorded time"} · ${S.machineLabel(r.machine)} (${r.machine || "no id"})`;
    if (r.kind === "reference") return `Existing accepted record · Work PC (work) · not running`;
    const base = `${r.attempt ? `${F.STAGE_NAMES[r.stage]}, attempt ${r.attempt}` : "Not started"}${state.wf === "all" ? `, ${WF[r.workflow]}` : ""}`;
    return base;
  }
  function row(r) {
    const v = view(r);
    const sel = r.key === state.selKey;
    return `<div class="r-row kind-${r.kind}" role="option" id="opt-${domKey(r.key)}" data-key="${esc(r.key)}" aria-selected="${sel}" tabindex="${sel ? 0 : -1}">
      ${glyph(v.status)}
      <span class="r-id">${r.id}</span>
      <span class="r-title"><span class="t">${esc(r.title)}</span><span class="s">${esc(v.text)} <span class="faint">· ${esc(rowSub(r))}</span></span></span>
      <span class="r-ids">${strip(r)}${NK.machineChip(r.machine)}</span>
      <span class="r-when ${r.elapsed.kind === "orphaned" ? "orphaned" : ""}">${esc(r.elapsed.text.split(" · ")[0])}</span>
    </div>`;
  }
  function renderList() {
    const list = $("run-list");
    const hadFocus = list.contains(document.activeElement);
    const rs = visibleRuns();
    let html = "";
    if (state.receiptRead && state.receiptRead.error)
      html += `<p class="r-empty tone-attn">${esc(state.receiptRead.error)}</p>`;
    if (!rs.length) {
      html = `<p class="r-empty">No runs match. ${state.q ? `Clear the search “${esc(state.q)}” or ` : ""}choose another filter.</p>`;
    } else {
      const requests = rs.filter((r) => r.kind === "request");
      const active = rs.filter((r) => r.kind !== "request" && !r.history);
      const history = rs.filter((r) => r.kind !== "request" && r.history);
      const group = (label, rows) =>
        `<div role="group" aria-labelledby="g-${domKey(label)}"><div class="r-group-label"><span class="label" id="g-${domKey(label)}">${label}</span><span class="n">${rows.length}</span></div>${rows.map(row).join("")}</div>`;
      if (requests.length) html += group("Demo requests from Work", requests);
      if (active.length) html += group("Active", active);
      if (history.length) html += group("History", history);
    }
    list.innerHTML = html;
    if (!rs.some((r) => r.key === state.selKey)) {
      const first = list.querySelector(".r-row");
      if (first) first.tabIndex = 0;
    }
    if (hadFocus) {
      const target = $("opt-" + domKey(state.selKey)) || list.querySelector(".r-row");
      if (target) target.focus();
    }
  }

  /* Detail helpers --------------------------------------------------- */
  function machineScope(id) {
    return `${NK.machineChip(id)} <span class="faint">Immutable machine id <code>${esc(
      id || "none",
    )}</code>. Sample machine; no server is contacted.</span>`;
  }
  function resumeHint() {
    const a = state.shared.resumeApproval;
    if (!a)
      return "Execution approval is not recorded. Saving a decision does not approve a resume; approve the pinned scope in Plan and decisions.";
    const problem = resumeApprovalProblem();
    return problem
      ? `An earlier resume approval does not cover this attempt: ${esc(problem)}`
      : `Resume approved at ${a.at} for NEO-4821 attempt 3 on ${NK.machineLabel(a.machine)} (${a.machine}), plan r${a.rev}, head ${a.head}. This prototype still shows no execution.`;
  }
  function nextText(r) {
    if (r.id === "NEO-4821" && decSaved()) {
      if (requestOf(r).resume)
        return "Wait for the server to report package B running. Nothing in this prototype will report it.";
      if (state.shared.resumeApproval && !resumeApprovalProblem())
        return "Resume is approved for this exact attempt. No agent starts in the prototype; the run would change only from reported events.";
      return "Resume package B when you are ready. Resuming is its own request, separate from saving the decision and from execution approval.";
    }
    return r.next;
  }
  function nowClass(r) {
    if (openAttention(r) && r.attention.kind !== "orphaned" && r.attention.kind !== "repeat")
      return "attn";
    if (r.status === "orphaned") return "orphan";
    if (r.status === "failed" && !r.history) return "danger";
    return "";
  }
  function decisionEntry() {
    return decisionOf("D-3");
  }

  function actDecision(r) {
    const d = F.decision;
    const entry = decisionEntry();
    const saved = entry.saved || null;
    const machine = NK.machineLabel(r.machine);
    const scope = `NEO-4821, attempt ${r.attempt} on ${machine} (${r.machine}), head ${r.head}.`;
    if (!saved) {
      return `<div class="d-act">
        <p class="q" id="dq">${d.id}: ${esc(d.title)}</p>
        <p class="ctx">${esc(d.context)}</p>
        <p class="nk-scope-line" id="d3-scope">Applies to ${esc(scope)}</p>
        <div role="radiogroup" aria-labelledby="dq">
          ${d.options
            .map(
              (o) =>
                `<label class="choice"><input type="radio" name="d3" value="${o.id}" ${entry.draft === o.id ? "checked" : ""} />
              <span class="c-label">${esc(o.label)}${o.suggested ? ` <span class="suggested">Suggested by C2</span>` : ""}</span>
              <span class="c-detail">${esc(o.detail)}</span></label>`,
            )
            .join("")}
        </div>
        <label class="label" for="d3-note" style="display:block;margin-top:10px">Note for the record (optional)</label>
        <textarea id="d3-note" class="field" rows="2" style="margin-top:4px">${esc(entry.note || "")}</textarea>
        <div class="row">
          <button type="button" class="btn primary" data-act="save-decision" aria-disabled="${!entry.draft}" aria-describedby="d3-hint">Save decision</button>
          <span class="faint" id="d3-req">${entry.draft ? "" : "Choose an option first."}</span>
        </div>
        <p class="hint" id="d3-hint">Saving records your answer for this attempt on this machine. It does not resume package B, approve the plan, or merge anything.</p>
      </div>`;
    }
    const opt = d.options.find((o) => o.id === saved.option) || { label: saved.option };
    const approval = state.shared.resumeApproval;
    return `<div class="d-act">
      <div class="saved" id="act-focus" tabindex="-1">${icon("check")}<div><strong>Decision saved at ${esc(saved.at)}</strong> by ${esc(saved.by || "you")}<br />${esc(opt.label)}${
        saved.note ? `<br /><span class="muted">Note: ${esc(saved.note)}</span>` : ""
      }</div></div>
      <p class="nk-scope-line">Pinned to ${esc(scope)} Decision saved at ${esc(saved.at)}.</p>
      ${
        requestOf(r).resume
          ? `<p class="hint">Resume requested at ${esc(requestOf(r).resume.at)} for attempt ${requestOf(r).resume.attempt} on ${esc(NK.machineLabel(requestOf(r).resume.machine))} (${esc(requestOf(r).resume.machine)}). The run stays paused until the server reports package B running. This prototype has no server, so it will not change on its own.</p>
             <div class="row"><button type="button" class="btn" data-act="withdraw-resume">Withdraw resume request</button>
             <button type="button" class="btn ghost" data-act="reopen-decision">Reopen decision</button></div>`
          : `<div class="row"><button type="button" class="btn primary" data-act="resume">${icon("play")}Request resume of attempt ${r.attempt} on ${esc(machine)} (${esc(r.machine)})</button>
             <button type="button" class="btn ghost" data-act="reopen-decision">Reopen decision</button></div>
             <p class="hint">Saving the decision did not start any work. This requests a resume of attempt ${r.attempt} on ${esc(machine)}; it is not execution approval. ${resumeHint()}</p>
             ${approval && !resumeApprovalProblem() ? `<p class="hint"><a href="${S.itemHref("planning.html", { itemId: r.id, attempt: r.attempt }, "tab=decisions")}">Open the approval scope in Plan and decisions</a></p>` : ""}`
      }
    </div>`;
  }

  function actionScope(r) {
    return `attempt ${r.attempt} on ${NK.machineLabel(r.machine)} (${r.machine})`;
  }

  function actFor(r) {
    const req = requestOf(r);
    switch (r.action) {
      case "decide":
        return actDecision(r);
      case "paused":
        return req.resume
          ? `<div class="d-act"><p class="hint" id="act-focus" tabindex="-1">Resume requested at ${esc(req.resume.at)} for ${esc(actionScope(r))}. Still paused until the server reports the run running.</p>
             <div class="row"><button type="button" class="btn" data-act="withdraw-resume">Withdraw resume request</button></div></div>`
          : `<div class="d-act"><div class="row" style="margin-top:0"><button type="button" class="btn primary" data-act="resume">${icon("play")}Request resume of attempt ${r.attempt} on ${esc(NK.machineLabel(r.machine))} (${esc(r.machine)})</button></div>
             <p class="hint">Requests a resume of attempt ${r.attempt} on ${esc(NK.machineLabel(r.machine))} (${esc(r.machine)}). The base branch has moved since you paused.</p></div>`;
      case "stop":
        return req.stop
          ? `<div class="d-act"><p class="hint" id="act-focus" tabindex="-1" style="margin-top:0">Stop requested at ${esc(req.stop.at)} for ${esc(actionScope(r))}. Still shown as tracking lost: no exit has been observed, so elapsed time stays frozen at the last observation and cleanup stays blocked.</p>
             <div class="row"><button type="button" class="btn" data-act="withdraw-stop">Withdraw stop request</button></div></div>`
          : `<div class="d-act"><div class="row" style="margin-top:0"><button type="button" class="btn primary" data-act="stop">${icon("stop")}Request stop of attempt ${r.attempt} on ${esc(NK.machineLabel(r.machine))} (${esc(r.machine)})</button></div>
             <p class="hint">Addresses attempt ${r.attempt} on ${esc(NK.machineLabel(r.machine))} (${esc(r.machine)}). The run stays marked as tracking lost until the agent's exit is observed. Worktree cleanup stays blocked until then.</p></div>`;
      case "retry":
        if (req.retry)
          return `<div class="d-act"><p class="hint" id="act-focus" tabindex="-1" style="margin-top:0">Attempt ${r.attempt} requested at ${esc(req.retry.at)} on ${esc(NK.machineLabel(r.machine))} (${esc(r.machine)}). This stays in Needs you until the new attempt reports a result.</p>
             <div class="row"><button type="button" class="btn" data-act="withdraw-retry">Withdraw request</button></div></div>`;
        if (state.confirmRetry)
          return `<div class="d-act" id="act-focus" tabindex="-1"><p class="q">Retry as attempt ${r.attempt} on ${esc(NK.machineLabel(r.machine))} (${esc(r.machine)})?</p>
             <p class="ctx">It would start from <code>${r.base}</code> with the same workflow, on the same machine. Attempts 1 and 2 failed with the same ENOENT signature and nothing has changed since.</p>
             <div class="row"><button type="button" class="btn primary" data-act="retry">Request attempt ${r.attempt} on ${esc(NK.machineLabel(r.machine))}</button>
             <button type="button" class="btn ghost" data-act="cancel-retry">Cancel</button></div></div>`;
        return `<div class="d-act"><div class="row" style="margin-top:0"><button type="button" class="btn" data-act="confirm-retry">Review retry for attempt ${r.attempt} on ${esc(NK.machineLabel(r.machine))}</button></div></div>`;
      case "merge":
        return req.merge
          ? `<div class="d-act"><div class="saved" id="act-focus" tabindex="-1">${icon("check")}<div><strong>Merge approval recorded at ${esc(req.merge.at)}</strong> (demo) for attempt ${req.merge.attempt} on ${esc(NK.machineLabel(req.merge.machine))} (${esc(req.merge.machine)})<br />Not merged. Merging happens in GitHub under the workflow's merge policy.</div></div>
             <div class="row"><button type="button" class="btn ghost" data-act="withdraw-merge">Withdraw approval</button></div></div>`
          : `<div class="d-act"><ul class="checklist">
               <li>${glyph("passed")}CI passed on PR #1279 at <code>0b7d2f6</code></li>
               <li>${glyph("passed")}Review round 1 approved at <code>0b7d2f6</code></li>
               <li>${glyph("passed")}Validation head matches PR head</li>
               <li>${glyph("passed")}GitHub reports mergeable</li></ul>
             <p class="nk-scope-line">Scope: NEO-4776 attempt ${r.attempt} on ${esc(NK.machineLabel(r.machine))} (${esc(r.machine)}), head ${r.head}.</p>
             <div class="row"><button type="button" class="btn primary" data-act="merge">Record merge approval for attempt ${r.attempt} on ${esc(NK.machineLabel(r.machine))}</button></div>
             <p class="hint">Records your approval in this prototype only. Nothing is merged.</p></div>`;
      case "running":
        return `<div class="d-act"><p class="hint" style="margin-top:0">Elapsed time ticks in the product. This prototype shows a fixed start time and no live numbers. Running on ${esc(NK.machineLabel(r.machine))} (${esc(r.machine)}).</p></div>`;
      default:
        return "";
    }
  }

  function requestProviderLine(it) {
    const impl = it.implementer || "Implementer not recorded";
    const inst = it.instanceName || it.instance || "provider instance not recorded";
    const model = it.modelName || it.model || "model not recorded";
    const effort =
      it.effort ||
      (it.model && !it.effortRequired ? "no effort setting offered" : "effort not recorded");
    return `${impl} · ${inst} · ${model} · ${effort}`;
  }
  function requestReviewerLine(rv) {
    if (typeof rv === "string") return rv;
    const name = rv.name || rv.id || "Reviewer not recorded";
    const inst = rv.instance || "instance not recorded";
    const model = rv.model || "model not recorded";
    return `${name} · ${inst} · ${model} · ${rv.effort || "effort not recorded"}`;
  }
  function requestTabsHtml(r) {
    return `<div class="r-rtabs" role="tablist" aria-label="Request detail">
      ${S.REQUEST_TABS.map(
        (tab) =>
          `<button type="button" role="tab" id="rtab-${tab}" data-rtab="${tab}" aria-selected="${
            state.requestTab === tab
          }" aria-controls="r-request-panel" tabindex="${state.requestTab === tab ? 0 : -1}">${
            tab === "plan" ? "Plan" : tab.charAt(0).toUpperCase() + tab.slice(1)
          }</button>`,
      ).join("")}
    </div>`;
  }
  function requestSummary(r) {
    const it = r.item;
    return `<div class="d-now">
        <p class="k">Request state is not execution evidence</p>
        <p class="blocker">${esc(r.blocker)}</p>
        <p class="next"><strong>Next:</strong> ${esc(r.next)}</p>
      </div>
      <section class="d-sec"><h3>Receipt</h3>
        <dl class="kv">
          <dt>Receipt</dt><dd>${esc(r.receipt.id)}, recorded ${esc(r.receipt.at || "at an unrecorded time")}</dd>
          <dt>Request key</dt><dd><code>${esc(r.receipt.key || "not recorded")}</code></dd>
          <dt>Source</dt><dd><code>${esc(S.WORK_RECEIPTS_KEY)}</code> in this browser</dd>
          <dt>Result</dt><dd>${esc(it.result)}. ${esc(r.statusText)}</dd>
          <dt>Resolution</dt><dd>${
            it.resolution && it.resolution.outcome
              ? `${esc(it.resolution.outcome)} in Work${
                  it.resolution.at ? ` at ${esc(it.resolution.at)}` : ""
                } (local demo answer, not execution)`
              : "Not recorded"
          }</dd>
          <dt>Lifecycle</dt><dd>${esc(r.statusText)} <span class="faint">(local demo lifecycle, not execution)</span></dd>
          <dt>Machine</dt><dd>${machineScope(r.machine)}</dd>
          <dt>Issue</dt><dd>${esc(r.id)}. ${esc(WF[it.workflow] || it.workflow || "workflow not recorded")}</dd>
          <dt>Implementer</dt><dd>${esc(requestProviderLine(it))}</dd>
          <dt>Reviewers</dt><dd>${esc(
            (it.reviewers || []).map(requestReviewerLine).join("; ") || "Not recorded",
          )}</dd>
          <dt>Repository</dt><dd><code>${esc(it.repoPath || "Not recorded")}</code></dd>
          <dt>Base</dt><dd><code>${esc(it.base || "Not recorded")}</code></dd>
          <dt>Plan</dt><dd>r${it.planRev == null ? "not recorded" : it.planRev}${
            it.decision ? `, decision ${esc(it.decision)}` : ""
          }</dd>
        </dl>
      </section>`;
  }
  function requestExecution(r) {
    const it = r.item;
    const workflow = WF[it.workflow] || it.workflow || "Workflow not recorded";
    const queued = r.status === "queued";
    const nodes = F.STAGES.map(
      (stage, idx) => `<li class="${queued && idx === 0 ? "is-queued" : "is-planned"}">
        <span class="node" aria-hidden="true"></span>
        <span class="nm">${esc(F.STAGE_NAMES[stage])}</span>
        <span class="st">${queued && idx === 0 ? "Queued in the demo, not run" : "Not run"}</span>
      </li>`,
    ).join("");
    const gate = it.gate
      ? `<dl class="kv">
          <dt>Gate</dt><dd>${esc(it.gate.kind)} gate, ${esc(it.gate.status)}</dd>
          <dt>Held stage</dt><dd>${esc(F.STAGE_NAMES[it.gate.stage] || it.gate.stage || "Not recorded")}</dd>
          <dt>Question</dt><dd>${esc(it.gate.question || "Not recorded")}</dd>
          <dt>Answer</dt><dd>${
            it.gate.decision
              ? `${esc(it.gate.decisionLabel || it.gate.decision)}${
                  it.gate.decisionRev ? `, plan r${it.gate.decisionRev}` : ""
                }${it.gate.note ? `. ${esc(it.gate.note)}` : ""}`
              : "No saved answer"
          }</dd>
        </dl>`
      : `<p class="muted">No blocking or advisory gate was recorded for this request.</p>`;
    return `<p class="r-req-note">Planned from ${esc(workflow)}. No node has been observed and no agent has started.</p>
      <ol class="r-req-nodes" aria-label="Planned workflow nodes">${nodes}</ol>
      <div class="d-sec"><h3>Gate on ${esc(NK.machineLabel(r.machine))} (${esc(
        r.machine || "no id",
      )})</h3>${gate}</div>
      <div class="d-sec"><h3>Execution context</h3>
        <dl class="kv">
          <dt>Machine</dt><dd>${machineScope(r.machine)}</dd>
          <dt>Repository</dt><dd><code>${esc(it.repoPath || "Not recorded")}</code></dd>
          <dt>Base</dt><dd><code>${esc(it.base || "Not recorded")}</code></dd>
          <dt>Workflow</dt><dd>${esc(workflow)}</dd>
          <dt>Provider</dt><dd>${esc(requestProviderLine(it))}</dd>
          <dt>Evidence</dt><dd>Not run. Planned nodes are not execution evidence.</dd>
        </dl>
      </div>`;
  }
  function requestPlan(r) {
    const it = r.item;
    return `<section class="d-sec"><h3>Pinned plan r${
      it.planRev == null ? "not recorded" : it.planRev
    }</h3>
      <p class="r-req-note">This text was pinned when Work recorded the request. Later Plan and decisions edits do not rewrite it.</p>
      <pre class="r-req-plan">${esc(it.planText || "No plan text was recorded for this receipt.")}</pre>
    </section>
    <section class="d-sec"><h3>Saved answer and scope</h3>
      <dl class="kv">
        <dt>Machine</dt><dd>${machineScope(r.machine)}</dd>
        <dt>Request</dt><dd>${esc(r.id)} in ${esc(r.receipt.id)}, recorded ${esc(
          r.receipt.at || "at an unrecorded time",
        )}</dd>
        <dt>Plan</dt><dd>r${it.planRev == null ? "not recorded" : it.planRev}</dd>
        <dt>Decision</dt><dd>${esc(it.decision || "No saved decision recorded")}</dd>
        <dt>Gate answer</dt><dd>${
          it.gate && it.gate.decision
            ? `${esc(it.gate.decisionLabel || it.gate.decision)}${it.gate.decisionRev ? `, plan r${it.gate.decisionRev}` : ""}`
            : "No gate answer recorded"
        }</dd>
        <dt>Immutable</dt><dd>This request snapshot is not the existing sample attempt 3 and does not inherit its plan history.</dd>
      </dl>
    </section>`;
  }
  function requestEvidence(r) {
    const it = r.item;
    const checks = it.checks || [];
    return `<p class="r-req-note">Receipt ${esc(r.receipt.id)} is admission evidence only. Host validation, review and agent results remain Not run.</p>
      <section class="d-sec"><h3>Admission evidence</h3>
        <dl class="kv">
          <dt>Receipt</dt><dd>${esc(r.receipt.id)}, recorded ${esc(r.receipt.at || "at an unrecorded time")}</dd>
          <dt>Request key</dt><dd><code>${esc(r.receipt.key || "not recorded")}</code></dd>
          <dt>Result</dt><dd>${esc(it.result)}. ${esc(r.statusText)}</dd>
          <dt>Resolution</dt><dd>${
            it.resolution && it.resolution.outcome
              ? `${esc(it.resolution.outcome)} in Work${it.resolution.at ? ` at ${esc(it.resolution.at)}` : ""}`
              : "Not recorded"
          }</dd>
          <dt>Lifecycle</dt><dd>${esc(it.lifecycle || "Not recorded")}</dd>
          <dt>Receipt store</dt><dd><code>${esc(S.WORK_RECEIPTS_KEY)}</code></dd>
          <dt>Issue source</dt><dd>${it.source ? esc(`${it.source.connectionId} / ${it.source.scopeId}, revision ${it.source.scopeRevision}, fetched ${it.source.fetchedAt}, coverage ${it.source.loaded}/${it.source.total}`) : "Not recorded in this older receipt"}</dd>
        </dl>
      </section>
      <section class="d-sec"><h3>Validation on ${esc(NK.machineLabel(r.machine))} (${esc(
        r.machine || "no id",
      )})</h3>
        <p class="muted">Not run. No host check or review is recorded for this request.</p>
        <ul class="r-req-notrun"><li>${pill("notrun", "Host validation, not run")}</li><li>${pill(
          "notrun",
          "Implementer result, not run",
        )}</li><li>${pill("notrun", "Review, not run")}</li></ul>
        ${
          checks.length
            ? `<p class="label" style="margin-top:8px">Preview checks when recorded, not host evidence</p><ul class="checks">${checks
                .map(
                  (c) =>
                    `<li class="notrun"><span class="at">${icon("minus")}</span><span><span class="cmd">${esc(
                      c.text || "Sample check",
                    )}</span><span class="note">${esc(c.tone || "sample")} · not host evidence</span></span>${pill(
                      "notrun",
                    )}</li>`,
                )
                .join("")}</ul>`
            : ""
        }
      </section>
      <section class="d-sec"><h3>Request context</h3>
        <dl class="kv">
          <dt>Item</dt><dd>${esc(r.id)}</dd>
          <dt>Machine</dt><dd>${machineScope(r.machine)}</dd>
          <dt>Repository</dt><dd><code>${esc(it.repoPath || "Not recorded")}</code></dd>
          <dt>Base</dt><dd><code>${esc(it.base || "Not recorded")}</code></dd>
          <dt>Provider</dt><dd>${esc(requestProviderLine(it))}</dd>
          <dt>Attempt</dt><dd>No attempt observed for this request.</dd>
        </dl>
      </section>
      ${
        r.id === "NEO-4821"
          ? `<section class="d-sec"><h3>Existing sample attempt 3</h3><p>The original attempt 3 remains a separate row. This request has no attempt, head or observed stage, so it is never shown as attempt 3.</p><p style="margin-top:6px"><a href="runs.html?item=NEO-4821&attempt=3#NEO-4821">${icon(
              "history",
            )}Open the existing sample attempt 3</a></p></section>`
          : ""
      }`;
  }
  function requestTabBody(r) {
    if (state.requestTab === "execution") return requestExecution(r);
    if (state.requestTab === "plan") return requestPlan(r);
    if (state.requestTab === "evidence") return requestEvidence(r);
    return requestSummary(r);
  }

  function renderRequestDetail(r) {
    const receiptHref = `work.html#runs/${encodeURIComponent(
      r.receipt.id,
    )}/${encodeURIComponent(r.id)}`;
    $("detail").innerHTML = `
      <div class="d-head">
        <button type="button" class="btn ghost sm d-back" data-act="close-detail">${icon("chevronLeft")}Back to runs</button>
        <div class="d-meta"><span>${esc(r.id)}</span><span>Work demo request</span><span>Receipt ${esc(
          r.receipt.id,
        )}</span>${pill(view(r).status, view(r).text)}</div>
        <h2 id="detail-title">${esc(r.title)}</h2>
        <div class="d-meta d-machine-line">${NK.machineChip(r.machine)} <span class="faint">Immutable machine id <code>${esc(
          r.machine || "none",
        )}</code></span></div>
        ${requestTabsHtml(r)}
        <p class="d-note">${icon(
          "doc",
        )} This row comes from Work's local demo receipt. It is not the existing sample attempt 3, and no execution is observed.</p>
      </div>
      <div class="d-body" role="tabpanel" id="r-request-panel" aria-labelledby="rtab-${state.requestTab}">
        ${requestTabBody(r)}
        <p class="r-req-secondary"><a class="linkish" href="${receiptHref}">${icon(
          "list",
        )}Open the secondary receipt detail in Work</a></p>
      </div>`;
  }

  function renderReferenceDetail(r) {
    $("detail").innerHTML = `
      <div class="d-head">
        <button type="button" class="btn ghost sm d-back" data-act="close-detail">${icon("chevronLeft")}Back to runs</button>
        <div class="d-meta"><span>${r.id}</span><span>Existing accepted record</span>${pill(
          "accepted",
          "Accepted, not running",
        )}</div>
        <h2 id="detail-title">${esc(r.title)}</h2>
        <div class="d-meta d-machine-line">${NK.machineChip(r.machine)} <span class="faint">Immutable machine id <code>${esc(
          r.machine,
        )}</code></span></div>
      </div>
      <div class="d-body">
        <div class="d-now">
          <p class="k">Reference only</p>
          <p class="blocker">${esc(r.blocker)}</p>
          <p class="next"><strong>Next:</strong> ${esc(r.next)}</p>
          <div class="row" style="margin-top:10px"><a class="btn sm" href="work.html?issue=NEO-4838">${icon(
            "list",
          )}Open the Work sample</a></div>
        </div>
        <section class="d-sec"><h3>Source</h3>
          <dl class="kv">
            <dt>Source</dt><dd>${esc(r.context.source)}</dd>
            <dt>Recorded</dt><dd>11:02 (sample)</dd>
            <dt>Machine</dt><dd>${machineScope(r.machine)}</dd>
            <dt>State</dt><dd>Accepted, not running</dd>
            <dt>Attempt</dt><dd>Not started. No attempt was observed for this record.</dd>
            <dt>Execution</dt><dd>None observed. No process closure is claimed.</dd>
            <dt>Evidence</dt><dd>Not run</dd>
          </dl>
        </section>
        <section class="d-sec"><h3>Evidence on ${esc(NK.machineLabel(r.machine))} (${esc(
          r.machine,
        )})</h3><p class="muted">Not run. This reference carries no host check, review or agent result.</p></section>
        <section class="d-sec"><h3>Why it is separate</h3><p>Work reports this issue as already accepted on Work PC. Opening it here resolves the known sample record and its machine. It does not invent a queued request, an attempt, a head or an exit.</p></section>
      </div>`;
  }

  function renderOriginalDetail(r) {
    const v = view(r);
    const machine = NK.machineLabel(r.machine);
    const agents = r.agents.length
      ? `<section class="d-sec"><h3>Agents on ${esc(machine)} (${esc(r.machine)})</h3><ul class="tree">${r.agents
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
      ? `<section class="d-sec"><h3>Review on ${esc(machine)} (${esc(r.machine)})</h3>
          <p>${pill(r.review.status, r.review.verdict)} <span class="muted">Round ${r.review.round} of ${r.review.of} at <code>${r.review.head}</code>${r.review.head !== r.head ? ", an earlier head" : ""}</span></p>
          ${r.review.findings.length ? `<ul class="findings">${r.review.findings.map((f) => `<li><span class="sev">${esc(f.sev)}</span><span>${esc(f.text)}<span class="st">${esc(f.state)}</span></span></li>`).join("")}</ul>` : ""}
        </section>`
      : "";
    const validation = r.validation.length
      ? `<section class="d-sec"><h3>Validation on ${esc(machine)} (${esc(r.machine)})</h3><ul class="checks">${r.validation
          .map(
            (c) =>
              `<li class="${c.status}">${glyph(c.status)}<span><span class="cmd">${esc(c.cmd)}</span><span class="note">${esc(c.note)}</span></span><span class="at">${pill(c.status)}</span></li>`,
          )
          .join(
            "",
          )}</ul><p class="rule">Only a host check at the current head can pass. Agent reports, unknown and superseded results never show green.</p></section>`
      : "";

    $("detail").innerHTML = `
      <div class="d-head">
        <button type="button" class="btn ghost sm d-back" data-act="close-detail">${icon("chevronLeft")}Back to runs</button>
        <div class="d-meta"><span>${r.id}</span><span>${esc(WF[r.workflow])}</span>${pill(v.status, v.text)}</div>
        <h2 id="detail-title">${esc(r.title)}</h2>
        <div class="d-meta d-machine-line">${NK.machineChip(r.machine)} <span class="faint">Immutable machine id <code>${esc(
          r.machine,
        )}</code></span></div>
        ${NK.itemTabs(state.shared.selection, "summary")}
        <div class="d-links">
          <a href="${S.itemHref("workflow.html", { itemId: r.id, attempt: r.attempt })}">${icon("map")} Open in workflow map</a>
          ${r.id === "NEO-4821" ? `<a href="${S.itemHref("planning.html", { itemId: r.id, attempt: r.attempt })}">${icon("doc")} Open plan and decisions</a>` : ""}
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
          <p class="faint">${esc(r.context.source)}. ${esc(planLine(r))}.</p>
        </section>
        <section class="d-sec"><h3>Attempt and head</h3>
          <dl class="kv">
            <dt>Machine</dt><dd>${machineScope(r.machine)}</dd>
            <dt>Item</dt><dd>${r.id}, attempt ${r.attempt ? `${r.attempt} of ${r.maxAttempts}` : "not started"}</dd>
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
  }

  function renderDetail(focusAct) {
    const r = rowByKey(state.selKey);
    const el = $("detail");
    if (!r) {
      el.innerHTML = `<div class="d-body"><p class="r-empty">Select a run to see its blocker and next step.</p></div>`;
      return;
    }
    if (r.kind === "request") renderRequestDetail(r);
    else if (r.kind === "reference") renderReferenceDetail(r);
    else renderOriginalDetail(r);
    if (focusAct) {
      const f = $("act-focus") || el.querySelector(".d-act button");
      if (f) f.focus();
    }
  }

  function render(focusAct) {
    $("layout").dataset.detailOpen = String(state.detailOpen);
    renderSidebar();
    renderChips();
    renderMachines();
    renderAttention();
    renderList();
    renderDetail(focusAct);
  }

  /* Actions ---------------------------------------------------------- */
  function syncSelectionUrl(row) {
    if (!row) return;
    try {
      const href =
        row.kind === "request"
          ? S.requestHref(row.receipt.id, row.id, state.requestTab)
          : S.itemHref("runs.html", { itemId: row.id, attempt: row.attempt || 0 });
      history.replaceState(null, "", href);
    } catch (e) {
      /* file:// may refuse; shared storage still keeps the selection */
    }
  }
  function setSelection(row, open) {
    if (!row) return;
    if (row.key !== state.selKey) state.requestTab = "summary";
    state.selKey = row.key;
    if (open) state.detailOpen = true;
    const res = S.update((s) => {
      s.runsView.selectedKey = row.key;
      s.runsView.requestTab = state.requestTab;
      if (row.kind === "original" || row.kind === "reference")
        s.selection = {
          kind: row.kind === "reference" ? "reference" : "original",
          itemId: row.id,
          attempt: row.attempt || 0,
        };
    });
    state.shared = res.state;
    syncSelectionUrl(row);
    render();
    if (open && window.matchMedia("(max-width: 900px)").matches) $("detail").focus();
  }
  function setRequestTab(tab, focusTab) {
    if (S.REQUEST_TABS.indexOf(tab) < 0) return;
    state.requestTab = tab;
    const row = rowByKey(state.selKey);
    const res = S.update((s) => {
      s.runsView.requestTab = tab;
      if (row && row.kind === "request") s.runsView.selectedKey = row.key;
    });
    state.shared = res.state;
    syncSelectionUrl(row);
    render();
    const btn = $("rtab-" + tab);
    if (focusTab && btn) btn.focus();
  }
  function select(key, open) {
    setSelection(rowByKey(key), open);
  }
  function resolve(r, label) {
    const at = NK.nowText();
    const res = S.update((s) => {
      s.requests[r.id] = Object.assign({}, s.requests[r.id], {
        attnResolved: { at, label },
      });
    });
    state.shared = res.state;
  }
  function unresolve(r) {
    const res = S.update((s) => {
      const cur = Object.assign({}, s.requests[r.id]);
      delete cur.attnResolved;
      s.requests[r.id] = cur;
    });
    state.shared = res.state;
  }

  function reopenDecision() {
    const r = rowByKey("r:NEO-4821");
    const prev = decSaved();
    const at = NK.nowText();
    const res = S.update((s) => {
      const cur = Object.assign({}, s.decisions["D-3"]);
      cur.draft = prev ? prev.option : null;
      cur.note = prev ? prev.note : "";
      cur.saved = null;
      cur.history = (cur.history || []).concat({
        at,
        by: "You",
        text: prev ? `Reopened. Previous answer kept: ${prev.option}.` : "Reopened.",
      });
      s.decisions["D-3"] = cur;
      const req = Object.assign({}, s.requests["NEO-4821"]);
      delete req.resume;
      s.requests["NEO-4821"] = req;
      if (s.resumeApproval)
        s.resumeApproval = Object.assign({}, s.resumeApproval, {
          state: "superseded",
          reason: `D-3 reopened at ${at}`,
        });
    });
    state.shared = res.state;
    unresolve(r);
    NK.toast(
      "Decision reopened. Your previous answer is kept as a draft and package B is still paused.",
    );
  }

  const ACTIONS = {
    "save-decision"() {
      const entry = decisionEntry();
      if (!entry.draft) {
        NK.toast("Choose an option before saving.");
        const first = document.querySelector('input[name="d3"]');
        if (first) first.focus();
        return false;
      }
      const at = NK.nowText();
      const res = S.update((s) => {
        const cur = Object.assign({}, s.decisions["D-3"]);
        cur.saved = { option: cur.draft, note: (cur.note || "").trim(), at, by: "You" };
        cur.draft = null;
        cur.history = (cur.history || []).concat({
          at,
          by: "You",
          text: `Saved: ${cur.saved.option}.`,
        });
        s.decisions["D-3"] = cur;
      });
      state.shared = res.state;
      resolve(rowByKey("r:NEO-4821"), "D-3 decision saved");
      NK.toast("Decision saved. Package B is still paused; nothing has resumed.");
    },
    "reopen-decision": reopenDecision,
    resume(r) {
      const at = NK.nowText();
      const res = S.update((s) => {
        s.requests[r.id] = Object.assign({}, s.requests[r.id], {
          resume: {
            at,
            itemId: r.id,
            attempt: r.attempt,
            machine: r.machine,
            planRev: s.plan.current,
            head: r.head,
            decisionAt: decSaved() ? decSaved().at : "",
          },
        });
      });
      state.shared = res.state;
      NK.toast(
        `Resume requested (demo) for attempt ${r.attempt} on ${NK.machineLabel(r.machine)}. The run stays paused until the server reports it running.`,
      );
    },
    "withdraw-resume"(r) {
      const res = S.update((s) => {
        const cur = Object.assign({}, s.requests[r.id]);
        delete cur.resume;
        s.requests[r.id] = cur;
      });
      state.shared = res.state;
      NK.toast("Resume request withdrawn.");
    },
    stop(r) {
      const at = NK.nowText();
      const res = S.update((s) => {
        s.requests[r.id] = Object.assign({}, s.requests[r.id], {
          stop: { at, itemId: r.id, attempt: r.attempt, machine: r.machine, head: r.head },
        });
      });
      state.shared = res.state;
      NK.toast(
        `Stop requested (demo) for attempt ${r.attempt} on ${NK.machineLabel(r.machine)}. Still tracking lost until an exit is observed.`,
      );
    },
    "withdraw-stop"(r) {
      const res = S.update((s) => {
        const cur = Object.assign({}, s.requests[r.id]);
        delete cur.stop;
        s.requests[r.id] = cur;
      });
      state.shared = res.state;
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
      const at = NK.nowText();
      const res = S.update((s) => {
        s.requests[r.id] = Object.assign({}, s.requests[r.id], {
          retry: { at, itemId: r.id, attempt: r.attempt, machine: r.machine, head: r.head },
        });
      });
      state.shared = res.state;
      NK.toast(
        `Attempt ${r.attempt} requested (demo) on ${NK.machineLabel(r.machine)}. Still listed under Needs you.`,
      );
    },
    "withdraw-retry"(r) {
      const res = S.update((s) => {
        const cur = Object.assign({}, s.requests[r.id]);
        delete cur.retry;
        s.requests[r.id] = cur;
      });
      state.shared = res.state;
      NK.toast("Retry request withdrawn.");
    },
    merge(r) {
      const at = NK.nowText();
      const res = S.update((s) => {
        s.requests[r.id] = Object.assign({}, s.requests[r.id], {
          merge: { at, itemId: r.id, attempt: r.attempt, machine: r.machine, head: r.head },
        });
      });
      state.shared = res.state;
      resolve(r, "Merge approval recorded");
      NK.toast(
        `Merge approval recorded (demo) for attempt ${r.attempt} on ${NK.machineLabel(r.machine)}. Nothing was merged.`,
      );
    },
    "withdraw-merge"(r) {
      const res = S.update((s) => {
        const cur = Object.assign({}, s.requests[r.id]);
        delete cur.merge;
        s.requests[r.id] = cur;
      });
      state.shared = res.state;
      unresolve(r);
      NK.toast("Merge approval withdrawn. Back in Needs you.");
    },
    "close-detail"() {
      state.detailOpen = false;
      render();
      const rowEl = $("opt-" + domKey(state.selKey));
      if (rowEl) rowEl.focus();
      return false;
    },
  };

  /* Events ----------------------------------------------------------- */
  function onClick(e) {
    const t = e.target.closest(
      "[data-act],[data-open],[data-reopen],[data-wf],[data-scope],[data-filter],[data-machine],[data-rtab],.r-row",
    );
    if (!t) return;
    if (t.dataset.rtab) return setRequestTab(t.dataset.rtab, true);
    if (t.dataset.act) {
      if (t.dataset.act !== "close-detail" && t.getAttribute("aria-disabled") === "true") {
        ACTIONS[t.dataset.act](rowByKey(state.selKey));
        return;
      }
      const res = ACTIONS[t.dataset.act](rowByKey(state.selKey));
      if (res !== false) render(true);
      return;
    }
    if (t.dataset.open) return select(t.dataset.open, true);
    if (t.dataset.reopen) {
      if (t.dataset.reopen === "NEO-4821") reopenDecision();
      else ACTIONS["withdraw-merge"](rowByKey("r:" + t.dataset.reopen));
      render();
      return;
    }
    if (t.dataset.wf) {
      state.wf = t.dataset.wf;
      persistView();
      return render();
    }
    if (t.dataset.scope) {
      state.scope = t.dataset.scope;
      persistView();
      return render();
    }
    if (t.dataset.filter) {
      state.filter = t.dataset.filter;
      persistView();
      return render();
    }
    if (t.dataset.machine) {
      state.machine = t.dataset.machine;
      persistView();
      return render();
    }
    if (t.classList.contains("r-row")) {
      t.focus();
      return select(t.dataset.key, true);
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
      return select(rows[i].dataset.key, true);
    }
    if (n >= 0) {
      e.preventDefault();
      select(rows[n].dataset.key, false);
      $("opt-" + domKey(state.selKey)).focus();
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

  function initialSelection(stored) {
    const qp = new URLSearchParams(location.search);
    const receipt = qp.get("receipt");
    if (receipt) {
      const issue = qp.get("issue");
      const key = S.receiptKey(receipt, issue);
      if (rowByKey(key)) return key;
    }
    const qItem = qp.get("item");
    if (qItem && rowByKey("r:" + qItem)) return "r:" + qItem;
    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash && rowByKey("r:" + fromHash)) return "r:" + fromHash;
    if (stored.runsView.selectedKey && rowByKey(stored.runsView.selectedKey))
      return stored.runsView.selectedKey;
    const sel = stored.selection;
    if (sel && (sel.kind === "original" || sel.kind === "reference")) {
      const rows = allRows();
      const match = rows.find(
        (r) => r.id === sel.itemId && r.kind === sel.kind && (r.attempt || 0) === sel.attempt,
      );
      if (match) return match.key;
    }
    return "r:NEO-4821";
  }

  NK.onReady(() => {
    state = bootState();
    state.selKey = initialSelection(state.shared);
    const row = rowByKey(state.selKey);
    const qp = new URLSearchParams(location.search);
    if (row && row.kind === "request") {
      const qTab = qp.get("tab");
      if (S.REQUEST_TABS.indexOf(qTab) >= 0) state.requestTab = qTab;
      state.detailOpen = true;
      const res = S.update((s) => {
        s.runsView.selectedKey = row.key;
        s.runsView.requestTab = state.requestTab;
      });
      state.shared = res.state;
      syncSelectionUrl(row);
    }
    if (row && row.kind !== "request") {
      const res = S.update((s) => {
        s.selection = {
          kind: row.kind === "reference" ? "reference" : "original",
          itemId: row.id,
          attempt: row.attempt || 0,
        };
        s.runsView.selectedKey = row.key;
      });
      state.shared = res.state;
      syncSelectionUrl(row);
    }
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onGlobalKey);
    $("run-list").addEventListener("keydown", onListKey);
    $("search").addEventListener("input", (e) => {
      state.q = e.target.value;
      render();
    });
    $("detail").addEventListener("change", (e) => {
      if (e.target.name === "d3") {
        const res = S.update((s) => {
          const cur = Object.assign({}, s.decisions["D-3"]);
          cur.draft = e.target.value;
          s.decisions["D-3"] = cur;
        });
        state.shared = res.state;
        const btn = document.querySelector('[data-act="save-decision"]');
        if (btn) btn.setAttribute("aria-disabled", "false");
        const req = $("d3-req");
        if (req) req.textContent = "";
      }
    });
    $("detail").addEventListener("input", (e) => {
      if (e.target.id === "d3-note") {
        const res = S.update((s) => {
          const cur = Object.assign({}, s.decisions["D-3"]);
          cur.note = e.target.value;
          s.decisions["D-3"] = cur;
        });
        state.shared = res.state;
      }
    });
    $("detail").addEventListener("keydown", (e) => {
      const tab = e.target.closest("[data-rtab]");
      if (!tab) return;
      const idx = S.REQUEST_TABS.indexOf(tab.dataset.rtab);
      let next = null;
      if (e.key === "ArrowRight") next = S.REQUEST_TABS[(idx + 1) % S.REQUEST_TABS.length];
      else if (e.key === "ArrowLeft")
        next = S.REQUEST_TABS[(idx + S.REQUEST_TABS.length - 1) % S.REQUEST_TABS.length];
      else if (e.key === "Home") next = S.REQUEST_TABS[0];
      else if (e.key === "End") next = S.REQUEST_TABS[S.REQUEST_TABS.length - 1];
      if (next) {
        e.preventDefault();
        setRequestTab(next, true);
      }
    });
    $("reset-demo").addEventListener("click", () => {
      S.reset();
      state = bootState();
      state.selKey = "r:NEO-4821";
      syncSelectionUrl(rowByKey(state.selKey));
      $("search").value = "";
      render();
      NK.toast("Runs demo state reset. Work's saved demo receipts are unchanged.");
    });
    S.subscribe((shared) => {
      const prev = state.shared.selection || {};
      state.shared = shared;
      const next = shared.selection || {};
      if (
        next.itemId &&
        (prev.kind !== next.kind ||
          prev.itemId !== next.itemId ||
          Number(prev.attempt) !== Number(next.attempt))
      ) {
        const key = "r:" + next.itemId;
        if (rowByKey(key)) {
          state.selKey = key;
          state.detailOpen = false;
        }
      }
      render();
    });
    window.addEventListener("storage", (e) => {
      if (e.key === S.WORK_RECEIPTS_KEY || e.key === null) {
        state.receiptRead = S.workReceipts();
        if (state.receiptRead.error) NK.toast(state.receiptRead.error);
        if (!rowByKey(state.selKey)) state.selKey = "r:NEO-4821";
        render();
      }
    });
    render();
  });
})();
