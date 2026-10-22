/* Work: select issues, assign machines and agents, preview, start a local demo.
   Static prototype. No tracker, machine, agent or network call. Local state only lives under
   localStorage keys prefixed neokod-symphony-proto:work: and holds no tokens. */
(function () {
  "use strict";

  const D = window.NK_WORK;
  const { icon, esc, toast } = NK;
  const $ = (id) => document.getElementById(id);

  const PREFIX = "neokod-symphony-proto:work:";
  const KEY = {
    draft: PREFIX + "draft",
    plans: PREFIX + "plans",
    receipts: PREFIX + "receipts",
  };
  const SHARED_ID = "NEO-4821";
  const ISSUE_IDS = D.issues.map((i) => i.id);
  const NARROW = "(max-width: 860px)";
  const MACHINE_ICON =
    '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>';

  let state;

  /* Small helpers ------------------------------------------------------ */
  const issueById = (id) => D.issues.find((i) => i.id === id) || null;
  const machineById = (id) => D.machines.find((m) => m.id === id) || null;
  const agent = (id) => D.agents[id];
  const wf = (id) => D.workflows[id];
  const narrow = () => window.matchMedia(NARROW).matches;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const nowText = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const listText = (xs) =>
    xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function lpill(tone, ico, text) {
    return `<span class="pill tone-${tone}">${icon(ico)}<span>${esc(text)}</span></span>`;
  }

  function mchip(mid) {
    const m = machineById(mid);
    if (!m)
      return `<span class="wk-mchip is-off">${MACHINE_ICON}<span>Unknown machine</span></span>`;
    const off = m.status !== "connected";
    return `<span class="wk-mchip${off ? " is-off" : ""}">${MACHINE_ICON}<span>${esc(m.name)}</span>${
      off ? '<span class="wk-mchip-st">offline</span>' : ""
    }</span>`;
  }

  const CHECK = {
    ok: ["check", "tone-neutral", "Matches sample facts"],
    block: ["x", "tone-danger", "Blocks start"],
    warn: ["alert", "tone-attn", "Warning"],
    info: ["dot", "tone-quiet", "Note"],
    unknown: ["unknown", "tone-quiet", "Unknown"],
  };
  function checkLine(c) {
    const k = CHECK[c.tone] || CHECK.info;
    return `<li class="wk-check is-${esc(c.tone)}"><span class="glyph ${k[1]}">${icon(
      k[0],
    )}</span><span><span class="sr-only">${k[2]}: </span>${esc(c.text)}</span></li>`;
  }

  /* Storage: one namespace, JSON only, validated on read ------------- */
  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }
  function clearNamespace() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch (e) {
      /* storage unavailable: in-memory reset still applies */
    }
  }

  /* Draft: selection and assignments ---------------------------------- */
  function emptyDraft() {
    return {
      revision: 0,
      selected: [],
      defaults: { machine: D.defaults.machine, implementer: D.team.implementer },
      overrides: {},
    };
  }

  function sanitizeDraft(raw) {
    const d = emptyDraft();
    if (!raw || typeof raw !== "object") return d;
    if (Number.isInteger(raw.revision) && raw.revision >= 0) d.revision = raw.revision;
    if (raw.defaults && machineById(raw.defaults.machine))
      d.defaults.machine = raw.defaults.machine;
    if (raw.defaults && agent(raw.defaults.implementer))
      d.defaults.implementer = raw.defaults.implementer;
    if (Array.isArray(raw.selected))
      d.selected = ISSUE_IDS.filter((id) => raw.selected.includes(id));
    if (raw.overrides && typeof raw.overrides === "object") {
      d.selected.forEach((id) => {
        const o = raw.overrides[id];
        if (!o || typeof o !== "object") return;
        const c = {};
        if (machineById(o.machine)) c.machine = o.machine;
        if (agent(o.implementer)) c.implementer = o.implementer;
        if (c.machine || c.implementer) d.overrides[id] = c;
      });
    }
    return d;
  }

  function canonical(d) {
    return JSON.stringify({
      s: ISSUE_IDS.filter((id) => d.selected.includes(id)),
      d: [d.defaults.machine, d.defaults.implementer],
      o: ISSUE_IDS.filter((id) => d.overrides[id]).map((id) => [
        id,
        d.overrides[id].machine || "",
        d.overrides[id].implementer || "",
      ]),
    });
  }

  const orderedSelected = () => ISSUE_IDS.filter((id) => state.draft.selected.includes(id));
  const isSelected = (id) => state.draft.selected.includes(id);

  function changeDraft(fn) {
    fn(state.draft);
    state.draft.revision += 1;
  }

  function dropFromDraft(d, ids) {
    d.selected = d.selected.filter((x) => !ids.includes(x));
    ids.forEach((x) => delete d.overrides[x]);
  }

  function draftStatus() {
    const cur = canonical(state.draft);
    if (state.savedJson == null) {
      return cur === canonical(emptyDraft())
        ? { dirty: false, text: "No saved draft" }
        : { dirty: true, text: "Draft not saved" };
    }
    return cur === state.savedJson
      ? { dirty: false, text: `Draft saved ${state.savedAt || ""}`.trim() }
      : { dirty: true, text: "Unsaved changes" };
  }

  function saveDraft() {
    const at = nowText();
    const d = state.draft;
    const body = {
      v: 1,
      revision: d.revision,
      selected: orderedSelected(),
      defaults: { machine: d.defaults.machine, implementer: d.defaults.implementer },
      overrides: JSON.parse(JSON.stringify(d.overrides)),
      savedAt: at,
    };
    if (!writeJson(KEY.draft, body)) {
      toast("This browser blocked local storage. The draft lasts until you reload.");
      return;
    }
    state.savedJson = canonical(d);
    state.savedAt = at;
    toast(`Draft saved at ${at}. Saving does not start anything.`);
  }

  // Accepted work leaves the stored draft too, so a reload cannot reselect it.
  function patchSavedDraft(ids) {
    const raw = readJson(KEY.draft);
    if (!raw) return;
    const d = sanitizeDraft(raw);
    dropFromDraft(d, ids);
    writeJson(KEY.draft, {
      v: 1,
      revision: d.revision,
      selected: d.selected,
      defaults: d.defaults,
      overrides: d.overrides,
      savedAt: typeof raw.savedAt === "string" ? raw.savedAt : null,
    });
    state.savedJson = canonical(d);
  }

  function assignment(id) {
    const o = state.draft.overrides[id] || {};
    return {
      machine: o.machine || state.draft.defaults.machine,
      implementer: o.implementer || state.draft.defaults.implementer,
      machineOverridden: !!o.machine,
      implementerOverridden: !!o.implementer,
    };
  }

  /* Plans and decisions: separate local state, never a launch ------- */
  function sanitizePlans(raw) {
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    ISSUE_IDS.forEach((id) => {
      const p = raw[id];
      if (!p || typeof p !== "object") return;
      const e = {};
      if (Number.isInteger(p.rev) && p.rev >= 1 && typeof p.text === "string") {
        e.rev = p.rev;
        e.text = p.text.slice(0, 20000);
        e.savedAt = typeof p.savedAt === "string" ? p.savedAt : null;
      }
      const q = issueById(id).question;
      const dec = p.decision;
      if (q && dec && q.options.some((o) => o.id === dec.option)) {
        e.decision = {
          option: dec.option,
          savedAt: typeof dec.savedAt === "string" ? dec.savedAt : "",
          rev: Number.isInteger(dec.rev) && dec.rev >= 1 ? dec.rev : 1,
        };
      }
      if (e.rev || e.decision) out[id] = e;
    });
    return out;
  }

  function planOf(id) {
    const s = state.plans[id];
    if (s && s.rev) return { rev: s.rev, text: s.text, savedAt: s.savedAt };
    return { rev: 1, text: issueById(id).plan, savedAt: null };
  }
  const decisionOf = (id) => (state.plans[id] && state.plans[id].decision) || null;
  const pinKey = (id) => `p${planOf(id).rev}/d${decisionOf(id) ? decisionOf(id).rev : 0}`;
  const optionLabel = (issue, opt) => {
    const o = issue.question && issue.question.options.find((x) => x.id === opt);
    return o ? o.label : "Unknown option";
  };
  const previewHolds = (id) =>
    !!(state.preview && !state.preview.receiptId && state.preview.pins[id]);

  function persistPlans() {
    if (!writeJson(KEY.plans, state.plans))
      toast("This browser blocked local storage. The plan lasts until you reload.");
  }

  function savePlan(id) {
    const text = state.planEdits[id];
    const cur = planOf(id);
    if (text == null || text === cur.text) return;
    const stale = previewHolds(id);
    state.plans[id] = Object.assign({}, state.plans[id], {
      rev: cur.rev + 1,
      text: text,
      savedAt: nowText(),
    });
    delete state.planEdits[id];
    persistPlans();
    toast(
      `Plan r${cur.rev + 1} saved for ${id}. Nothing started.` +
        (stale ? " The preview is now out of date." : ""),
    );
  }

  function saveDecision(id) {
    const opt = state.decisionEdits[id];
    const prev = decisionOf(id);
    if (!opt || (prev && prev.option === opt)) return;
    const stale = previewHolds(id);
    state.plans[id] = Object.assign({}, state.plans[id], {
      decision: { option: opt, savedAt: nowText(), rev: (prev ? prev.rev : 0) + 1 },
    });
    delete state.decisionEdits[id];
    persistPlans();
    toast(
      `Decision saved for ${id}. Saving does not start, resume or approve work.` +
        (stale ? " The preview is now out of date." : ""),
    );
  }

  /* Receipts --------------------------------------------------------- */
  function sanitizeReceipts(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    raw.forEach((r) => {
      if (!r || typeof r.id !== "string" || typeof r.key !== "string" || !Array.isArray(r.items))
        return;
      const items = r.items
        .filter(
          (it) =>
            it &&
            issueById(it.issueId) &&
            machineById(it.machine) &&
            agent(it.implementer) &&
            (it.result === "accepted" || it.result === "blocked"),
        )
        .map((it) => ({
          issueId: it.issueId,
          result: it.result,
          reason: typeof it.reason === "string" ? it.reason : null,
          machine: it.machine,
          machineOverridden: !!it.machineOverridden,
          implementer: it.implementer,
          implementerOverridden: !!it.implementerOverridden,
          effort: String(it.effort || ""),
          reviewers: Array.isArray(it.reviewers)
            ? it.reviewers.filter((x) => x && agent(x.id))
            : [],
          workflow: wf(it.workflow) ? it.workflow : issueById(it.issueId).workflow,
          base: String(it.base || ""),
          repoPath: String(it.repoPath || ""),
          planRev: Number.isInteger(it.planRev) ? it.planRev : 1,
          planText: typeof it.planText === "string" ? it.planText : "",
          decision: typeof it.decision === "string" ? it.decision : null,
          checks: Array.isArray(it.checks)
            ? it.checks.filter((c) => c && typeof c.text === "string")
            : [],
        }));
      if (items.length) out.push({ id: r.id, key: r.key, at: String(r.at || ""), items });
    });
    return out;
  }

  function acceptedItem(id) {
    for (const r of state.receipts)
      for (const it of r.items)
        if (it.issueId === id && it.result === "accepted") return { receipt: r, item: it };
    return null;
  }
  const acceptedCount = () =>
    state.receipts.reduce((n, r) => n + r.items.filter((i) => i.result === "accepted").length, 0);

  /* Assessment: simulated checks against sample machine facts -------- */
  function effortText(m, agentId) {
    if (!m || m.status !== "connected") return "unknown while offline";
    const cap = m.agents[agentId];
    if (!cap) return "not available";
    return cap.efforts.indexOf("high") >= 0
      ? "high"
      : "provider default (no effort setting offered)";
  }

  // Connected machines that have this implementer and every project reviewer.
  const compatible = (implementer) =>
    D.machines.filter(
      (m) =>
        m.status === "connected" &&
        m.agents[implementer] &&
        D.team.reviewers.every((r) => m.agents[r]),
    );

  function assess(id) {
    const issue = issueById(id);
    const a = assignment(id);
    const m = machineById(a.machine);
    const impl = agent(a.implementer);
    const online = m.status === "connected";
    const checks = [];
    let block = null;
    let blockText = null;
    const add = (tone, text, short) => {
      checks.push({ tone, text });
      if (tone === "block" && !block) {
        block = short || text;
        blockText = text;
      }
    };
    const alt = compatible(a.implementer).filter((x) => x.id !== a.machine)[0] || null;

    if (online) add("ok", `${m.name} is connected. Sample status, last checked ${m.checked}.`);
    else
      add(
        "block",
        `${m.name} is offline. ${m.problem}` +
          (alt ? ` Choose a connected machine such as ${alt.name}.` : ""),
        `${m.name} is offline`,
      );

    if (online) add("ok", `Repository found at ${m.repo.path}, base ${m.repo.base}.`);
    else
      add(
        "unknown",
        `Repository last seen at ${m.repo.path}. It cannot be checked while ${m.name} is offline.`,
      );

    if (!online) {
      add(
        "unknown",
        `Agents cannot be checked while ${m.name} is offline. Last known: ${m.lastKnown}.`,
      );
    } else if (!m.agents[a.implementer]) {
      add(
        "block",
        [
          `${m.name} has no ${impl.name}.`,
          m.missing[a.implementer] || "",
          alt
            ? `Run it on ${alt.name}, which has ${impl.name}, or choose another implementer yourself.`
            : "Choose another implementer yourself.",
        ]
          .filter(Boolean)
          .join(" "),
        `No ${impl.name} on ${m.name}`,
      );
    } else {
      add(
        "ok",
        `Implementer ${impl.name} through ${impl.via} is available on ${m.name}. Effort: ${effortText(
          m,
          a.implementer,
        )}.`,
      );
    }

    if (online) {
      const missing = D.team.reviewers.filter((r) => !m.agents[r]);
      if (missing.length)
        add(
          "block",
          `${m.name} is missing reviewer ${listText(missing.map((r) => agent(r).name))}.`,
          `Reviewer missing on ${m.name}`,
        );
      else
        add(
          "ok",
          `Reviewers ${listText(D.team.reviewers.map((r) => agent(r).name))} are available on ${
            m.name
          }, the same machine as the implementer.`,
        );
    }

    if (a.implementer !== D.team.implementer)
      add(
        "info",
        `You chose ${impl.name} instead of the project default, ${
          agent(D.team.implementer).name
        }. Neokod never swaps agents on its own.`,
      );
    if (D.team.reviewers.indexOf(a.implementer) >= 0)
      add("warn", `${impl.name} is also a reviewer, so its review is less independent.`);

    if (issue.existing) add("block", issue.existing.text, issue.existing.short);
    const acc = acceptedItem(id);
    if (acc)
      add(
        "block",
        `Already queued in demo receipt ${acc.receipt.id} on ${machineById(acc.item.machine).name}.`,
        "Already queued in this demo",
      );
    if (issue.shared)
      add(
        "warn",
        "Prototype limit: the existing example attempt 3 on the Runs, Workflow map and Plan and decisions pages is not checked here. In the product, an active attempt would block a second start for this issue.",
      );

    if (!issue.acceptance.length)
      add(
        "warn",
        "The issue has no acceptance criteria. Reviewers will check against the description only.",
      );
    const p = planOf(id);
    add(
      "info",
      p.savedAt ? `Plan r${p.rev}, saved ${p.savedAt}.` : `Plan r${p.rev}, drafted from the issue.`,
    );
    const d = decisionOf(id);
    if (issue.question)
      add(
        d ? "info" : "warn",
        d
          ? `Decision saved: ${optionLabel(issue, d.option)}.`
          : `Open question not decided yet: ${issue.question.title}`,
      );
    if (state.planEdits[id] != null && state.planEdits[id] !== p.text)
      add("warn", "Unsaved plan edits are not included. Save the plan to include them.");
    if (issue.prefers && issue.prefers.machine !== a.machine) add("info", issue.prefers.text);

    const fix =
      block && !issue.existing && !acc && alt && (!online || !m.agents[a.implementer])
        ? { machine: alt.id, label: `Run on ${alt.name}` }
        : null;
    return { ready: !block, block, blockText, fix, checks, a, m, impl };
  }

  /* Preview and Start ------------------------------------------------- */
  function buildPreview() {
    const pins = {};
    const items = orderedSelected().map((id) => {
      pins[id] = pinKey(id);
      const r = assess(id);
      const p = planOf(id);
      const d = decisionOf(id);
      return {
        issueId: id,
        ready: r.ready,
        blockShort: r.block,
        blockText: r.blockText,
        machine: r.a.machine,
        machineOverridden: r.a.machineOverridden,
        implementer: r.a.implementer,
        implementerOverridden: r.a.implementerOverridden,
        effort: effortText(r.m, r.a.implementer),
        reviewers: D.team.reviewers.map((rid) => ({ id: rid, effort: effortText(r.m, rid) })),
        workflow: issueById(id).workflow,
        base: r.m.repo.base,
        repoPath: r.m.repo.path,
        planRev: p.rev,
        planText: p.text,
        decision: d ? d.option : null,
        checks: r.checks,
      };
    });
    const sig = JSON.stringify([
      state.draft.revision,
      pins,
      items.map((i) => [i.issueId, i.ready, i.machine, i.implementer]),
    ]);
    return {
      key: "wk-" + hash(sig),
      draftRevision: state.draft.revision,
      pins,
      items,
      createdAt: nowText(),
      receiptId: null,
    };
  }

  function staleReason(pv) {
    if (!pv || pv.receiptId) return null;
    if (pv.draftRevision !== state.draft.revision)
      return "The selection or an assignment changed after it was created.";
    for (const id of Object.keys(pv.pins))
      if (pinKey(id) !== pv.pins[id])
        return `The plan or decision for ${id} was saved after it was created.`;
    return null;
  }

  function startDemo() {
    const pv = state.preview;
    if (!pv) return;
    const prior = state.receipts.find((r) => r.key === pv.key);
    if (prior) {
      pv.receiptId = prior.id;
      openReceipt(prior.id);
      toast(`Already started as ${prior.id}. Nothing new was queued.`);
      return;
    }
    if (staleReason(pv)) {
      toast("This preview is out of date. Create a new preview before starting.");
      render();
      return;
    }
    if (!pv.items.some((i) => i.ready)) {
      toast("Nothing in this preview is ready to start.");
      return;
    }
    const n = state.receipts.reduce((x, r) => Math.max(x, parseInt(r.id.slice(2), 10) || 0), 0);
    const id = "R-" + (n + 1);
    const items = pv.items.map((it) => {
      const rec = Object.assign({}, it);
      delete rec.ready;
      delete rec.blockShort;
      delete rec.blockText;
      if (!it.ready) return Object.assign(rec, { result: "blocked", reason: it.blockText });
      // Start re-checks each item; a request accepted since the preview is not repeated.
      const again = acceptedItem(it.issueId);
      if (again)
        return Object.assign(rec, {
          result: "blocked",
          reason: `Already queued in demo receipt ${again.receipt.id}.`,
        });
      return Object.assign(rec, { result: "accepted", reason: null });
    });
    state.receipts.push({ id, key: pv.key, at: nowText(), items });
    const stored = writeJson(KEY.receipts, state.receipts);
    pv.receiptId = id;

    const acceptedIds = items.filter((i) => i.result === "accepted").map((i) => i.issueId);
    changeDraft((d) => dropFromDraft(d, acceptedIds));
    patchSavedDraft(acceptedIds);

    state.highlight = id;
    state.view = "runs";
    state.runSel = acceptedIds.length ? { receipt: id, issue: acceptedIds[0] } : null;
    state.runTab = "summary";
    state.runDetailOpen = false;
    render("rc-" + id);
    toast(
      `Started in the demo as ${id}: ${acceptedIds.length} queued, ${
        items.length - acceptedIds.length
      } not started.` +
        (stored ? "" : " This browser blocked local storage, so the receipt lasts until reload."),
    );
  }

  function openReceipt(rid) {
    const r = state.receipts.find((x) => x.id === rid);
    if (!r) return;
    const first = r.items.find((i) => i.result === "accepted");
    state.view = "runs";
    state.runSel = first ? { receipt: rid, issue: first.issueId } : state.runSel;
    state.runDetailOpen = false;
    render("rc-" + rid);
  }

  function currentRun() {
    const s = state.runSel;
    if (s) {
      const r = state.receipts.find((x) => x.id === s.receipt);
      const it = r && r.items.find((x) => x.issueId === s.issue && x.result === "accepted");
      if (it) return { r, it };
    }
    for (let k = state.receipts.length - 1; k >= 0; k--) {
      const r = state.receipts[k];
      const it = r.items.find((x) => x.result === "accepted");
      if (it) return { r, it };
    }
    return null;
  }

  /* Render: flow bar --------------------------------------------------- */
  function previewSummary() {
    const pv = state.preview;
    if (!pv) return "Not created";
    if (pv.receiptId) return `Started as ${pv.receiptId}`;
    if (staleReason(pv)) return "Out of date";
    const ready = pv.items.filter((i) => i.ready).length;
    return `${ready} ready, ${pv.items.length - ready} blocked`;
  }

  function renderSteps() {
    const n = state.draft.selected.length;
    const q = acceptedCount();
    const pvState = previewSummary();
    const steps = [
      ["work", "1", "Select and assign", n ? `${n} selected` : "Nothing selected"],
      ["preview", "2", "Preview", pvState],
      ["runs", "3", "Demo runs", q ? `${q} queued` : "None yet"],
    ];
    $("wk-steps").innerHTML = steps
      .map(
        ([v, num, label, sub]) =>
          `<button type="button" class="wk-step${
            v === "preview" && pvState === "Out of date" ? " is-stale" : ""
          }" id="step-${v}" data-view="${v}"${
            state.view === v ? ' aria-current="page"' : ""
          }><span class="n" aria-hidden="true">${num}</span><span class="l">${esc(
            label,
          )}</span><span class="s">${esc(sub)}</span></button>`,
      )
      .join('<span class="wk-step-sep" aria-hidden="true"></span>');
  }

  function renderSaveState() {
    const s = draftStatus();
    const html = `<span class="wk-dot ${s.dirty ? "is-dirty" : "is-clean"}" aria-hidden="true"></span>${esc(
      s.text,
    )}`;
    const el = $("wk-savestate");
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  /* Render: Work view -------------------------------------------------- */
  function renderSide() {
    const t = D.tracker;
    const machines = D.machines
      .map((m) => {
        const n = Object.keys(m.agents).length;
        return `<li><button type="button" class="wk-mbtn" id="mb-${m.id}" data-machine="${
          m.id
        }" aria-pressed="${state.machineOpen === m.id}">
          <span class="wk-dot ${m.status === "connected" ? "is-on" : "is-off"}" aria-hidden="true"></span>
          <span class="nm">${esc(m.name)}</span>
          <span class="st">${esc(m.statusText)}</span>
          <span class="sub">${esc(m.os)}${
            m.status === "connected" ? `, ${plural(n, "agent")}` : ", agents unknown"
          }</span>
        </button></li>`;
      })
      .join("");
    $("wk-side").innerHTML = `
      <section class="wk-sec wk-sec-project">
        <p class="wk-project">${icon("folder")}<span>Neokod</span></p>
        <dl class="wk-facts">
          <dt>Tracker</dt><dd>${esc(t.connection)}</dd>
          <dt>Repository</dt><dd>${esc(t.repo)}</dd>
          <dt>Scope</dt><dd>${esc(t.scope)}</dd>
          <dt>Fetched</dt><dd>${esc(t.fetchedAt)}, sample time</dd>
        </dl>
      </section>
      <section class="wk-sec wk-sec-mode" aria-labelledby="wk-mode-h">
        <h2 class="label" id="wk-mode-h">Start mode</h2>
        <label class="choice wk-choice">
          <input type="radio" name="wk-mode" value="selected" checked />
          <span class="c-label">Selected only</span>
          <span class="c-detail">Only issues you select, preview and start will run.</span>
        </label>
        <label class="choice wk-choice is-off">
          <input type="radio" name="wk-mode" value="automatic" disabled />
          <span class="c-label">Automatic</span>
          <span class="c-detail">Would start matching issues without a click. It needs an explicit project policy and is not offered in this prototype. Nothing here starts on its own.</span>
        </label>
      </section>
      <section class="wk-sec wk-sec-machines" aria-labelledby="wk-mach-h">
        <h2 class="label" id="wk-mach-h">Machines</h2>
        <ul class="wk-machines">${machines}</ul>
        <p class="demo-note">Saved in Settings, Connections, Machines. These are sample machines, not machines detected on this computer.</p>
      </section>
      <section class="wk-sec wk-keys" aria-label="Keyboard">
        <p class="label">Keyboard</p>
        <p><span class="kbd">/</span> Search issues</p>
        <p><span class="kbd">↑</span> <span class="kbd">↓</span> Move between issues</p>
        <p><span class="kbd">←</span> <span class="kbd">→</span> Checkbox or title</p>
        <p><span class="kbd">X</span> Select or clear issue</p>
        <p><span class="kbd">Enter</span> Show details</p>
        <p><span class="kbd">⌘</span> or <span class="kbd">Ctrl</span> <span class="kbd">S</span> Save draft or plan</p>
        <p><span class="kbd">Esc</span> Clear search or close</p>
      </section>`;
  }

  function buildMainShell() {
    const t = D.tracker;
    const labels = Array.from(new Set(D.issues.flatMap((i) => i.labels))).sort();
    $("wk-main").innerHTML = `
      <div class="wk-head">
        <h1 class="wk-h1">Agent-ready issues</h1>
        <p class="wk-coverage">${icon("history")}<span>Loaded ${t.loaded} of ${t.total} matching issues from ${esc(
          t.repo,
        )}, fetched ${esc(t.fetchedAt)} (sample time). The other ${
          t.total - t.loaded
        } are on a next page this prototype does not load. Select visible never includes them.</span></p>
      </div>
      <div class="wk-toolbar">
        <label class="wk-search">
          ${icon("search")}
          <span class="sr-only">Search loaded issues</span>
          <input id="wk-q" type="search" placeholder="Search loaded issues by ID, title or label" autocomplete="off" />
          <span class="kbd" aria-hidden="true">/</span>
        </label>
        <label class="wk-labelsel">
          <span class="sr-only">Filter by label</span>
          <select id="wk-label" class="field">
            <option value="all">Any label</option>
            ${labels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="wk-chips" id="wk-chips" role="group" aria-label="Filter by workflow"></div>
      <p class="wk-unsupported">${esc(t.unsupported)}</p>
      <div class="wk-listhead" id="wk-listhead"></div>
      <div class="wk-list" id="wk-list" role="list" aria-label="Loaded issues"></div>
      <div id="wk-hiddensel"></div>
      <div class="wk-batch" id="wk-batch" role="region" aria-label="Selected work"></div>`;
  }

  function filteredIssues() {
    const q = state.q.trim().toLowerCase();
    return D.issues.filter(
      (i) =>
        (state.wf === "all" || i.workflow === state.wf) &&
        (state.label === "all" || i.labels.indexOf(state.label) >= 0) &&
        (!q || (i.id + " " + i.title + " " + i.labels.join(" ")).toLowerCase().indexOf(q) >= 0),
    );
  }

  function issueRow(i) {
    const sel = isSelected(i.id);
    const acc = acceptedItem(i.id);
    let runOn;
    let ready;
    if (acc) {
      runOn = mchip(acc.item.machine);
      ready = `${lpill("neutral", "history", "Queued (demo)")}<button type="button" class="linkish wk-openrun" id="or-${
        i.id
      }" data-openrun="${acc.receipt.id}|${i.id}">Open run</button>`;
    } else if (sel) {
      const r = assess(i.id);
      runOn =
        mchip(r.a.machine) +
        (r.a.machineOverridden ? '<span class="wk-ov">This issue only</span>' : "");
      ready = r.ready
        ? lpill("neutral", "check", "Ready to preview")
        : `${lpill("attn", "alert", "Blocked")}<span class="wk-why">${esc(r.block)}</span>`;
    } else {
      runOn = '<span class="faint">Not selected</span>';
      ready = i.existing ? `<span class="wk-why">${esc(i.existing.short)}</span>` : "";
    }
    const cbLabel = acc ? `${i.id} is already queued in this demo` : `Select ${i.id}, ${i.title}`;
    return `<div class="wk-row${sel ? " is-sel" : ""}${acc ? " is-acc" : ""}" role="listitem" data-row="${
      i.id
    }"${state.focusId === i.id ? ' aria-current="true"' : ""}>
      <span class="wk-cbwrap"><input type="checkbox" class="wk-cb" id="cb-${i.id}" data-cb="${i.id}"${
        sel ? " checked" : ""
      }${acc ? " disabled" : ""} aria-label="${esc(cbLabel)}" /></span>
      <span class="wk-id">${i.id}</span>
      <button type="button" class="wk-title" id="tt-${i.id}" data-inspect="${i.id}">
        <span class="t">${esc(i.title)}</span>
        <span class="s"><span>${esc(wf(i.workflow).name)}</span><span>${esc(
          i.labels.join(", "),
        )}</span><span>Edited ${esc(i.updated)}</span>${
          i.shared ? '<span class="wk-sharedtag">Shared sample</span>' : ""
        }</span>
      </button>
      <span class="wk-runon">${runOn}</span>
      <span class="wk-ready">${ready}</span>
    </div>`;
  }

  function renderMain() {
    if ($("wk-q").value !== state.q) $("wk-q").value = state.q;
    $("wk-label").value = state.label;

    const wfs = ["all"].concat(Object.keys(D.workflows));
    $("wk-chips").innerHTML = wfs
      .map((w) => {
        const n = D.issues.filter((i) => w === "all" || i.workflow === w).length;
        return `<button type="button" id="wf-${w}" data-wf="${w}" aria-pressed="${state.wf === w}">${esc(
          w === "all" ? "All workflows" : wf(w).name,
        )}<span class="n">${n}</span></button>`;
      })
      .join("");

    const list = filteredIssues();
    const selectable = list.filter((i) => !acceptedItem(i.id));
    const selVis = selectable.filter((i) => isSelected(i.id)).length;
    const all = selectable.length > 0 && selVis === selectable.length;
    $("wk-listhead").innerHTML = `
      <label class="wk-selvis"><input type="checkbox" id="wk-selvis"${all ? " checked" : ""}${
        selectable.length ? "" : " disabled"
      } /><span>Select visible (${selectable.length})</span></label>
      <span class="wk-col wk-col-runon">Run on</span>
      <span class="wk-col wk-col-ready">Readiness</span>`;
    $("wk-selvis").indeterminate = selVis > 0 && !all;

    $("wk-list").innerHTML = list.length
      ? list.map(issueRow).join("")
      : `<div class="wk-empty" role="listitem"><p>No loaded issue matches these filters.</p><button type="button" class="btn sm" id="act-clear-filters" data-act="clear-filters">Clear filters</button></div>`;

    const hidden = state.draft.selected.filter((id) => !list.some((i) => i.id === id)).length;
    $("wk-hiddensel").innerHTML = hidden
      ? `<p class="wk-hiddensel">${icon("eye")}<span>${plural(
          hidden,
          "selected issue is",
          "selected issues are",
        )} hidden by the current filters and stay${
          hidden === 1 ? "s" : ""
        } selected.</span><button type="button" class="linkish" id="act-show-all" data-act="clear-filters">Show all</button></p>`
      : "";

    const n = state.draft.selected.length;
    const dirty = draftStatus().dirty;
    const defM = machineById(state.draft.defaults.machine);
    const defI = agent(state.draft.defaults.implementer);
    const blocked = orderedSelected().filter((id) => !assess(id).ready).length;
    $("wk-batch").innerHTML = `
      <span class="wk-batch-n"><strong>${n}</strong> selected${
        n && blocked ? `<span class="wk-batch-blk">, ${blocked} blocked</span>` : ""
      }</span>
      <span class="wk-batch-def">Defaults: ${esc(defM.name)}, ${esc(defI.name)}</span>
      <span class="wk-batch-sp"></span>
      <button type="button" class="btn ghost sm" id="act-clear" data-act="clear-selection"${
        n ? "" : " disabled"
      }>Clear selection</button>
      <button type="button" class="btn sm" id="act-assign" data-act="show-selected"${
        n ? "" : " disabled"
      }>Assign</button>
      <button type="button" class="btn sm" id="act-save" data-act="save-draft"${
        dirty ? "" : " disabled"
      }>Save draft</button>
      <button type="button" class="btn primary sm" id="act-preview" data-act="create-preview"${
        n ? "" : " disabled"
      }>Preview ${n ? plural(n, "issue") : "selected"}</button>`;
  }

  function renderInsp() {
    const el = $("wk-insp");
    const key = state.machineOpen ? "m:" + state.machineOpen : state.tab + ":" + state.focusId;
    if (key !== state.inspKey) {
      el.scrollTop = 0;
      state.inspKey = key;
    }
    if (state.machineOpen) {
      el.innerHTML = machinePanel(state.machineOpen);
      return;
    }
    const tabs = [
      ["details", "Details"],
      ["plan", "Plan"],
      ["selected", `Selected (${state.draft.selected.length})`],
    ];
    const body =
      state.tab === "plan"
        ? planPanel(state.focusId)
        : state.tab === "selected"
          ? selectedPanel()
          : detailsPanel(state.focusId);
    el.innerHTML = `
      <div class="wk-insp-head">
        <button type="button" class="btn ghost sm wk-back" id="insp-back" data-act="close-drawer">${icon(
          "chevronLeft",
        )}Issues</button>
        <div class="wk-tabs" role="tablist" aria-label="Inspector">
          ${tabs
            .map(
              ([k, l]) =>
                `<button type="button" role="tab" id="itab-${k}" data-tab="${k}" aria-selected="${
                  state.tab === k
                }" aria-controls="ipanel" tabindex="${state.tab === k ? 0 : -1}">${esc(l)}</button>`,
            )
            .join("")}
        </div>
      </div>
      <div class="wk-insp-body" role="tabpanel" id="ipanel" aria-labelledby="itab-${state.tab}">${body}</div>`;
  }

  function scopeNote(i) {
    if (!i.shared)
      return `<p class="wk-scope">${icon(
        "doc",
      )}<span>Separate demo sample. This issue does not appear on the Runs, Workflow map or Plan and decisions pages.</span></p>`;
    return `<div class="wk-scope is-shared">
      <p><strong>Shared sample issue.</strong> The Runs, Workflow map and Plan and decisions pages show an existing example attempt 3 for ${
        i.id
      }, waiting on decision D-3. A request you start here is a separate demo request. It is not added to those pages and does not change attempt 3.</p>
      ${sharedLinks()}
    </div>`;
  }

  function sharedLinks() {
    return `<p class="wk-links">
      <a href="runs.html#${SHARED_ID}">${icon("list")}Runs: existing example attempt 3</a>
      <a href="workflow.html#${SHARED_ID}">${icon("map")}Workflow map: existing example attempt 3</a>
      <a href="planning.html">${icon("doc")}Plan and decisions: existing example attempt 3</a>
    </p>`;
  }

  function teamLines(mid, implementer, efforts) {
    const m = machineById(mid);
    const impl = agent(implementer);
    const lines = [
      `<li><span class="wk-role">Implementer</span><span>${esc(impl.name)} through ${esc(
        impl.via,
      )}<span class="faint">, effort ${esc(efforts ? efforts.impl : effortText(m, implementer))}</span></span></li>`,
    ];
    D.team.reviewers.forEach((r, idx) => {
      const eff = efforts ? (efforts.reviewers[idx] || {}).effort : effortText(m, r);
      lines.push(
        `<li><span class="wk-role">Reviewer</span><span>${esc(agent(r).name)} through ${esc(
          agent(r).via,
        )}<span class="faint">, effort ${esc(eff || "unknown")}</span></span></li>`,
      );
    });
    return `<ul class="wk-team">${lines.join("")}</ul>`;
  }

  function detailsPanel(id) {
    const i = issueById(id);
    const acc = acceptedItem(id);
    const sel = isSelected(id);
    let assign;
    if (acc) {
      assign = `<p>Queued in this demo by receipt ${acc.receipt.id}, pinned to ${mchip(
        acc.item.machine,
      )}. It cannot be selected again while that request is open.</p>
        <div class="wk-row-actions"><button type="button" class="btn sm" id="d-openrun" data-openrun="${
          acc.receipt.id
        }|${id}">Open run</button></div>`;
    } else if (sel) {
      const r = assess(id);
      assign = `<dl class="wk-kv">
          <dt>Run on</dt><dd>${mchip(r.a.machine)} <span class="faint">${
            r.a.machineOverridden ? "Set for this issue" : "Batch default"
          }</span></dd>
          <dt>Repository</dt><dd class="wk-path">${esc(r.m.repo.path)}</dd>
          <dt>Agents</dt><dd>${teamLines(r.a.machine, r.a.implementer)}</dd>
          <dt>Readiness</dt><dd>${
            r.ready
              ? lpill("neutral", "check", "Ready to preview")
              : lpill("attn", "alert", "Blocked")
          }${r.ready ? "" : `<p class="wk-blocktext">${esc(r.blockText)}</p>`}</dd>
        </dl>
        <div class="wk-row-actions">
          <button type="button" class="btn sm" id="d-assign" data-act="show-selected" data-id="${id}">Change assignment</button>
          <button type="button" class="btn ghost sm" id="d-deselect" data-act="deselect" data-id="${id}">Remove from selection</button>
        </div>`;
    } else {
      assign = `<p class="muted">Not selected. Selecting adds it to the draft batch with the batch defaults. Nothing starts until you preview and start.</p>
        ${i.existing ? `<p class="wk-blocktext">${esc(i.existing.text)}</p>` : ""}
        <div class="wk-row-actions"><button type="button" class="btn sm" id="d-select" data-act="select" data-id="${id}">Select ${id}</button></div>`;
    }
    return `
      <div class="wk-ihead">
        <p class="wk-meta"><span>${i.id}</span><span>${esc(D.tracker.name)} issue #${i.number}</span><span>Open</span><span>Edited ${esc(
          i.updated,
        )}</span></p>
        <h2>${esc(i.title)}</h2>
        <p class="wk-tags"><span class="tag">${esc(wf(i.workflow).name)}</span>${i.labels
          .map((l) => `<span class="tag observed">${esc(l)}</span>`)
          .join("")}</p>
      </div>
      ${scopeNote(i)}
      <section class="wk-isec"><h3>Description</h3><p>${esc(i.description)}</p></section>
      <section class="wk-isec"><h3>Acceptance criteria</h3>${
        i.acceptance.length
          ? `<ul class="wk-ac">${i.acceptance
              .map((a) => `<li>${icon("circle")}<span>${esc(a)}</span></li>`)
              .join("")}</ul>`
          : `<p class="wk-blocktext">None in the issue. Reviewers will check against the description only. Add criteria in ${esc(
              D.tracker.name,
            )} and fetch again.</p>`
      }</section>
      <section class="wk-isec"><h3>Assignment</h3>${assign}</section>
      <p class="wk-native">Tracker reference ${esc(i.nativeId)} in ${esc(D.tracker.connection)}, ${esc(
        D.tracker.repo,
      )}. Kept so a renamed or renumbered issue is still the same issue.</p>`;
  }

  function planEditor(id, ctx, note) {
    const i = issueById(id);
    const p = planOf(id);
    const edit = state.planEdits[id];
    const text = edit != null ? edit : p.text;
    const dirty = edit != null && edit !== p.text;
    return `
      <section class="wk-isec">
        <div class="wk-planhead">
          <h3 id="plan-h-${ctx}">Plan r${p.rev}</h3>
          <span class="faint">${p.savedAt ? `Saved ${esc(p.savedAt)}` : "Drafted from the issue (sample)"}</span>
          <span class="wk-planstate" id="plan-state-${ctx}">${dirty ? "Unsaved edits" : ""}</span>
        </div>
        <label class="sr-only" for="plan-text-${ctx}">Plan for ${id}</label>
        <textarea class="field wk-plantext" id="plan-text-${ctx}" data-plan="${id}" data-ctx="${ctx}" rows="11" spellcheck="true">${esc(
          text,
        )}</textarea>
        <div class="wk-row-actions">
          <button type="button" class="btn sm" id="plan-save-${ctx}" data-act="save-plan" data-id="${id}"${
            dirty ? "" : " disabled"
          }>Save plan</button>
          <button type="button" class="btn ghost sm" id="plan-discard-${ctx}" data-act="discard-plan" data-id="${id}"${
            dirty ? "" : " disabled"
          }>Discard edits</button>
        </div>
        <p class="wk-hint">Saving a plan starts nothing and grants no permission to run. ${esc(note)}</p>
      </section>
      ${i.question ? decisionBlock(i, ctx) : ""}`;
  }

  function decisionBlock(i, ctx) {
    const d = decisionOf(i.id);
    const draft = state.decisionEdits[i.id];
    const chosen = draft || (d && d.option) || "";
    const canSave = !!draft && (!d || draft !== d.option);
    return `
      <section class="wk-isec">
        <fieldset class="wk-fs">
          <legend><span class="wk-fs-k">Open question</span><span class="wk-fs-q">${esc(
            i.question.title,
          )}</span></legend>
          ${i.question.options
            .map(
              (o) =>
                `<label class="choice"><input type="radio" name="dq-${ctx}" value="${esc(
                  o.id,
                )}" data-decision="${i.id}" data-ctx="${ctx}"${
                  chosen === o.id ? " checked" : ""
                } /><span class="c-label">${esc(o.label)}${
                  o.suggested ? ' <span class="suggested">Suggested</span>' : ""
                }</span></label>`,
            )
            .join("")}
        </fieldset>
        <div class="wk-row-actions">
          <button type="button" class="btn sm" id="dec-save-${ctx}" data-act="save-decision" data-id="${
            i.id
          }"${canSave ? "" : " disabled"}>Save decision</button>
        </div>
        <p class="wk-hint">${
          d
            ? `Saved: ${esc(optionLabel(i, d.option))}, at ${esc(d.savedAt)}.`
            : "No decision saved."
        } Saving a decision does not start, resume or approve work.</p>
      </section>`;
  }

  function planPanel(id) {
    const i = issueById(id);
    const acc = acceptedItem(id);
    const note = acc
      ? `The request queued in ${acc.receipt.id} keeps the plan it was accepted with; a new revision applies to a future request.`
      : "It makes any preview that includes this issue out of date.";
    return `
      <div class="wk-ihead">
        <p class="wk-meta"><span>${i.id}</span><span>Plan and decisions</span></p>
        <h2>${esc(i.title)}</h2>
      </div>
      ${
        i.shared
          ? `<p class="wk-scope is-shared">${icon(
              "doc",
            )}<span>This is a plan for a new demo request. The existing example attempt 3 uses plan r5 on the <a href="planning.html">Plan and decisions page</a>.</span></p>`
          : ""
      }
      ${planEditor(id, "insp", note)}`;
  }

  function machineOptions(selectedId, implementer, withDefault) {
    const optFor = (m) => {
      let suffix = "";
      if (m.status !== "connected") suffix = " (offline)";
      else if (!m.agents[implementer]) suffix = ` (no ${agent(implementer).name})`;
      return m.name + suffix;
    };
    let html = "";
    if (withDefault) {
      const dm = machineById(state.draft.defaults.machine);
      html += `<option value=""${selectedId ? "" : " selected"}>Batch default: ${esc(optFor(dm))}</option>`;
    }
    D.machines.forEach((m) => {
      html += `<option value="${m.id}"${selectedId === m.id ? " selected" : ""}>${esc(optFor(m))}</option>`;
    });
    return html;
  }

  function agentOptions(selectedId, machineId, withDefault) {
    const m = machineById(machineId);
    const optFor = (a) => {
      const x = agent(a);
      let s = `${x.name}, ${x.via}`;
      if (a === D.team.implementer) s += ", project default";
      if (m && m.status === "connected" && !m.agents[a]) s += ` (not on ${m.name})`;
      return s;
    };
    let html = "";
    if (withDefault)
      html += `<option value=""${selectedId ? "" : " selected"}>Batch default: ${esc(
        optFor(state.draft.defaults.implementer),
      )}</option>`;
    D.AGENT_ORDER.forEach((a) => {
      html += `<option value="${a}"${selectedId === a ? " selected" : ""}>${esc(optFor(a))}</option>`;
    });
    return html;
  }

  function selectedItem(id) {
    const i = issueById(id);
    const r = assess(id);
    const o = state.draft.overrides[id] || {};
    return `<li class="wk-selitem${state.focusId === id ? " is-cur" : ""}" id="si-${id}">
      <div class="wk-selhead">
        <button type="button" class="linkish wk-selid" id="si-open-${id}" data-inspect="${id}">${id}</button>
        <span class="wk-seltitle">${esc(i.title)}</span>
        <button type="button" class="btn ghost icon wk-remove" id="si-rm-${id}" data-act="deselect" data-id="${id}" aria-label="Remove ${id} from selection">${icon(
          "x",
        )}</button>
      </div>
      <div class="wk-form">
        <label for="ov-m-${id}">Run on</label>
        <select id="ov-m-${id}" class="field wk-sel" data-ov="machine" data-id="${id}">${machineOptions(
          o.machine || "",
          r.a.implementer,
          true,
        )}</select>
        <label for="ov-i-${id}">Implementer</label>
        <select id="ov-i-${id}" class="field wk-sel" data-ov="implementer" data-id="${id}">${agentOptions(
          o.implementer || "",
          r.a.machine,
          true,
        )}</select>
        <span class="wk-form-l">Repository</span><span class="wk-path">${esc(r.m.repo.path)}</span>
        <span class="wk-form-l">Effort</span><span>${esc(effortText(r.m, r.a.implementer))}</span>
      </div>
      <div class="wk-readiness">
        ${r.ready ? lpill("neutral", "check", "Ready to preview") : lpill("attn", "alert", "Blocked")}
        ${
          r.fix
            ? `<button type="button" class="btn sm" id="fix-${id}" data-act="apply-fix" data-id="${id}" data-machine="${r.fix.machine}">${esc(
                r.fix.label,
              )}</button>`
            : ""
        }
      </div>
      ${r.ready ? "" : `<p class="wk-blocktext">${esc(r.blockText)}</p>`}
    </li>`;
  }

  function selectedPanel() {
    const ids = orderedSelected();
    const defs = state.draft.defaults;
    const ready = ids.filter((id) => assess(id).ready).length;
    return `
      <section class="wk-isec">
        <h3>Batch defaults</h3>
        <div class="wk-form">
          <label for="def-machine">Run on</label>
          <select id="def-machine" class="field wk-sel" data-def="machine">${machineOptions(
            defs.machine,
            defs.implementer,
            false,
          )}</select>
          <label for="def-impl">Implementer</label>
          <select id="def-impl" class="field wk-sel" data-def="implementer">${agentOptions(
            defs.implementer,
            defs.machine,
            false,
          )}</select>
          <span class="wk-form-l">Reviewers</span>
          <span>${esc(
            listText(D.team.reviewers.map((r) => `${agent(r).name} through ${agent(r).via}`)),
          )}, on the same machine as the implementer. Project setting.</span>
        </div>
        <p class="wk-hint">Defaults apply to every selected issue without its own choice. Changing a default never changes an issue you set individually. Another provider is used only when you pick it here; there is no automatic fallback.</p>
      </section>
      <section class="wk-isec">
        <h3>Selected issues (${ids.length})</h3>
        ${
          ids.length
            ? `<p class="wk-hint wk-hint-top">${ready} ready to preview, ${
                ids.length - ready
              } blocked. Blocked issues stay in the preview with their reason and never start.</p>
               <ol class="wk-sellist">${ids.map(selectedItem).join("")}</ol>`
            : '<p class="muted">No issues selected. Tick issues in the list. Select visible only selects issues you can see.</p>'
        }
      </section>`;
  }

  function machinePanel(mid) {
    const m = machineById(mid);
    const online = m.status === "connected";
    const here = orderedSelected().filter((id) => assignment(id).machine === mid);
    const queued = [];
    state.receipts.forEach((r) =>
      r.items.forEach((it) => {
        if (it.result === "accepted" && it.machine === mid) queued.push({ r, it });
      }),
    );
    const agentRows = D.AGENT_ORDER.map((a) => {
      const x = agent(a);
      const cap = m.agents[a];
      const role =
        a === D.team.implementer
          ? "Project default implementer"
          : D.team.reviewers.indexOf(a) >= 0
            ? "Project reviewer"
            : "Optional, by your choice";
      return `<tr>
        <th scope="row">${esc(x.name)}<span class="sub">${esc(x.via)}</span></th>
        <td>${
          cap ? lpill("neutral", "check", "Available") : lpill("quiet", "minus", "Not available")
        }${!cap && m.missing[a] ? `<span class="sub">${esc(m.missing[a])}</span>` : ""}</td>
        <td>${cap ? esc(effortText(m, a)) : "None"}</td>
        <td class="faint">${esc(role)}</td>
      </tr>`;
    }).join("");
    return `
      <div class="wk-insp-head">
        <button type="button" class="btn ghost sm" id="mach-close" data-act="close-machine">${icon(
          "chevronLeft",
        )}Back</button>
        <span class="label">Saved machine</span>
      </div>
      <div class="wk-insp-body">
        <div class="wk-ihead">
          <h2>${MACHINE_ICON} ${esc(m.name)}</h2>
          <p>${
            online
              ? lpill("neutral", "dot", "Connected (sample status)")
              : lpill("danger", "x", m.statusText)
          }</p>
        </div>
        <p class="wk-scope">${icon(
          "eye",
        )}<span>Sample facts for this prototype. Nothing was detected, and this page makes no connection.</span></p>
        ${online ? "" : `<p class="wk-blocktext">${esc(m.problem)}</p>`}
        <dl class="wk-kv">
          <dt>Address</dt><dd class="mono">${esc(m.address)}</dd>
          <dt>Connection</dt><dd>${esc(m.route)}</dd>
          <dt>System</dt><dd>${esc(m.os)}</dd>
          <dt>Last check</dt><dd>${esc(m.checked)} (sample time)</dd>
          <dt>Access</dt><dd>Token kept in Settings, Connections, Machines. It is never shown here or copied into a draft.</dd>
          <dt>Repository</dt><dd>${esc(m.repo.name)} at <span class="wk-path">${esc(m.repo.path)}</span></dd>
          <dt>Base</dt><dd>${esc(m.repo.base)}</dd>
          <dt>Queue</dt><dd>${esc(m.queue)}</dd>
        </dl>
        <section class="wk-isec">
          <h3>Agents on this machine</h3>
          ${
            online
              ? `<table class="wk-table"><thead><tr><th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Effort</th><th scope="col">Role</th></tr></thead><tbody>${agentRows}</tbody></table>`
              : `<p class="muted">Unknown while offline. Last known: ${esc(m.lastKnown)}.</p>`
          }
        </section>
        <section class="wk-isec">
          <h3>Used by this draft</h3>
          ${
            here.length
              ? `<ul class="wk-plain">${here
                  .map(
                    (id) =>
                      `<li><button type="button" class="linkish" id="mu-${id}" data-inspect="${id}">${id}</button> ${esc(
                        issueById(id).title,
                      )}</li>`,
                  )
                  .join("")}</ul>`
              : '<p class="muted">No selected issue runs here.</p>'
          }
          ${
            queued.length
              ? `<p class="wk-hint">Queued here in this demo: ${queued
                  .map(
                    (q) =>
                      `<button type="button" class="linkish" id="mq-${q.it.issueId}" data-openrun="${q.r.id}|${q.it.issueId}">${q.it.issueId}</button>`,
                  )
                  .join(", ")}.</p>`
              : ""
          }
        </section>
      </div>`;
  }

  /* Render: Preview ----------------------------------------------------- */
  function simNote() {
    return `<div class="wk-sim" role="note">${icon(
      "eye",
    )}<p><strong>Simulated local preview.</strong> Checked against sample machine facts in this page, not a server. It reserves nothing, holds no queue slot and is not admission. Start only changes this page's demo. No build, validation or agent command runs.</p></div>`;
  }

  function stageTable(rows) {
    return `<table class="wk-table"><thead><tr><th scope="col">Stage</th><th scope="col">Who</th><th scope="col">Allowed to</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function stageWho(stage, implementer, machine) {
    const role = D.stagePlan[stage].role;
    if (role === "implementer") return agent(implementer).name;
    if (role === "reviewers") return listText(D.team.reviewers.map((r) => agent(r).name));
    if (role === "host")
      return `Validation on ${machine ? machineById(machine).name : "the target machine"}`;
    return "You";
  }

  function previewItem(it) {
    const i = issueById(it.issueId);
    const m = machineById(it.machine);
    const w = wf(it.workflow);
    const impl = agent(it.implementer);
    const acc = acceptedItem(it.issueId);
    return `<li class="wk-pvi ${it.ready ? "is-ready" : "is-blocked"}">
      <div class="wk-pvi-head">
        ${it.ready ? lpill("neutral", "check", "Ready") : lpill("attn", "alert", "Blocked")}
        <span class="wk-id">${i.id}</span>
        <span class="wk-pvi-title">${esc(i.title)}</span>
        ${mchip(it.machine)}
      </div>
      ${
        it.ready
          ? ""
          : `<p class="wk-pvi-why"><strong>Will not start.</strong> ${esc(it.blockText)}${
              acc
                ? ""
                : ` <button type="button" class="linkish" id="pv-fix-${i.id}" data-act="fix-in-work" data-id="${i.id}">Change in Work</button>`
            }</p>`
      }
      <div class="wk-pvi-body">
        <dl class="wk-kv">
          <dt>Run on</dt><dd>${esc(m.name)} <span class="faint">${
            it.machineOverridden ? "set for this issue" : "batch default"
          }</span><br /><span class="wk-path">${esc(it.repoPath)}</span></dd>
          <dt>Implementer</dt><dd>${esc(impl.name)} through ${esc(impl.via)}, effort ${esc(it.effort)}${
            it.implementerOverridden ? ' <span class="faint">set for this issue</span>' : ""
          }</dd>
          <dt>Reviewers</dt><dd>${it.reviewers
            .map(
              (r) =>
                `${esc(agent(r.id).name)} through ${esc(agent(r.id).via)}, effort ${esc(r.effort)}`,
            )
            .join("<br />")}<br /><span class="faint">Same machine as the implementer</span></dd>
          <dt>Workflow</dt><dd>${esc(w.name)}</dd>
          <dt>Validation</dt><dd>${w.validation
            .map((c) => `<code>${esc(c)}</code>`)
            .join(" ")} <span class="faint">Planned. Nothing runs here.</span></dd>
          <dt>Base</dt><dd>${esc(it.base)}</dd>
          <dt>Issue</dt><dd>As edited ${esc(i.updated)} (sample)</dd>
          <dt>Plan</dt><dd>r${it.planRev}${
            it.decision ? `, decision: ${esc(optionLabel(i, it.decision))}` : ""
          }</dd>
          <dt>Approval</dt><dd>${esc(w.approval)}</dd>
          <dt>If started</dt><dd>${
            it.ready
              ? `Queued on ${esc(m.name)}. ${esc(m.queue)}. No slot is reserved.`
              : "Not sent. Fix it in Work and create a new preview."
          }</dd>
        </dl>
        <div>
          <p class="wk-checks-h">Sample checks</p>
          <ul class="wk-checks" aria-label="Sample checks for ${i.id}">${it.checks.map(checkLine).join("")}</ul>
        </div>
      </div>
    </li>`;
  }

  function renderPreview() {
    const el = $("wk-view-preview");
    const pv = state.preview;
    const n = state.draft.selected.length;
    if (!pv) {
      el.innerHTML = `<div class="wk-pv">
        <header class="wk-pv-head"><div><h1 id="pv-title" tabindex="-1">Preview</h1></div></header>
        ${simNote()}
        <div class="wk-pv-empty">${
          n
            ? `<p>No current preview for the ${plural(
                n,
                "selected issue",
              )}. A preview checks each one against the sample machine facts and shows exactly what would start.</p>
               <div class="wk-row-actions"><button type="button" class="btn primary" id="pv-create" data-act="create-preview">Create preview</button><button type="button" class="btn" id="pv-back" data-act="go-work">Back to Work</button></div>`
            : `<p>Nothing is selected. Select issues in Work first; the preview covers only issues you selected.</p>
               <div class="wk-row-actions"><button type="button" class="btn" id="pv-back" data-act="go-work">Go to Work</button></div>`
        }</div>
      </div>`;
      return;
    }
    const stale = staleReason(pv);
    const ready = pv.items.filter((i) => i.ready);
    const blocked = pv.items.length - ready.length;
    const startable = !pv.receiptId && !stale && ready.length > 0;
    const perMachine = D.machines
      .map((m) => [m, pv.items.filter((i) => i.machine === m.id).length])
      .filter((x) => x[1])
      .map(([m, c]) => `${m.name} ${c}`);
    const roleLabel = {
      implementer: "Implementer",
      reviewers: "Reviewers",
      host: "Target machine",
      you: "You",
    };
    const rows = D.STAGES.map(
      (s) =>
        `<tr><th scope="row">${esc(D.STAGE_NAMES[s])}</th><td>${esc(
          roleLabel[D.stagePlan[s].role],
        )}</td><td>${esc(D.stagePlan[s].perm)}</td></tr>`,
    ).join("");
    el.innerHTML = `<div class="wk-pv">
      <header class="wk-pv-head">
        <div>
          <h1 id="pv-title" tabindex="-1">Preview</h1>
          <p class="faint">Created ${esc(pv.createdAt)} for ${plural(pv.items.length, "selected issue")}.</p>
        </div>
        <div class="wk-row-actions">
          <button type="button" class="btn" id="pv-back" data-act="go-work">Back to Work</button>
          <button type="button" class="btn" id="pv-refresh" data-act="create-preview"${
            n ? "" : " disabled"
          }>${stale ? "Create new preview" : "Preview again"}</button>
          <button type="button" class="btn primary" id="pv-start" data-act="start"${
            startable ? "" : " disabled"
          } aria-describedby="pv-sum">Start ${plural(ready.length, "ready item")} (demo)</button>
        </div>
      </header>
      ${simNote()}
      ${
        stale
          ? `<div class="wk-stale">${icon(
              "alert",
            )}<p><strong>This preview is out of date.</strong> ${esc(
              stale,
            )} Start stays off until you create a new preview.</p><button type="button" class="btn sm" id="pv-stale-refresh" data-act="create-preview"${
              n ? "" : " disabled"
            }>Create new preview</button></div>`
          : ""
      }
      ${
        pv.receiptId
          ? `<div class="wk-done">${icon("check")}<p>Started as demo receipt ${esc(
              pv.receiptId,
            )}. Starting this preview again returns the same receipt and queues nothing new.</p><button type="button" class="btn sm" id="pv-open-receipt" data-act="open-receipt" data-receipt="${esc(
              pv.receiptId,
            )}">Open receipt</button></div>`
          : ""
      }
      <p class="wk-pv-sum" id="pv-sum"><strong>${ready.length} ready, ${blocked} blocked.</strong> By machine: ${esc(
        perMachine.join(", "),
      )}. Each machine accepts or refuses its own items, so the batch is not all-or-nothing. Blocked items stay listed and are not sent.</p>
      <details class="wk-perm">
        <summary>Stages and permissions for these workflows</summary>
        ${stageTable(rows)}
        <p class="wk-hint">Agents never merge. Merging always needs a person.</p>
      </details>
      <ol class="wk-pv-list">${pv.items.map(previewItem).join("")}</ol>
    </div>`;
  }

  /* Render: Demo runs -------------------------------------------------- */
  function receiptBlock(r, cur) {
    const acc = r.items.filter((i) => i.result === "accepted");
    const blk = r.items.filter((i) => i.result !== "accepted");
    return `<section class="wk-receipt${state.highlight === r.id ? " is-new" : ""}" aria-labelledby="rc-${r.id}">
      <h2 id="rc-${r.id}" tabindex="-1">Receipt ${esc(r.id)}</h2>
      <p class="wk-rmeta">Started ${esc(r.at)}, local demo time. Request key <span class="mono">${esc(
        r.key,
      )}</span>. ${acc.length} queued, ${blk.length} not started.</p>
      <ul class="wk-rlist">
        ${acc
          .map((it) => {
            const on = cur && cur.r.id === r.id && cur.it.issueId === it.issueId;
            return `<li><button type="button" class="wk-ritem" id="ri-${r.id}-${it.issueId}" data-openrun="${
              r.id
            }|${it.issueId}"${on ? ' aria-current="true"' : ""}>
              ${lpill("neutral", "history", "Queued (demo)")}
              <span class="wk-id">${it.issueId}</span>
              <span class="t">${esc(issueById(it.issueId).title)}</span>
              ${mchip(it.machine)}
            </button></li>`;
          })
          .join("")}
        ${blk
          .map(
            (it) => `<li class="wk-rblocked">
              ${lpill("quiet", "minus", "Not started")}
              <span class="wk-id">${it.issueId}</span>
              <span class="t">${esc(it.reason || "Blocked at preview")}</span>
              ${mchip(it.machine)}
            </li>`,
          )
          .join("")}
      </ul>
    </section>`;
  }

  function runSummary(r, it) {
    const i = issueById(it.issueId);
    const m = machineById(it.machine);
    const w = wf(it.workflow);
    return `
      <div class="wk-now">
        <p class="k">Now</p>
        <p class="b">Queued in this demo. No agent has started and nothing is running.</p>
        <p class="n">Accepted means this page recorded the request. In the product, ${esc(
          m.name,
        )} would start it when a slot is free, and the stages would fill in from what it reports.</p>
      </div>
      <section class="wk-isec">
        <h3>Agent team</h3>
        ${teamLines(it.machine, it.implementer, { impl: it.effort, reviewers: it.reviewers })}
        <p class="wk-hint">All three run on ${esc(
          m.name,
        )}. Accepted work gets new agent sessions; choosing agents never moves an existing session.</p>
      </section>
      <section class="wk-isec">
        <h3>Request</h3>
        <dl class="wk-kv">
          <dt>Issue</dt><dd>${i.id}, ${esc(D.tracker.name)} issue #${i.number}, as edited ${esc(i.updated)}</dd>
          <dt>Run on</dt><dd>${mchip(it.machine)} <span class="mono">${esc(m.address)}</span></dd>
          <dt>Repository</dt><dd class="wk-path">${esc(it.repoPath)}</dd>
          <dt>Base</dt><dd>${esc(it.base)}</dd>
          <dt>Workflow</dt><dd>${esc(w.name)}</dd>
          <dt>Plan</dt><dd>r${it.planRev}, pinned at acceptance${
            it.decision ? `; decision: ${esc(optionLabel(i, it.decision))}` : ""
          }</dd>
          <dt>Approval</dt><dd>${esc(w.approval)}</dd>
          <dt>Receipt</dt><dd>${esc(r.id)}, accepted ${esc(r.at)}</dd>
          <dt>Preview match</dt><dd>Same machine, agents, base and plan as the preview you started. Nothing was substituted.</dd>
        </dl>
      </section>
      <section class="wk-isec">
        <h3>Machine</h3>
        <p>This request stays on ${esc(
          m.name,
        )}. Running it elsewhere needs a new linked request after this one is closed; it is never moved silently.</p>
      </section>
      ${
        i.shared
          ? `<section class="wk-isec wk-shared"><h3>Existing example attempt 3</h3><p>The other prototype pages show an existing example attempt 3 for ${i.id}. It is not this queued request, which has no execution yet.</p>${sharedLinks()}</section>`
          : `<p class="wk-scope">${icon(
              "doc",
            )}<span>Separate demo sample. It has no page in Runs, Workflow map or Plan and decisions.</span></p>`
      }`;
  }

  function runExecution(r, it) {
    const i = issueById(it.issueId);
    const w = wf(it.workflow);
    const nodes = D.STAGES.map((s, idx) => {
      const queued = idx === 0;
      return `<li class="wk-stage ${queued ? "is-queued" : "is-planned"}">
        <span class="wk-node" aria-hidden="true"></span>
        <span class="nm">${esc(D.STAGE_NAMES[s])}</span>
        <span class="st">${queued ? "Queued (demo)" : "Planned"}</span>
        <span class="who">${esc(stageWho(s, it.implementer, it.machine))}</span>
      </li>`;
    }).join("");
    const rows = D.STAGES.map(
      (s) =>
        `<tr><th scope="row">${esc(D.STAGE_NAMES[s])}</th><td>${esc(
          stageWho(s, it.implementer, it.machine),
        )}</td><td>${esc(D.stagePlan[s].perm)}</td></tr>`,
    ).join("");
    return `
      <p class="wk-hint wk-hint-top">Planned from the ${esc(
        w.name,
      )} workflow. Nothing has been observed, because no agent has started.</p>
      <ol class="wk-stages" aria-label="Stages">${nodes}</ol>
      <div class="wk-legend" aria-label="Legend">
        <span><i class="wk-lg wk-lg-queued"></i>Queued in this demo</span>
        <span><i class="wk-lg wk-lg-planned"></i>Planned, not observed</span>
        <span><i class="wk-lg wk-lg-observed"></i>Observed on the machine (none yet)</span>
      </div>
      <section class="wk-isec"><h3>Who does what</h3>${stageTable(rows)}</section>
      ${
        i.shared
          ? `<p class="wk-scope is-shared">${icon(
              "map",
            )}<span>For a full step map with agents and repair rounds, see the <a href="workflow.html#${SHARED_ID}">Workflow map for existing example attempt 3</a>. That map shows attempt 3, not this request.</span></p>`
          : `<p class="wk-scope">${icon(
              "map",
            )}<span>The Workflow map page has a detailed sample for ${SHARED_ID} attempt 3 only. This demo sample has no map.</span></p>`
      }`;
  }

  function runPlan(r, it) {
    const i = issueById(it.issueId);
    const cur = planOf(i.id);
    const changed = cur.rev !== it.planRev;
    return `
      <section class="wk-isec">
        <h3>Pinned for this request</h3>
        <p class="wk-hint wk-hint-top">Plan r${it.planRev}, as accepted ${esc(r.at)}.${
          it.decision ? ` Decision at acceptance: ${esc(optionLabel(i, it.decision))}.` : ""
        }</p>
        <pre class="wk-pinned">${esc(it.planText)}</pre>
        ${
          changed
            ? `<p class="wk-blocktext">Plan r${cur.rev} has been saved since. It applies to a future request; this one stays on r${it.planRev}.</p>`
            : ""
        }
      </section>
      <h3 class="wk-subh">Current plan for this issue</h3>
      ${planEditor(
        i.id,
        "run",
        "Edits here apply to the next request for this issue. This queued request keeps its pinned plan, and saving does not resume or restart it.",
      )}
      ${
        i.shared
          ? `<p class="wk-scope is-shared">${icon(
              "doc",
            )}<span>Decision D-3 and plan r5 belong to the existing example attempt 3. See <a href="planning.html">Plan and decisions: existing example attempt 3</a>.</span></p>`
          : ""
      }`;
  }

  function runEvidence(r, it) {
    const m = machineById(it.machine);
    const w = wf(it.workflow);
    return `
      <p class="wk-hint wk-hint-top">No evidence yet. Evidence appears only when ${esc(
        m.name,
      )} reports host checks and reviews for this request.</p>
      <section class="wk-isec">
        <h3>Host validation</h3>
        <ul class="wk-evlist">${w.validation
          .map((c) => `<li>${lpill("quiet", "minus", "Not run")}<code>${esc(c)}</code></li>`)
          .join("")}</ul>
      </section>
      <section class="wk-isec">
        <h3>Reviews</h3>
        <ul class="wk-evlist">${D.team.reviewers
          .map(
            (x) =>
              `<li>${lpill("quiet", "minus", "Not run")}<span>${esc(agent(x).name)}</span></li>`,
          )
          .join("")}</ul>
      </section>
      <section class="wk-isec">
        <h3>Preview checks at acceptance</h3>
        <p class="wk-hint wk-hint-top">Simulated sample checks recorded ${esc(
          r.at,
        )}. They are not host evidence and prove nothing about the machine.</p>
        <ul class="wk-checks">${it.checks.map(checkLine).join("")}</ul>
      </section>
      <section class="wk-isec">
        <h3>Receipt</h3>
        <dl class="wk-kv">
          <dt>Receipt</dt><dd>${esc(r.id)}</dd>
          <dt>Request key</dt><dd class="mono">${esc(r.key)}</dd>
          <dt>Accepted</dt><dd>${esc(r.at)}, local demo time</dd>
          <dt>Batch</dt><dd>${plural(
            r.items.filter((x) => x.result === "accepted").length,
            "item",
          )} queued, ${r.items.filter((x) => x.result !== "accepted").length} not started. Each result stands on its own.</dd>
        </dl>
      </section>`;
  }

  function runDetail(cur) {
    const { r, it } = cur;
    const i = issueById(it.issueId);
    const tabs = [
      ["summary", "Summary"],
      ["execution", "Execution"],
      ["plan", "Plan and decisions"],
      ["evidence", "Evidence"],
    ];
    const body =
      state.runTab === "execution"
        ? runExecution(r, it)
        : state.runTab === "plan"
          ? runPlan(r, it)
          : state.runTab === "evidence"
            ? runEvidence(r, it)
            : runSummary(r, it);
    return `
      <div class="wk-run-head">
        <button type="button" class="btn ghost sm wk-back" id="run-back" data-act="close-run">${icon(
          "chevronLeft",
        )}Receipts</button>
        <p class="wk-meta"><span>${i.id}</span><span>Demo request from receipt ${esc(r.id)}</span><span>Accepted ${esc(
          r.at,
        )}</span></p>
        <h2 id="run-title" tabindex="-1">${esc(i.title)}</h2>
        <div class="wk-pinrow">
          ${lpill("neutral", "history", "Queued (demo)")}
          <span class="wk-pin">${icon("lock")}Pinned to ${mchip(it.machine)}<span class="wk-path">${esc(
            it.repoPath,
          )}</span></span>
        </div>
        <div class="wk-tabs" role="tablist" aria-label="Demo run">
          ${tabs
            .map(
              ([k, l]) =>
                `<button type="button" role="tab" id="rtab-${k}" data-rtab="${k}" aria-selected="${
                  state.runTab === k
                }" aria-controls="rpanel" tabindex="${state.runTab === k ? 0 : -1}">${esc(l)}</button>`,
            )
            .join("")}
        </div>
      </div>
      <div class="wk-run-body" role="tabpanel" id="rpanel" aria-labelledby="rtab-${state.runTab}">${body}</div>`;
  }

  function renderRuns() {
    const el = $("wk-view-runs");
    if (!state.receipts.length) {
      el.dataset.detail = "false";
      el.innerHTML = `<div class="wk-pv"><header class="wk-pv-head"><div><h1 id="runs-title" tabindex="-1">Demo runs</h1></div></header>
        <div class="wk-pv-empty"><p>No demo runs yet. Select issues, create a preview, then start the ready items. They appear here as queued demo requests.</p>
        <div class="wk-row-actions"><button type="button" class="btn" id="runs-go-work" data-act="go-work">Go to Work</button></div></div></div>`;
      return;
    }
    const cur = currentRun();
    el.dataset.detail = state.runDetailOpen ? "true" : "false";
    el.innerHTML = `
      <div class="wk-runs-list" id="wk-runs-list">
        <div class="wk-runs-head">
          <h1 id="runs-title" tabindex="-1">Demo runs</h1>
          <p class="faint">Queued by this page only. No agent runs, and these requests are not added to the Runs page.</p>
        </div>
        ${state.receipts
          .slice()
          .reverse()
          .map((r) => receiptBlock(r, cur))
          .join("")}
      </div>
      <section class="wk-run" id="wk-run" aria-label="Demo run detail">${
        cur
          ? runDetail(cur)
          : '<div class="wk-pv-empty"><p>No request was queued. Every item in these receipts was blocked.</p></div>'
      }</section>`;
  }

  /* Render: all -------------------------------------------------------- */
  const SCROLLERS = ["wk-main", "wk-view-preview", "wk-runs-list", "wk-run"];
  let lastView = null;
  let lastRunKey = null;

  function render(focusId) {
    const active = focusId || (document.activeElement && document.activeElement.id) || null;
    const scroll = {};
    SCROLLERS.concat("wk-insp").forEach((id) => {
      const el = $(id);
      if (el) scroll[id] = el.scrollTop;
    });
    const sameView = lastView === state.view;
    const runKey = state.view === "runs" ? JSON.stringify([state.runSel, state.runTab]) : null;

    renderSteps();
    renderSaveState();
    $("wk-view-work").hidden = state.view !== "work";
    $("wk-view-preview").hidden = state.view !== "preview";
    $("wk-view-runs").hidden = state.view !== "runs";
    $("wk-view-work").dataset.drawer = state.drawer ? "true" : "false";

    const prevInspKey = state.inspKey;
    if (state.view === "work") {
      renderSide();
      renderMain();
      renderInsp();
    } else {
      $("wk-insp").innerHTML = "";
      state.inspKey = "";
    }
    if (state.view === "preview") renderPreview();
    else $("wk-view-preview").innerHTML = "";
    if (state.view === "runs") {
      renderRuns();
      state.highlight = null; // the arrival highlight plays once, not on every re-render
    } else $("wk-view-runs").innerHTML = "";

    // Keep scroll positions across re-renders of the same subject; new subjects start at the top.
    SCROLLERS.forEach((id) => {
      const el = $(id);
      if (!el || scroll[id] == null) return;
      if ((id !== "wk-main" && !sameView) || (id === "wk-run" && runKey !== lastRunKey)) {
        el.scrollTop = 0;
        return;
      }
      el.scrollTop = scroll[id];
    });
    if (
      state.view === "work" &&
      sameView &&
      prevInspKey === state.inspKey &&
      scroll["wk-insp"] != null
    )
      $("wk-insp").scrollTop = scroll["wk-insp"];
    lastView = state.view;
    lastRunKey = runKey;

    const target = active && $(active);
    if (target && !target.disabled && target.offsetParent !== null)
      target.focus({ preventScroll: !focusId });
    else if (focusId) {
      const fb = $("step-" + state.view);
      if (fb) fb.focus();
    }
    syncHash();
  }

  function syncHash() {
    const h = state.view === "work" ? "" : "#" + state.view;
    if (location.hash === h || (!h && !location.hash)) return;
    try {
      history.replaceState(null, "", h || location.pathname + location.search);
    } catch (e) {
      /* file:// may refuse; the hash is only a convenience */
    }
  }

  /* Actions ------------------------------------------------------------- */
  // quiet: keyboard movement through the list keeps the tab and never opens the narrow drawer.
  function inspect(id, opts) {
    if (!issueById(id)) return;
    const quiet = !!(opts && opts.quiet);
    state.focusId = id;
    state.machineOpen = null;
    if (!quiet && state.tab === "selected") state.tab = "details";
    if (!quiet) state.drawer = true;
  }

  function toggleSelect(id, on, focus) {
    if (acceptedItem(id)) return;
    if (on === isSelected(id)) return;
    changeDraft((d) => {
      if (on) d.selected.push(id);
      else dropFromDraft(d, [id]);
    });
    if (on) state.focusId = id;
    render(focus);
  }

  const ACTIONS = {
    "save-draft"() {
      saveDraft();
      render();
    },
    "clear-selection"() {
      if (!state.draft.selected.length) return;
      const n = state.draft.selected.length;
      changeDraft((d) => {
        d.selected = [];
        d.overrides = {};
      });
      render("wk-q");
      toast(`Cleared ${plural(n, "selected issue")}. Save the draft to keep this.`);
    },
    "show-selected"(t) {
      if (t.dataset.id) state.focusId = t.dataset.id;
      state.machineOpen = null;
      state.tab = "selected";
      state.drawer = true;
      render("itab-selected");
      if (t.dataset.id) {
        const el = $("ov-m-" + t.dataset.id);
        if (el) {
          el.scrollIntoView({ block: "nearest" });
          el.focus();
        }
      }
    },
    select(t) {
      toggleSelect(t.dataset.id, true, "d-deselect");
    },
    deselect(t) {
      const id = t.dataset.id;
      const fromList = state.tab === "selected";
      const ids = orderedSelected();
      const next = ids[ids.indexOf(id) + 1] || ids[ids.indexOf(id) - 1];
      toggleSelect(id, false, fromList ? (next ? "si-rm-" + next : "itab-selected") : "d-select");
      toast(`${id} removed from the selection.`);
    },
    "apply-fix"(t) {
      const id = t.dataset.id;
      const mid = t.dataset.machine;
      changeDraft((d) => {
        const o = Object.assign({}, d.overrides[id]);
        if (mid === d.defaults.machine) delete o.machine;
        else o.machine = mid;
        if (o.machine || o.implementer) d.overrides[id] = o;
        else delete d.overrides[id];
      });
      render("ov-m-" + id);
      toast(`${id} now runs on ${machineById(mid).name}. Preview again to check it.`);
    },
    "create-preview"() {
      if (!state.draft.selected.length) {
        toast("Select at least one issue first.");
        return;
      }
      state.preview = buildPreview();
      state.view = "preview";
      render("pv-title");
    },
    start() {
      startDemo();
    },
    "go-work"() {
      state.view = "work";
      render("step-work");
    },
    "fix-in-work"(t) {
      state.view = "work";
      state.focusId = t.dataset.id;
      state.machineOpen = null;
      state.tab = "selected";
      state.drawer = true;
      render("ov-m-" + t.dataset.id);
      const el = $("ov-m-" + t.dataset.id);
      if (el) el.scrollIntoView({ block: "nearest" });
    },
    "open-receipt"(t) {
      openReceipt(t.dataset.receipt);
    },
    "save-plan"(t) {
      savePlan(t.dataset.id);
      render();
    },
    "discard-plan"(t) {
      delete state.planEdits[t.dataset.id];
      render();
      toast("Plan edits discarded.");
    },
    "save-decision"(t) {
      saveDecision(t.dataset.id);
      render();
    },
    "close-drawer"() {
      state.drawer = false;
      render("tt-" + state.focusId);
    },
    "close-machine"() {
      closeMachine();
    },
    "close-run"() {
      const cur = currentRun();
      state.runDetailOpen = false;
      render(cur ? `ri-${cur.r.id}-${cur.it.issueId}` : "runs-title");
    },
    "clear-filters"() {
      state.q = "";
      state.wf = "all";
      state.label = "all";
      render("wk-q");
    },
  };

  function closeMachine() {
    const mid = state.machineOpen;
    state.machineOpen = null;
    if (narrow()) state.drawer = false;
    render(mid ? "mb-" + mid : null);
  }

  function selectVisible(on) {
    const list = filteredIssues().filter((i) => !acceptedItem(i.id));
    const changed = list.filter((i) => isSelected(i.id) !== on).map((i) => i.id);
    if (!changed.length) return render("wk-selvis");
    changeDraft((d) => {
      if (on) changed.forEach((id) => d.selected.push(id));
      else dropFromDraft(d, changed);
    });
    render("wk-selvis");
    const notLoaded = D.tracker.total - D.tracker.loaded;
    toast(
      on
        ? `Selected ${plural(changed.length, "visible issue")}. Issues outside the filters and the ${notLoaded} not loaded were not selected.`
        : `Cleared ${plural(changed.length, "visible issue")}. Selected issues hidden by filters were kept.`,
    );
  }

  /* Reset popover ------------------------------------------------------- */
  function openReset() {
    $("wk-reset-pop").hidden = false;
    $("wk-reset").setAttribute("aria-expanded", "true");
    $("wk-reset-cancel").focus();
  }
  function closeReset(refocus) {
    $("wk-reset-pop").hidden = true;
    $("wk-reset").setAttribute("aria-expanded", "false");
    if (refocus) $("wk-reset").focus();
  }
  function doReset() {
    clearNamespace();
    state = load();
    closeReset(false);
    render("wk-reset");
    toast("Work demo reset. The theme and other pages were not changed.");
  }

  /* Events -------------------------------------------------------------- */
  function onClick(e) {
    const t = e.target;
    if (!t.closest(".wk-reset-anchor") && !$("wk-reset-pop").hidden) closeReset(false);

    const el = t.closest(
      "[data-act],[data-view],[data-inspect],[data-machine],[data-openrun],[data-wf],[data-tab],[data-rtab]",
    );
    if (el) {
      if (el.disabled) return;
      const ds = el.dataset;
      if (ds.act && ACTIONS[ds.act]) return ACTIONS[ds.act](el);
      if (ds.view) {
        state.view = ds.view;
        return render("step-" + ds.view);
      }
      if (ds.inspect) {
        inspect(ds.inspect);
        return render(el.id);
      }
      if (ds.machine) {
        state.machineOpen = state.machineOpen === ds.machine && !narrow() ? null : ds.machine;
        state.drawer = !!state.machineOpen;
        return render(state.machineOpen ? "mach-close" : el.id);
      }
      if (ds.openrun) {
        const parts = ds.openrun.split("|");
        state.view = "runs";
        state.runSel = { receipt: parts[0], issue: parts[1] };
        const fromRuns = el.classList.contains("wk-ritem");
        state.runDetailOpen = true;
        if (!fromRuns) state.runTab = "summary";
        return render(fromRuns && !narrow() ? el.id : "run-title");
      }
      if (ds.wf) {
        state.wf = ds.wf;
        return render(el.id);
      }
      if (ds.tab) {
        state.tab = ds.tab;
        return render("itab-" + ds.tab);
      }
      if (ds.rtab) {
        state.runTab = ds.rtab;
        return render("rtab-" + ds.rtab);
      }
    }
    // Clicking a row's empty space inspects it; controls inside the row handle themselves.
    if (t.closest("input,select,textarea,label,a,button")) return;
    const row = t.closest("[data-row]");
    if (row) {
      inspect(row.dataset.row);
      render("tt-" + row.dataset.row);
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.cb) return toggleSelect(t.dataset.cb, t.checked, t.id);
    if (t.id === "wk-selvis") return selectVisible(t.checked);
    if (t.id === "wk-label") {
      state.label = t.value;
      return render(t.id);
    }
    if (t.dataset.def) {
      const k = t.dataset.def;
      changeDraft((d) => {
        d.defaults[k] = t.value;
      });
      return render(t.id);
    }
    if (t.dataset.ov) {
      const id = t.dataset.id;
      const k = t.dataset.ov;
      changeDraft((d) => {
        const o = Object.assign({}, d.overrides[id]);
        if (t.value) o[k] = t.value;
        else delete o[k];
        if (o.machine || o.implementer) d.overrides[id] = o;
        else delete d.overrides[id];
      });
      return render(t.id);
    }
    if (t.dataset.decision) {
      state.decisionEdits[t.dataset.decision] = t.value;
      const btn = $("dec-save-" + t.dataset.ctx);
      const d = decisionOf(t.dataset.decision);
      if (btn) btn.disabled = !!d && d.option === t.value;
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.id === "wk-q") {
      state.q = t.value;
      return render(t.id);
    }
    if (t.dataset.plan) {
      const id = t.dataset.plan;
      const ctx = t.dataset.ctx;
      state.planEdits[id] = t.value;
      const dirty = t.value !== planOf(id).text;
      if (!dirty) delete state.planEdits[id];
      const st = $("plan-state-" + ctx);
      if (st) st.textContent = dirty ? "Unsaved edits" : "";
      ["plan-save-", "plan-discard-"].forEach((p) => {
        const b = $(p + ctx);
        if (b) b.disabled = !dirty;
      });
    }
  }

  function onListKey(e) {
    const t = e.target;
    const row = t.closest("[data-row]");
    if (!row) return;
    const rows = Array.from($("wk-list").querySelectorAll("[data-row]"));
    const idx = rows.indexOf(row);
    const onCb = t.classList.contains("wk-cb");
    const cb = row.querySelector(".wk-cb");
    let n = null;
    if (e.key === "ArrowDown") n = Math.min(rows.length - 1, idx + 1);
    else if (e.key === "ArrowUp") n = Math.max(0, idx - 1);
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = rows.length - 1;
    else if ((e.key === "x" || e.key === "X") && !e.metaKey && !e.ctrlKey) {
      if (cb && !cb.disabled) {
        e.preventDefault();
        toggleSelect(row.dataset.row, !cb.checked, t.id);
      }
      return;
    } else if (e.key === "ArrowRight" && onCb) {
      e.preventDefault();
      row.querySelector(".wk-title").focus();
      return;
    } else if (e.key === "ArrowLeft" && !onCb) {
      if (cb && !cb.disabled) {
        e.preventDefault();
        cb.focus();
      }
      return;
    }
    if (n === null) return;
    e.preventDefault();
    const target = rows[n];
    const tcb = target.querySelector(".wk-cb");
    const el = onCb && tcb && !tcb.disabled ? tcb : target.querySelector(".wk-title");
    // Moving through the list follows with the inspector, without opening the narrow drawer.
    if (target.dataset.row !== state.focusId) {
      inspect(target.dataset.row, { quiet: true });
      render(el.id);
    } else el.focus();
  }

  function onKey(e) {
    const t = e.target;
    const tag = (t.tagName || "").toLowerCase();
    const typing =
      tag === "textarea" ||
      tag === "select" ||
      (tag === "input" && t.type !== "checkbox" && t.type !== "radio");

    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      if (t.dataset && t.dataset.plan) {
        if (state.planEdits[t.dataset.plan] != null) {
          savePlan(t.dataset.plan);
          render(t.id);
        } else toast("No plan edits to save.");
        return;
      }
      if (draftStatus().dirty) {
        saveDraft();
        render();
      } else toast("The draft has no unsaved changes.");
      return;
    }

    if (t.getAttribute && t.getAttribute("role") === "tab") {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
      if (keys.indexOf(e.key) >= 0) {
        const tabs = Array.from(t.parentElement.querySelectorAll('[role="tab"]'));
        let i = tabs.indexOf(t);
        if (e.key === "Home") i = 0;
        else if (e.key === "End") i = tabs.length - 1;
        else i = (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        e.preventDefault();
        tabs[i].click();
        return;
      }
    }

    if (e.key === "/" && !typing && state.view === "work") {
      e.preventDefault();
      $("wk-q").focus();
      return;
    }

    if (e.key === "Escape") {
      if (!$("wk-reset-pop").hidden) return closeReset(true);
      if (t.id === "wk-q" && state.q) {
        state.q = "";
        return render("wk-q");
      }
      if (state.view === "work" && state.machineOpen) return closeMachine();
      if (state.view === "work" && state.drawer && narrow()) return ACTIONS["close-drawer"]();
      if (state.view === "runs" && state.runDetailOpen && narrow()) return ACTIONS["close-run"]();
    }
  }

  /* Init ---------------------------------------------------------------- */
  function load() {
    const s = {
      view: "work",
      q: "",
      wf: "all",
      label: "all",
      focusId: SHARED_ID,
      tab: "details",
      machineOpen: null,
      drawer: false,
      draft: emptyDraft(),
      savedJson: null,
      savedAt: null,
      plans: {},
      planEdits: {},
      decisionEdits: {},
      receipts: [],
      preview: null,
      runSel: null,
      runTab: "summary",
      runDetailOpen: false,
      highlight: null,
      inspKey: "",
    };
    state = s;
    s.receipts = sanitizeReceipts(readJson(KEY.receipts));
    s.plans = sanitizePlans(readJson(KEY.plans));
    const raw = readJson(KEY.draft);
    if (raw) {
      const d = sanitizeDraft(raw);
      dropFromDraft(
        d,
        d.selected.filter((id) => acceptedItem(id)),
      );
      s.draft = d;
      s.savedJson = canonical(d);
      s.savedAt = typeof raw.savedAt === "string" ? raw.savedAt.slice(0, 24) : null;
    }
    return s;
  }

  NK.onReady(() => {
    state = load();
    buildMainShell();
    let h = "";
    try {
      h = decodeURIComponent(location.hash.slice(1));
    } catch (e) {
      h = "";
    }
    if (h === "preview" || h === "runs") state.view = h;
    else if (issueById(h)) state.focusId = h;

    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);
    $("wk-list").addEventListener("keydown", onListKey);
    $("wk-reset").addEventListener("click", (e) => {
      e.stopPropagation();
      if ($("wk-reset-pop").hidden) openReset();
      else closeReset(true);
    });
    $("wk-reset-cancel").addEventListener("click", () => closeReset(true));
    $("wk-reset-confirm").addEventListener("click", doReset);
    render();
  });
})();
