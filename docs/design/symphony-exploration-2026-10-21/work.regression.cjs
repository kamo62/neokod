/* Deterministic two-context regression for the Work demo receipt store.
   Run: node work.regression.cjs

   It loads the real work-data.js and work.js in two isolated VM contexts that share one
   localStorage stub and one Web Locks stub, exactly like two tabs of one origin. The injected
   audit surface calls the page's own load(), buildPreview(), startDemo(), lifecycle
   reconciliation and startGuard(). Assertions read the persisted storage, not private state.
   No browser, tracker, server, provider, machine or file outside this check is touched. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const here = __dirname;
const RECEIPTS_KEY = "neokod-symphony-proto:work:receipts";

function makeStorage() {
  const data = new Map();
  const api = {
    data,
    failKey: null,
    failRemove: false,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (api.failKey === key) throw new Error("simulated quota failure");
      data.set(key, String(value));
    },
    removeItem(key) {
      if (api.failRemove) throw new Error("simulated removal failure");
      data.delete(key);
    },
    key(i) {
      return Array.from(data.keys())[i] ?? null;
    },
    clear() {
      data.clear();
    },
    get length() {
      return data.size;
    },
    read(key) {
      return data.has(key) ? JSON.parse(data.get(key)) : null;
    },
    raw(key) {
      return data.has(key) ? data.get(key) : null;
    },
  };
  return api;
}

// One origin-wide Web Locks queue, shared by every context. Requests run in call order and
// never overlap, which is the guarantee the page relies on.
function makeLocks() {
  let queue = Promise.resolve();
  return {
    request(name, options, callback) {
      const run = queue.then(() => callback({ name, mode: options && options.mode }));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

function makeTab({ storage, locks, crypto }) {
  const noop = () => {};
  const elements = new Map();
  const makeEl = (id) => ({
    id,
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    dataset: {},
    setAttribute() {},
    focus() {},
    appendChild() {},
    insertBefore() {},
    querySelector() {
      return makeEl("child");
    },
  });
  const context = vm.createContext({
    console,
    Date,
    JSON,
    Array,
    Object,
    Number,
    String,
    Promise,
    Set,
    Map,
    Math,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    localStorage: storage,
    crypto,
    navigator: locks ? { locks } : {},
    NK: {
      icon: () => "",
      esc: (x) => String(x == null ? "" : x),
      toast: noop,
      onReady: noop,
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeEl(id));
        return elements.get(id);
      },
      createElement(tag) {
        return makeEl(tag);
      },
      addEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      readyState: "complete",
      activeElement: null,
    },
    window: null,
  });
  context.window = context;
  context.matchMedia = () => ({ matches: false });
  for (const file of ["fixtures.js", "work-data.js"]) {
    vm.runInContext(fs.readFileSync(path.join(here, file), "utf8"), context, { filename: file });
  }
  const source = fs.readFileSync(path.join(here, "work.js"), "utf8").replace(
    /\}\)\(\);\s*$/,
    `  render = () => {};
  window.audit = {
    load,
    get: () => state,
    select(ids) {
      state.draft.selected = ids.slice();
      state.draft.revision += 1;
    },
    overrideIssue(id, patch) {
      state.draft.overrides[id] = Object.assign({}, state.draft.overrides[id], patch);
      state.draft.revision += 1;
    },
    preview() {
      state.preview = buildPreview();
      return state.preview;
    },
    start(outcome) {
      return startDemo(outcome);
    },
    guard: () => startGuard(),
    active: (id) => activeItem(id),
    receiptsError: () => state.receiptsError,
    saveDraft,
    setScope,
    persistContext,
    persistRecovery,
    discardRecovery,
    staleReason,
    bumpSource(id) { scopeById(id).scope.revision += 1; },
    setDefaults(patch) {
      Object.assign(state.draft.defaults, patch);
      state.draft.revision += 1;
    },
    scopeStatus() {
      return scopeStatusText(scopeInfo());
    },
    requestWithdrawal,
    reconcileUnknown,
    reconcileWithdrawal,
    openReset,
    doReset,
    renderSummary(receiptId, issueId) {
      const r = receiptById(receiptId);
      const it = r && r.items.find((x) => x.issueId === issueId);
      if (!it) throw new Error("receipt item not found");
      return runSummary(r, it);
    },
    renderExecution(receiptId, issueId) {
      const r = receiptById(receiptId);
      const it = r && r.items.find((x) => x.issueId === issueId);
      if (!it) throw new Error("receipt item not found");
      return runExecution(r, it);
    },
  };
})();`,
  );
  vm.runInContext(source, context, { filename: "work.js" });
  const audit = context.audit;
  audit.load();
  return audit;
}

function receiptIds(storage) {
  const receipts = storage.read(RECEIPTS_KEY) || [];
  return receipts.map((r) => r.id);
}

function itemsFor(storage, issueId) {
  const receipts = storage.read(RECEIPTS_KEY) || [];
  return receipts.flatMap((r) => r.items.filter((i) => i.issueId === issueId));
}

async function main() {
  const storage = makeStorage();
  const locks = makeLocks();
  const crypto = require("node:crypto").webcrypto;
  assert.equal(typeof crypto.randomUUID, "function", "Node webcrypto must provide randomUUID");
  const tab = (opts = {}) =>
    makeTab({ storage, locks: opts.locks === false ? null : locks, crypto });

  /* 1. Two stale tabs race the same issue. Exactly one admission is persisted. */
  storage.clear();
  const a = tab();
  const b = tab();
  a.select(["NEO-4830"]);
  b.select(["NEO-4830"]);
  const pva = a.preview();
  const pvb = b.preview();
  assert.equal(pva.key, pvb.key, "same approved inputs should produce the same request key");
  assert.equal(pva.items[0].ready, true, "NEO-4830 is ready on Sample Mac in the fixture");
  const same = await Promise.all([a.start("accepted"), b.start("accepted")]);
  const sameReceipts = storage.read(RECEIPTS_KEY);
  assert.equal(sameReceipts.length, 1, "racing the same request must persist one receipt");
  assert.equal(sameReceipts[0].items[0].source.scopeId, "scope_neo_open");
  assert.equal(
    tab().get().receipts[0].items[0].source.scopeId,
    "scope_neo_open",
    "source snapshot survives reload",
  );
  assert.equal(
    tab().get().receipts[0].items[0].issueTitle,
    "Flag ACP sessions that go silent mid-turn",
    "issue title survives reload independently of plan text",
  );
  assert.equal(
    itemsFor(storage, "NEO-4830").filter((i) => i.result === "accepted").length,
    1,
    "racing stale tabs must yield exactly one accepted admission",
  );
  assert.ok(
    same.every((r) => r.ok),
    "both callers get the recorded admission",
  );
  assert.equal(same[0].receiptId, same[1].receiptId, "replay returns the same receipt");
  assert.match(same[0].receiptId, /^R-[0-9a-f]{8}-[0-9a-f]{4}-/, "receipt id is a UUID");
  assert.equal(
    same.reduce((n, r) => n + r.accepted, 0),
    1,
    "only one caller is told a new item was accepted",
  );

  /* 1b. Two different requests for the same issue race. Only one admission wins, even with
     distinct request keys, because the check and write share the lock. */
  storage.clear();
  const a2 = tab();
  const b2 = tab();
  a2.select(["NEO-4830"]);
  b2.select(["NEO-4830"]);
  b2.overrideIssue("NEO-4830", { implementer: "sol", effort: "high" });
  const pvA2 = a2.preview();
  const pvB2 = b2.preview();
  assert.notEqual(pvA2.key, pvB2.key, "different targets use different request keys");
  const race = await Promise.all([a2.start("accepted"), b2.start("accepted")]);
  assert.equal(race.filter((r) => r.ok).length, 1, "one request for the issue is admitted");
  assert.equal(
    itemsFor(storage, "NEO-4830").filter((i) => i.result === "accepted").length,
    1,
    "the losing different-key request does not accept the same issue",
  );
  assert.equal(storage.read(RECEIPTS_KEY).length, 1, "the loser writes no competing receipt");

  /* 2. Two stale tabs race different issues. Both receipts survive. */
  storage.clear();
  const c = tab();
  const d = tab();
  c.select(["NEO-4830"]);
  d.select(["NEO-4833"]);
  c.preview();
  d.preview();
  const both = await Promise.all([c.start("accepted"), d.start("accepted")]);
  assert.ok(
    both.every((r) => r.ok),
    "independent issues both start",
  );
  const different = storage.read(RECEIPTS_KEY);
  assert.equal(different.length, 2, "neither tab overwrites the other receipt");
  assert.equal(itemsFor(storage, "NEO-4830").filter((i) => i.result === "accepted").length, 1);
  assert.equal(itemsFor(storage, "NEO-4833").filter((i) => i.result === "accepted").length, 1);
  assert.notEqual(both[0].receiptId, both[1].receiptId, "receipt IDs do not collide");
  assert.equal(new Set(receiptIds(storage)).size, 2, "both receipt IDs are unique");

  /* 3. Unknown acknowledgement persists a reservation and fences other tabs. */
  storage.clear();
  const e = tab();
  const f = tab();
  e.select(["NEO-4830"]);
  f.select(["NEO-4830"]);
  f.overrideIssue("NEO-4830", { implementer: "sol", effort: "high" });
  const pvUnknown = e.preview();
  const pvElsewhere = f.preview();
  assert.notEqual(pvElsewhere.key, pvUnknown.key, "the other tab prepared a different target");
  const unknown = await e.start("unknown");
  assert.ok(unknown.ok, "the simulated unknown acknowledgement is recorded");
  const unknownItems = itemsFor(storage, "NEO-4830");
  assert.equal(unknownItems.length, 1);
  assert.equal(unknownItems[0].result, "unknown");
  assert.equal(unknownItems[0].reservation.requestKey, pvUnknown.key, "same request key kept");
  assert.equal(unknownItems[0].reservation.machine, "mac", "target reservation kept");
  assert.equal(unknownItems[0].reservation.state, "unresolved");
  assert.ok(e.active("NEO-4830"), "unknown stays reserved in its own tab");
  const fenced = await f.start("accepted");
  assert.equal(fenced.ok, false, "a second tab cannot start the reserved issue");
  assert.equal(
    storage.read(RECEIPTS_KEY).length,
    1,
    "fenced start writes no second receipt or duplicate admission",
  );
  assert.equal(
    itemsFor(storage, "NEO-4830").filter((i) => i.result === "accepted").length,
    0,
    "unknown is not silently converted to accepted",
  );

  // An explicit simulated authoritative answer resolves it; acceptance is not a relaunch.
  await e.reconcileUnknown(unknown.receiptId, "NEO-4830", "accepted");
  const unknownAccepted = itemsFor(storage, "NEO-4830")[0];
  assert.equal(unknownAccepted.resolution.outcome, "accepted");
  assert.equal(unknownAccepted.reservation.state, "resolved");
  assert.equal(storage.read(RECEIPTS_KEY).length, 1, "reconciliation writes no new receipt");
  const acceptedSummary = e.renderSummary(unknown.receiptId, "NEO-4830");
  assert.ok(
    acceptedSummary.includes("authority acceptance"),
    "Summary renders the resolved acceptance, not the historical unknown state",
  );
  assert.ok(
    !acceptedSummary.includes("Acknowledgement unknown (simulated). Nothing is running"),
    "Summary does not keep claiming acknowledgement unknown after resolution",
  );
  const acceptedExecution = e.renderExecution(unknown.receiptId, "NEO-4830");
  assert.ok(
    acceptedExecution.includes("Queued (demo)"),
    "Execution shows the resolved request as queued",
  );
  assert.ok(
    !acceptedExecution.includes("Unknown acknowledgement; not started"),
    "Execution does not claim the resolved request is unstarted-unknown",
  );

  /* 4. Withdrawal requested is not closure; only confirmed closure unlocks. */
  await e.requestWithdrawal(unknown.receiptId, "NEO-4830");
  let item = itemsFor(storage, "NEO-4830")[0];
  assert.equal(item.lifecycle, "withdrawal_requested");
  assert.ok(e.active("NEO-4830"), "withdrawal requested must keep the reservation");
  assert.ok(
    e.renderSummary(unknown.receiptId, "NEO-4830").includes("Withdrawal requested"),
    "Summary renders the withdrawal request",
  );

  await e.reconcileWithdrawal(unknown.receiptId, "NEO-4830", "unknown");
  item = itemsFor(storage, "NEO-4830")[0];
  assert.equal(item.lifecycle, "closure_unknown");
  assert.ok(e.active("NEO-4830"), "closure unknown must keep the reservation");
  assert.ok(
    e.renderSummary(unknown.receiptId, "NEO-4830").includes("Closure is unknown"),
    "Summary renders closure unknown rather than closure",
  );

  await e.reconcileWithdrawal(unknown.receiptId, "NEO-4830", "closed");
  item = itemsFor(storage, "NEO-4830")[0];
  assert.equal(item.lifecycle, "closed");
  assert.ok(item.closureAt, "confirmed closure has a timestamp");
  assert.equal(e.active("NEO-4830"), null, "confirmed closure unlocks the issue");
  assert.equal(storage.read(RECEIPTS_KEY).length, 1, "accepted history is retained after closure");
  const closedSummary = e.renderSummary(unknown.receiptId, "NEO-4830");
  assert.ok(
    closedSummary.includes("Closed after a simulated confirmed closure"),
    "Summary renders confirmed closure",
  );
  assert.ok(
    !closedSummary.includes("Acknowledgement unknown (simulated). Nothing is running"),
    "Summary does not retain the stale unknown claim after closure",
  );
  assert.ok(
    e.renderExecution(unknown.receiptId, "NEO-4830").includes("Not started (closed)"),
    "Execution renders the closed request without inventing queued stages",
  );

  // A new request after closure links to the closed one and stays a separate receipt.
  const g = tab();
  g.select(["NEO-4830"]);
  const pvNext = g.preview();
  assert.equal(
    pvNext.items[0].previous.receipt,
    unknown.receiptId,
    "new request links to the old one",
  );
  const next = await g.start("accepted");
  assert.ok(next.ok);
  assert.equal(storage.read(RECEIPTS_KEY).length, 2, "closed history plus the linked new request");
  const newest = itemsFor(storage, "NEO-4830").filter((i) => i.result === "accepted");
  assert.equal(newest.length, 1);
  assert.equal(newest[0].previous.receipt, unknown.receiptId);
  assert.equal(newest[0].machine, "mac");

  // Close the second request too. A third request must link the latest closure (R2), not R1.
  await g.requestWithdrawal(next.receiptId, "NEO-4830");
  await g.reconcileWithdrawal(next.receiptId, "NEO-4830", "closed");
  const h3 = tab();
  h3.select(["NEO-4830"]);
  const pvThird = h3.preview();
  assert.equal(
    pvThird.items[0].previous.receipt,
    next.receiptId,
    "the newest positively closed request is the previous link",
  );
  assert.notEqual(
    pvThird.items[0].previous.receipt,
    unknown.receiptId,
    "an older closure is not used when a newer one exists",
  );
  assert.equal(pvThird.items[0].previous.kind, "closed");

  /* 4b. A positive target refusal permits a new request with a new request key. */
  storage.clear();
  const k = tab();
  k.select(["NEO-4830"]);
  const pvRefused = k.preview();
  const refused = await k.start("refused");
  assert.ok(refused.ok);
  assert.equal(itemsFor(storage, "NEO-4830")[0].result, "refused");
  assert.equal(k.active("NEO-4830"), null, "a positive refusal does not stay reserved");
  const refusedSummary = k.renderSummary(refused.receiptId, "NEO-4830");
  assert.ok(
    refusedSummary.includes("Refused by the sample target"),
    "Summary renders a typed target refusal",
  );
  assert.ok(
    !refusedSummary.includes("Queued in this demo"),
    "Summary does not describe a refused request as queued",
  );
  const pvRetry = k.preview();
  assert.notEqual(pvRetry.key, pvRefused.key, "a new request after refusal uses a new key");
  assert.equal(
    pvRetry.items[0].previous.receipt,
    refused.receiptId,
    "a new request after refusal links the refused request",
  );
  assert.equal(pvRetry.items[0].previous.kind, "refused");
  assert.equal(
    pvRetry.items[0].previous.machine,
    "mac",
    "the refused request's target is retained on the link",
  );
  const retry = await k.start("accepted");
  assert.ok(retry.ok, "a new request is allowed after a positive refusal");
  assert.equal(storage.read(RECEIPTS_KEY).length, 2, "the refused request history is retained");

  /* 5. A failed storage write acknowledges nothing and leaves storage untouched. */
  storage.clear();
  const h = tab();
  h.select(["NEO-4830"]);
  h.preview();
  storage.failKey = RECEIPTS_KEY;
  const failed = await h.start("accepted");
  assert.equal(failed.ok, false, "write failure is not acknowledged as success");
  assert.equal(h.get().receipts.length, 0, "no receipt is invented in memory");
  assert.equal(h.get().preview.receiptId, null, "the preview is not marked recorded");
  assert.equal(storage.raw(RECEIPTS_KEY), null, "nothing was written");
  assert.ok(/write/i.test(failed.reason), "the failure is explicit");
  storage.failKey = null;
  const retried = await h.start("accepted");
  assert.ok(retried.ok, "a retry after the storage recovers succeeds");
  assert.equal(storage.read(RECEIPTS_KEY).length, 1);
  assert.match(retried.receiptId, /^R-[0-9a-f]{8}-[0-9a-f]{4}-/, "retry allocates a UUID receipt");

  /* 6. Corrupt stored receipts are surfaced, never replaced with empty history. */
  storage.clear();
  const corrupt = "{not json";
  storage.setItem(RECEIPTS_KEY, corrupt);
  const i = tab();
  assert.ok(i.receiptsError(), "corrupt storage is an explicit error");
  assert.equal(i.guard().ok, false, "Start is disabled while storage is unreadable");
  const blocked = await i.start("accepted");
  assert.equal(blocked.ok, false);
  assert.equal(
    storage.raw(RECEIPTS_KEY),
    corrupt,
    "corrupt storage is left byte-for-byte untouched",
  );

  /* 7. No Web Locks means no admission, even with working storage. */
  storage.clear();
  const j = tab({ locks: false });
  j.select(["NEO-4830"]);
  j.preview();
  assert.equal(j.guard().ok, false, "Start is disabled without Web Locks");
  const noLock = await j.start("accepted");
  assert.equal(noLock.ok, false);
  assert.equal(storage.raw(RECEIPTS_KEY), null, "nothing is accepted in memory or storage");

  /* 8. Existing old receipts still load and keep their locks. */
  storage.clear();
  storage.setItem(
    RECEIPTS_KEY,
    JSON.stringify([
      {
        id: "R-1",
        key: "wk-legacy",
        at: "22 Oct 2026, 14:00",
        items: [
          {
            issueId: "NEO-4830",
            result: "accepted",
            machine: "mac",
            implementer: "deepseek",
            effort: "high",
            reviewers: [
              { id: "sol", effort: "high" },
              { id: "opus", effort: "high" },
            ],
            workflow: "providers",
            base: "dev at e19c4d0",
            repoPath: "/Users/sample/code/neokod",
            planRev: 1,
            planText: "legacy plan",
            decision: null,
            checks: [],
          },
        ],
      },
    ]),
  );
  const legacy = tab();
  assert.equal(legacy.get().receipts.length, 1, "old receipt shape is still read");
  assert.equal(legacy.get().receipts[0].id, "R-1");
  assert.equal(legacy.get().receipts[0].items[0].lifecycle, "queued");
  assert.ok(legacy.active("NEO-4830"), "an old accepted receipt still locks the issue");
  legacy.select(["NEO-4830"]);
  legacy.preview();
  const legacyStart = await legacy.start("accepted");
  assert.equal(legacyStart.ok, false, "a locked legacy issue cannot be admitted again");
  assert.equal(storage.read(RECEIPTS_KEY).length, 1);

  /* 9. Reset is locked, verifies the snapshot taken when it opened, and never silently
     reports success after a failed clear. */
  storage.clear();
  const r1 = tab();
  r1.select(["NEO-4830"]);
  r1.preview();
  assert.ok((await r1.start("accepted")).ok);
  r1.openReset();
  const r2 = tab();
  r2.select(["NEO-4833"]);
  r2.preview();
  assert.ok((await r2.start("accepted")).ok);
  assert.equal(storage.read(RECEIPTS_KEY).length, 2);
  const changedReset = await r1.doReset();
  assert.equal(changedReset.ok, false, "reset refuses a stale confirmation");
  assert.equal(storage.read(RECEIPTS_KEY).length, 2, "unseen concurrent admissions are not erased");
  assert.ok(r1.get().receipts.length >= 1, "reset failure does not reset in-memory history");

  r1.openReset();
  storage.failRemove = true;
  const failedClear = await r1.doReset();
  assert.equal(failedClear.ok, false, "a failed clear is not reported as success");
  assert.equal(storage.read(RECEIPTS_KEY).length, 2, "failed clear leaves receipts intact");
  assert.ok(r1.get().receipts.length >= 1, "failed clear does not reset in-memory history");
  storage.failRemove = false;
  const cleared = await r1.doReset();
  assert.equal(cleared.ok, true, "the next confirmed reset succeeds");
  assert.equal(storage.raw(RECEIPTS_KEY), null, "confirmed reset removes the receipt store");
  assert.equal(r1.get().receipts.length, 0, "confirmed reset reloads empty history");

  /* 10. Project defaults carry exact machine-specific provider instance and model pins. */
  storage.clear();
  const p1 = tab();
  const defs = p1.get().draft.defaults;
  assert.equal(defs.machine, "mac");
  assert.equal(defs.instance, "pi_mac_opencode", "initial implementer instance is pinned");
  assert.equal(defs.model, "deepseek/deepseek-flash", "initial implementer model is pinned");
  assert.equal(defs.reviewers[0].instance, "pi_mac_codex", "sol reviewer instance is pinned");
  assert.equal(defs.reviewers[0].model, "gpt-6.1-sol");
  assert.equal(defs.reviewers[1].instance, "pi_mac_claude", "opus reviewer instance is pinned");
  assert.equal(defs.reviewers[1].model, "claude-opus-5-5");
  p1.saveDraft();
  const partialStatus = p1.scopeStatus();
  assert.ok(partialStatus.includes("Partial: 7 of 9"), "partial coverage is explicit");
  p1.get().loadedByScope["scope_neo_open"] = 9;
  const completeStatus = p1.scopeStatus();
  assert.ok(
    completeStatus.includes("Complete: loaded 9 of 9"),
    "full load reports complete coverage",
  );
  assert.ok(!completeStatus.includes("Partial"), "full load is not still labelled partial");
  assert.ok(!completeStatus.includes("on a next page"), "full load reports no remaining page");
  const p2 = tab();
  assert.equal(p2.get().draft.defaults.instance, "pi_mac_opencode", "saved defaults keep the pin");
  assert.equal(p2.get().draft.defaults.model, "deepseek/deepseek-flash");
  assert.equal(p2.get().draft.defaults.reviewers[1].model, "claude-opus-5-5");

  // Changing machine alone blocks the unavailable exact instance instead of resolving another
  // provider by the same profile.
  p2.setDefaults({ machine: "work" });
  p2.select(["NEO-4830"]);
  const pvBlocked = p2.preview();
  assert.equal(pvBlocked.items[0].ready, false, "changing machine blocks the old exact target");
  assert.notEqual(
    pvBlocked.items[0].instance,
    "pi_work_opencode",
    "the pin is not silently replaced by another provider instance",
  );
  assert.equal(
    p2.get().draft.defaults.instance,
    "pi_mac_opencode",
    "the unavailable exact instance stays recorded instead of being substituted",
  );
  assert.ok(
    /pi_mac_opencode/.test(pvBlocked.items[0].blockText || ""),
    "the block names the unavailable exact instance",
  );

  // An explicit choice on the new machine is allowed and pins the work identities.
  p2.setDefaults({
    machine: "work",
    implementer: "sol",
    effort: "high",
    instance: "pi_work_codex",
    model: "gpt-6.1-sol",
    reviewers: [
      { agent: "sol", effort: "high", instance: "pi_work_codex", model: "gpt-6.1-sol" },
      { agent: "opus", effort: "high", instance: "pi_work_claude", model: "claude-opus-5-5" },
    ],
  });
  const pvWork = p2.preview();
  assert.equal(pvWork.items[0].ready, true, "an explicit new-machine target is accepted");
  assert.equal(pvWork.items[0].instance, "pi_work_codex");
  assert.equal(pvWork.items[0].model, "gpt-6.1-sol");

  // Legacy drafts without pins are materialised to the current machine's project defaults.
  storage.clear();
  storage.setItem(
    "neokod-symphony-proto:work:draft",
    JSON.stringify({
      v: 1,
      revision: 1,
      selected: [],
      defaults: {
        machine: "mac",
        implementer: "deepseek",
        effort: "high",
        reviewers: [
          { agent: "sol", effort: "high" },
          { agent: "opus", effort: "high" },
        ],
      },
      overrides: {},
    }),
  );
  const legacyDefaults = tab();
  assert.equal(
    legacyDefaults.get().draft.defaults.instance,
    "pi_mac_opencode",
    "legacy default draft materialises its exact pin",
  );
  assert.equal(
    legacyDefaults.get().draft.defaults.reviewers[0].instance,
    "pi_mac_codex",
    "legacy reviewer defaults materialise exact pins",
  );

  storage.clear();
  storage.setItem(
    "neokod-symphony-proto:work:draft",
    JSON.stringify({
      v: 1,
      revision: 1,
      selected: [],
      defaults: {
        machine: "work",
        implementer: "deepseek",
        effort: "high",
        reviewers: [],
      },
      overrides: {},
    }),
  );
  const legacyWork = tab();
  assert.notEqual(
    legacyWork.get().draft.defaults.instance,
    "pi_mac_opencode",
    "a legacy Work PC default does not inherit Sample Mac's pin",
  );

  // An empty effort for a no-effort model survives reload and remains a valid target.
  storage.clear();
  storage.setItem(
    "neokod-symphony-proto:work:draft",
    JSON.stringify({
      v: 1,
      revision: 2,
      selected: ["NEO-4830"],
      defaults: {
        machine: "mac",
        implementer: "deepseek",
        effort: "high",
        instance: "pi_mac_opencode",
        model: "deepseek/deepseek-flash",
        reviewers: [
          { agent: "sol", effort: "high", instance: "pi_mac_codex", model: "gpt-6.1-sol" },
          { agent: "opus", effort: "high", instance: "pi_mac_claude", model: "claude-opus-5-5" },
        ],
      },
      overrides: {
        "NEO-4830": {
          implementer: "copilot",
          instance: "pi_mac_copilot",
          model: "sample-model-g",
          effort: "",
        },
      },
    }),
  );
  const noEffort = tab();
  assert.equal(
    noEffort.get().draft.overrides["NEO-4830"].effort,
    "",
    "empty effort survives reload",
  );
  const pvNoEffort = noEffort.preview();
  assert.equal(pvNoEffort.items[0].ready, true, "a no-effort model stays startable");
  assert.equal(pvNoEffort.items[0].instance, "pi_mac_copilot");
  assert.equal(pvNoEffort.items[0].model, "sample-model-g");
  assert.equal(pvNoEffort.items[0].effort, null, "no-effort target resolves without an effort");

  const contextTab = tab();
  contextTab.setScope("scope_docs_open");
  contextTab.get().repoByScope.scope_neo_open = "repo_docs_01";
  contextTab.get().loadedByScope.scope_neo_open = 9;
  contextTab.persistContext();
  const contextReload = tab();
  assert.equal(contextReload.get().scopeId, "scope_docs_open");
  assert.equal(contextReload.get().repoByScope.scope_neo_open, "repo_docs_01");
  assert.equal(contextReload.get().loadedByScope.scope_neo_open, 9);

  storage.clear();
  const unsaved = tab();
  unsaved.select(["NEO-4830"]);
  unsaved.persistRecovery();
  const recovered = tab();
  assert.equal(recovered.get().draft.selected[0], "NEO-4830");
  recovered.discardRecovery();
  assert.equal(
    recovered.get().draft.selected.length,
    0,
    "discard without saved draft restores an empty selection",
  );
  assert.equal(storage.getItem("neokod-symphony-proto:work:edits"), null);
  assert.equal(tab().get().draft.selected.length, 0, "discard persists across reload");

  const sourceTab = tab();
  sourceTab.select(["NEO-4830"]);
  sourceTab.setScope("scope_docs_open");
  const mixed = sourceTab.preview();
  assert.equal(
    mixed.items[0].source.scopeId,
    "scope_neo_open",
    "item source remains its actual source, not browsing scope",
  );
  sourceTab.bumpSource("scope_neo_open");
  assert.match(
    sourceTab.staleReason(mixed),
    /source evidence.*changed/,
    "refresh of a selected source invalidates preview even when browsing elsewhere",
  );

  console.log("work.regression.cjs: all receipt-store checks passed");
  console.log("- same issue race: 1 accepted admission, 1 receipt, unique UUID");
  console.log("- same issue with different targets: 1 winner, no competing receipt");
  console.log("- different issues: 2 receipts, both accepted");
  console.log("- refusal: no reservation, new request uses a new key and keeps history");
  console.log(
    "- unknown: reservation kept, other tab fenced, explicit reconciliation, closure gate",
  );
  console.log(
    "- failed write: no in-memory acceptance, storage untouched, retry allocates fresh ID",
  );
  console.log("- corrupt storage: explicit error, Start disabled, bytes untouched");
  console.log("- no Web Locks: Start disabled, nothing persisted");
  console.log("- legacy receipt: still read and still locks the issue");
  console.log(
    "- reset: serialized, stale-confirmation safe, visible failure, keeps concurrent receipts",
  );
  console.log(
    "- rendering: resolved unknown, queued, withdrawn, closure-unknown, closed and refused states",
  );
  console.log(
    "Proof: shared localStorage and Web Locks stubs across two VM contexts running the real work.js. No browser, server, provider, machine or tracker was touched.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
