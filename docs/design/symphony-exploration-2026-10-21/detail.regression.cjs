/* Focused regression for the Symphony static artifacts' shared detail state.
   Runs shared.js in a small VM with a real in-memory localStorage shape.
   This covers the immutable machine identity helpers, the one shared decision and
   approval scope, defensive Work receipt reads, and validated persistence.
   It does not render the pages or prove production admission/execution. */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SHARED = path.join(__dirname, "shared.js");

function boot() {
  const data = new Map();
  const localStorage = {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    key(index) {
      return Array.from(data.keys())[index] || null;
    },
    get length() {
      return data.size;
    },
  };
  const document = {
    readyState: "loading",
    documentElement: {
      classList: {
        toggle() {},
        contains() {
          return false;
        },
        add() {},
        remove() {},
      },
    },
    head: { appendChild() {} },
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return { length: 0 };
    },
    getElementById() {
      return null;
    },
    createElement() {
      return {
        style: {},
        classList: { add() {}, remove() {} },
        setAttribute() {},
        appendChild() {},
      };
    },
  };
  const window = {
    matchMedia() {
      return { matches: false };
    },
    addEventListener() {},
    localStorage,
  };
  window.window = window;
  window.document = document;
  const context = vm.createContext({
    window,
    document,
    localStorage,
    console,
    setTimeout,
    clearTimeout,
    JSON,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    encodeURIComponent,
  });
  vm.runInContext(fs.readFileSync(SHARED, "utf8"), context, { filename: "shared.js" });
  return { NK: window.NK, S: window.NK_SHARED, data, context };
}

/* A narrow page runner for the Runs request detail. It does not emulate a browser
   or CSS; it proves the rendered request selection and tab markup/URL state. */
function runRunsPage(seedData, search) {
  const els = new Map();
  const listeners = {};
  const makeEl = () => ({
    tagName: "DIV",
    innerHTML: "",
    textContent: "",
    hidden: false,
    dataset: {},
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    appendChild() {},
    insertBefore() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    contains() {
      return false;
    },
    closest() {
      return null;
    },
    focus() {},
    setPointerCapture() {},
    clientWidth: 1000,
    clientHeight: 800,
    scrollLeft: 0,
    scrollTop: 0,
  });
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, makeEl());
    return els.get(id);
  };
  const document = {
    readyState: "complete",
    documentElement: makeEl(),
    head: makeEl(),
    body: makeEl(),
    activeElement: null,
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById(id) {
      return getEl(id);
    },
    createElement() {
      return makeEl();
    },
  };
  const data = seedData instanceof Map ? seedData : new Map();
  const localStorage = {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    key(index) {
      return Array.from(data.keys())[index] || null;
    },
    get length() {
      return data.size;
    },
  };
  const location = { search: search || "", hash: "", pathname: "/runs.html" };
  const history = {
    replaceState(_state, _title, href) {
      const url = new URL(href, "http://localhost/runs.html");
      location.search = url.search;
      location.hash = url.hash;
      location.pathname = url.pathname;
    },
  };
  const window = {
    matchMedia() {
      return { matches: false };
    },
    addEventListener() {},
    localStorage,
    location,
    history,
    document,
    URLSearchParams,
  };
  window.window = window;
  const context = vm.createContext({
    window,
    document,
    localStorage,
    location,
    history,
    URLSearchParams,
    URL,
    console,
    setTimeout,
    clearTimeout,
    JSON,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Map,
    Set,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseInt,
    Infinity,
    NaN,
  });
  for (const file of ["shared.js", "fixtures.js", "runs.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context, {
      filename: file,
    });
  }
  return {
    data,
    location,
    html: (id) => getEl(id).innerHTML,
    click(target) {
      const fake = {
        target: Object.assign(target, {
          closest(selector) {
            return selector.indexOf("data-rtab") >= 0 ? fake.target : null;
          },
        }),
      };
      (listeners.click || []).forEach((fn) => fn(fake));
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("machine ids stay fixed and labels only change presentation", () => {
  const { NK } = boot();
  assert.equal(NK.machine("work").id, "work");
  const chip = NK.machineChip("work");
  assert.match(chip, /data-machine-id="work"/);
  assert.match(chip, /Work PC/);
  assert.match(chip, /class="nk-mid">work</);
  assert.equal(NK.machineLabel("work"), "Work PC");
  assert.equal(NK.machineLabel("missing"), "Unknown machine");
  assert.equal(NK.runMachine("NEO-4838"), "work");
  assert.equal(NK.runMachine("NEO-4821"), "mac");
});

test("one shared saved decision is visible to every page", () => {
  const { S } = boot();
  const res = S.update((s) => {
    s.decisions["D-3"] = {
      draft: null,
      note: "Keep the identity",
      saved: { option: "keep", note: "Keep the identity", at: "14:31", by: "You" },
    };
  });
  assert.equal(res.ok, true);
  assert.equal(res.state.resumeApproval, null);
  const reloaded = S.load().state;
  assert.equal(reloaded.decisions["D-3"].saved.option, "keep");
  assert.equal(reloaded.decisions["D-3"].saved.at, "14:31");
  assert.equal(reloaded.resumeApproval, null);
});

test("approval scope is pinned to machine, item, attempt, plan, head and decision", () => {
  const { NK } = boot();
  const approval = {
    rev: 5,
    itemId: "NEO-4821",
    attempt: 3,
    machine: "mac",
    head: "7f3a9c2",
    decisionAt: "14:31",
    state: "approved",
  };
  const ctx = {
    itemId: "NEO-4821",
    attempt: 3,
    planRev: 5,
    machine: "mac",
    head: "7f3a9c2",
    decisionAt: "14:31",
  };
  assert.equal(NK.scopeProblem(approval, ctx), null);
  assert.match(
    NK.scopeProblem(Object.assign({}, approval, { state: "superseded" }), ctx),
    /superseded|no longer in force/,
  );
  assert.match(NK.scopeProblem(approval, Object.assign({}, ctx, { planRev: 6 })), /Plan r6/);
  assert.match(NK.scopeProblem(approval, Object.assign({}, ctx, { attempt: 2 })), /attempt 3/);
  assert.match(
    NK.scopeProblem(approval, Object.assign({}, ctx, { machine: "work" })),
    /Sample Mac \(mac\)/,
  );
  assert.match(
    NK.scopeProblem(approval, Object.assign({}, ctx, { decisionAt: "14:40" })),
    /saved decision/,
  );
  assert.match(
    NK.scopeProblem(approval, Object.assign({}, ctx, { head: "aaaaaaa" })),
    /head 7f3a9c2/,
  );
});

test("editing the plan invalidates the stored matching approval", () => {
  const { NK, S } = boot();
  const before = S.load().state;
  assert.equal(
    NK.scopeProblem(before.plan.approval, {
      itemId: "NEO-4821",
      attempt: 3,
      planRev: before.plan.current,
      machine: "mac",
      head: "7f3a9c2",
    }),
    null,
  );

  S.update((s) => {
    s.plan.revisions = [
      { rev: 6, by: "You", at: "14:40", note: "Edited by you", text: "# Changed plan" },
    ];
    s.plan.current = 6;
    s.plan.approval = Object.assign({}, s.plan.approval, {
      state: "superseded",
      reason: "Plan changed to r6",
    });
    s.plan.draft = { baseRev: 6, text: "# Draft", at: "14:41" };
  });
  const after = S.load().state;
  assert.equal(after.plan.current, 6);
  assert.equal(after.plan.revisions[0].rev, 6);
  assert.equal(after.plan.draft.text, "# Draft");
  assert.equal(after.plan.approval.state, "superseded");
  assert.match(
    NK.scopeProblem(after.plan.approval, {
      itemId: "NEO-4821",
      attempt: 3,
      planRev: after.plan.current,
      machine: "mac",
      head: "7f3a9c2",
    }),
    /Plan changed to r6|Plan r6/,
  );
});

test("Work receipts are read defensively without trusting unknown fields", () => {
  const { S, data } = boot();
  data.set(
    S.WORK_RECEIPTS_KEY,
    JSON.stringify([
      {
        id: "R-1",
        key: "wk-1",
        at: "14:40",
        items: [
          {
            issueId: "NEO-4821",
            result: "accepted",
            machine: "work",
            planRev: 3,
            lifecycle: "withdrawal_requested",
            resolution: { outcome: "accepted", at: "14:41" },
            instance: "opencode-acp",
            instanceName: "OpenCode ACP",
            model: "deepseek-v4.1-flash",
            modelName: "DeepSeek V4.1 Flash",
            effort: "high",
            effortRequired: true,
            gate: {
              kind: "blocking",
              stage: "build",
              status: "decided",
              question: "Proceed after the gate?",
              decision: "yes",
              decisionLabel: "Yes, proceed",
              decisionRev: 3,
              note: "Saved answer",
            },
          },
          { issueId: "NEO-4821", result: "not-a-result", machine: "mac" },
          { result: "accepted", machine: "mac" },
        ],
      },
      { id: "bad" },
    ]),
  );
  const read = S.workReceipts();
  assert.equal(read.receipts.length, 1);
  assert.equal(read.receipts[0].id, "R-1");
  assert.equal(read.receipts[0].items.length, 1);
  assert.equal(read.receipts[0].items[0].result, "accepted");
  assert.equal(read.receipts[0].items[0].machine, "work");
  assert.equal(read.receipts[0].items[0].lifecycle, "withdrawal_requested");
  assert.equal(read.receipts[0].items[0].resolution.outcome, "accepted");
  assert.equal(read.receipts[0].items[0].resolution.at, "14:41");
  assert.equal(read.receipts[0].items[0].instance, "opencode-acp");
  assert.equal(read.receipts[0].items[0].instanceName, "OpenCode ACP");
  assert.equal(read.receipts[0].items[0].model, "deepseek-v4.1-flash");
  assert.equal(read.receipts[0].items[0].modelName, "DeepSeek V4.1 Flash");
  assert.equal(read.receipts[0].items[0].effort, "high");
  assert.equal(read.receipts[0].items[0].effortRequired, true);
  assert.equal(read.receipts[0].items[0].gate.kind, "blocking");
  assert.equal(read.receipts[0].items[0].gate.stage, "build");
  assert.equal(read.receipts[0].items[0].gate.status, "decided");
  assert.equal(read.receipts[0].items[0].gate.decisionRev, 3);
  assert.equal(read.receipts[0].items[0].futureField, undefined);
  assert.match(read.error, /invalid/);
});

test("receipt state resolves unknown and closure without inventing execution", () => {
  const { S } = boot();
  const unknown = S.receiptState({ result: "unknown" });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.text, "Acknowledgement unknown");
  assert.equal(
    S.receiptState({ result: "unknown", resolution: { outcome: "accepted", at: "14:41" } }).status,
    "queued",
  );
  assert.equal(
    S.receiptState({ result: "unknown", resolution: { outcome: "refused", at: "14:42" } }).status,
    "refused",
  );
  assert.equal(
    S.receiptState({
      result: "accepted",
      lifecycle: "closed",
      resolution: { outcome: "accepted", at: "14:41" },
    }).status,
    "cancelled",
  );
  assert.notEqual(
    S.receiptState({ result: "unknown", resolution: { outcome: "accepted", at: "14:41" } }).status,
    "unknown",
  );
  assert.equal(S.receiptState({ result: "accepted", lifecycle: "queued" }).status, "queued");
});

test("corrupt shared state is reported and falls back to sample defaults", () => {
  const { S, data } = boot();
  data.set(S.SHARED_KEY, JSON.stringify({ v: 99, selection: { itemId: "", attempt: "x" } }));
  const loaded = S.load();
  assert.match(loaded.error, /invalid|unknown version/);
  assert.equal(loaded.state.selection.itemId, "NEO-4821");
  assert.equal(loaded.state.selection.attempt, 3);

  data.set(S.SHARED_KEY, "{not json");
  const broken = S.load();
  assert.match(broken.error, /could not be read/);
  assert.equal(broken.state.selection.itemId, "NEO-4821");
});

test("a reference selection keeps its kind, and item links carry the attempt", () => {
  const { NK, S } = boot();
  S.update((s) => {
    s.selection = { kind: "reference", itemId: "NEO-4838", attempt: 0 };
  });
  const state = S.load().state;
  assert.equal(state.selection.kind, "reference");
  assert.equal(state.selection.itemId, "NEO-4838");

  const tabs = NK.itemTabs({ kind: "original", itemId: "NEO-4821", attempt: 3 }, "summary");
  assert.match(
    tabs,
    /workflow\.html\?item=NEO-4821&amp;attempt=3|workflow\.html\?item=NEO-4821&attempt=3/,
  );
  assert.match(tabs, /planning\.html\?item=NEO-4821&attempt=3&tab=evidence/);
  assert.match(tabs, /aria-current="page">Summary/);
  assert.equal(NK.itemTabs({ kind: "reference", itemId: "NEO-4838", attempt: 0 }, "summary"), "");
});

test("a two-item receipt opens the second item with all request tabs", () => {
  const receipt = {
    id: "R-2",
    key: "wk-2",
    at: "14:50",
    items: [
      {
        issueId: "NEO-4821",
        result: "accepted",
        machine: "mac",
        planRev: 2,
        planText: "Goal: First request title",
      },
      {
        issueId: "NEO-4830",
        result: "accepted",
        machine: "work",
        planRev: 4,
        planText: "Goal: Second request title\n\n- Keep this pinned.",
        decision: "yes",
        instance: "opencode-acp",
        instanceName: "OpenCode ACP",
        model: "deepseek-v4.1-flash",
        modelName: "DeepSeek V4.1 Flash",
        effort: "high",
        gate: {
          kind: "blocking",
          stage: "build",
          status: "decided",
          question: "Continue?",
          decision: "yes",
          decisionLabel: "Yes",
          decisionRev: 4,
        },
      },
    ],
  };
  const data = new Map();
  data.set("neokod-symphony-proto:work:receipts", JSON.stringify([receipt]));
  const page = runRunsPage(data, "?receipt=R-2&issue=NEO-4830&tab=execution");
  const detail = page.html("detail");
  assert.match(detail, /NEO-4830/);
  assert.match(detail, /Second request title/);
  assert.doesNotMatch(detail, /First request title/);
  assert.match(detail, /data-machine-id="work"/);
  assert.match(detail, /id="rtab-summary"/);
  assert.match(detail, /id="rtab-execution"[^>]*aria-selected="true"/);
  assert.match(detail, /id="rtab-plan"/);
  assert.match(detail, /id="rtab-evidence"/);
  assert.match(detail, /Not run/);
  assert.equal(page.location.search, "?receipt=R-2&issue=NEO-4830&tab=execution");
  assert.equal(page.location.hash, "#runs");

  page.click({ dataset: { rtab: "plan" } });
  const plan = page.html("detail");
  assert.match(plan, /Pinned plan r4/);
  assert.match(plan, /Second request title/);
  assert.equal(page.location.search, "?receipt=R-2&issue=NEO-4830&tab=plan");

  page.click({ dataset: { rtab: "evidence" } });
  const evidence = page.html("detail");
  assert.match(evidence, /Admission evidence/);
  assert.match(evidence, /Not run/);
  assert.match(evidence, /data-machine-id="work"/);
  assert.equal(page.location.search, "?receipt=R-2&issue=NEO-4830&tab=evidence");

  page.click({ dataset: { rtab: "summary" } });
  assert.match(page.html("detail"), /Request state is not execution evidence/);
  assert.equal(page.location.search, "?receipt=R-2&issue=NEO-4830&tab=summary");

  const reloaded = runRunsPage(data, page.location.search);
  assert.match(reloaded.html("detail"), /Request state is not execution evidence/);
  assert.match(reloaded.html("detail"), /NEO-4830/);
});

test("empty plan draft survives reload and another tab advances the canonical plan", () => {
  const { S, context } = boot();
  S.update((s) => {
    s.plan.draft = { baseRev: 5, text: "", at: "14:40" };
  });
  assert.equal(S.load().state.plan.draft.text, "");
  context.location = { search: "", hash: "" };
  context.window.location = context.location;
  context.URLSearchParams = URLSearchParams;
  for (const file of ["fixtures.js", "planning-data.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context);
  }
  const source = fs
    .readFileSync(path.join(__dirname, "planning.js"), "utf8")
    .replace(
      "  NK.onReady(() => {",
      "  window.planProbe = { init() { state = bootState(); return state; }, sync: applyShared, draft: recoveredDraft, state() { return state; } };\n  NK.onReady(() => {",
    );
  vm.runInContext(source, context);
  const probe = context.window.planProbe;
  const local = probe.init();
  assert.equal(probe.draft().text, "");
  local.editing = true;
  local.editBase = 5;
  local.draftText = "Local edit based on r5";
  const remote = S.update((s) => {
    s.plan.current = 6;
    s.plan.revisions = [
      { rev: 6, by: "Other tab", at: "14:41", note: "Changed", text: "New canonical plan" },
    ];
  });
  probe.sync(remote.state);
  assert.equal(probe.state().current, 6);
  assert.equal(probe.state().editBase, 5);
  assert.equal(probe.state().draftText, "Local edit based on r5");
});

test("unknown admission summary cannot claim a queued lifecycle", () => {
  const data = new Map([
    [
      "neokod-symphony-proto:work:receipts",
      JSON.stringify([
        {
          id: "R-unknown",
          key: "unknown-key",
          items: [{ issueId: "NEO-4830", result: "unknown", machine: "mac", lifecycle: "queued" }],
        },
      ]),
    ],
  ]);
  const page = runRunsPage(data, "?receipt=R-unknown&issue=NEO-4830&tab=summary");
  const detail = page.html("detail");
  assert.match(detail, /<dt>Lifecycle<\/dt><dd>Acknowledgement unknown/);
});

test("confirmed acceptance with unknown closure is not an unknown admission", () => {
  const data = new Map();
  data.set(
    "neokod-symphony-proto:work:receipts",
    JSON.stringify([
      {
        id: "R-closure",
        key: "wk-close",
        at: "14:40",
        items: [
          {
            issueId: "NEO-4830",
            result: "accepted",
            lifecycle: "closure_unknown",
            machine: "work",
            planText: "Goal: close safely",
          },
        ],
      },
    ]),
  );
  const page = runRunsPage(data, "?receipt=R-closure&issue=NEO-4830&tab=summary");
  assert.match(page.html("attention"), /Closure unknown/);
  assert.doesNotMatch(page.html("attention"), /Acknowledgement unknown/);
  assert.match(page.html("detail"), /Acceptance was confirmed/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log("ok - " + name);
  } catch (error) {
    failed += 1;
    console.error("not ok - " + name);
    console.error("  " + (error && error.message ? error.message : error));
  }
}
if (failed) {
  console.error(failed + " regression check(s) failed");
  process.exit(1);
}
console.log(tests.length + " regression checks passed");
