/* Shared helpers for the Symphony layout prototypes: icons, theme, toast, status pills. */
(function () {
  "use strict";

  var THEME_KEY = "neokod-symphony-proto:theme";

  // 16px stroke icons, drawn for these prototypes.
  var ICONS = {
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    alert: '<path d="M8 2.5l6 11H2z"/><path d="M8 7v3"/><path d="M8 12h.01"/>',
    pause: '<path d="M6 4v8M10 4v8"/>',
    play: '<path d="M5 3.5l7 4.5-7 4.5z"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
    search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
    branch:
      '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/><path d="M5 5v6M11 7c0 3-6 2-6 4"/>',
    commit: '<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>',
    folder: '<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>',
    chevronRight: '<path d="M6 3.5l4.5 4.5L6 12.5"/>',
    chevronDown: '<path d="M3.5 6l4.5 4.5L12.5 6"/>',
    chevronLeft: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
    sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
    moon: '<path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
    reset: '<path d="M3 8a5 5 0 109-3"/><path d="M12 2v3H9"/>',
    edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/>',
    history: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
    link: '<path d="M7 9l2-2"/><path d="M6 6.5L4.5 8a2.5 2.5 0 003.5 3.5L9.5 10"/><path d="M10 9.5L11.5 8A2.5 2.5 0 008 4.5L6.5 6"/>',
    agent:
      '<rect x="3" y="4.5" width="10" height="8" rx="2"/><path d="M8 2v2.5"/><path d="M6 8.5h.01M10 8.5h.01"/>',
    eye: '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
    unlock:
      '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 014.8-1"/>',
    file: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>',
    question:
      '<circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 113 1.4c-.8.5-1.3.9-1.3 1.8"/><path d="M8 11.5h.01"/>',
    returned: '<path d="M6 3.5L2.5 7 6 10.5"/><path d="M3 7h6.5a4 4 0 010 8H8"/>',
    gate: '<path d="M3 14V3M13 14V3M3 6h10M3 10h10"/>',
    person: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5"/>',
    list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
    map: '<rect x="1.5" y="6" width="3.5" height="4" rx="1"/><rect x="11" y="2.5" width="3.5" height="4" rx="1"/><rect x="11" y="9.5" width="3.5" height="4" rx="1"/><path d="M5 8h2.5c1 0 1-3.5 3.5-3.5M7.5 8c1 0 1 3.5 3.5 3.5"/>',
    doc: '<path d="M3.5 2h9v12h-9z"/><path d="M5.5 5h5M5.5 8h5M5.5 11h3"/>',
    dot: '<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/>',
    ring: '<circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/>',
    circle: '<circle cx="8" cy="8" r="4.5"/>',
    orphan: '<circle cx="8" cy="8" r="5" stroke-dasharray="2.2 2"/><path d="M8 8h.01"/>',
    unknown:
      '<circle cx="8" cy="8" r="5.5" stroke-dasharray="1.5 1.8"/><path d="M6.6 6.6a1.5 1.5 0 112.3 1.2c-.6.4-.9.7-.9 1.4"/><path d="M8 11h.01"/>',
    superseded: '<circle cx="8" cy="8" r="5"/><path d="M4.5 11.5l7-7"/>',
    merged:
      '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="10" r="1.5"/><path d="M4.5 5v6M4.5 5c0 3 3 5 5.5 5"/>',
    skipped: '<path d="M3 8h10"/><path d="M10 5l3 3-3 3"/>',
  };

  function icon(name, cls) {
    var body = ICONS[name] || ICONS.circle;
    return (
      '<svg class="ic' +
      (cls ? " " + cls : "") +
      '" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      body +
      "</svg>"
    );
  }

  // One vocabulary for status pills. Colour never carries meaning alone.
  var STATUS = {
    needs: { icon: "alert", label: "Needs you", tone: "attn" },
    running: { icon: "ring", label: "Running", tone: "accent" },
    paused: { icon: "pause", label: "Paused", tone: "neutral" },
    queued: { icon: "circle", label: "Queued", tone: "quiet" },
    failed: { icon: "x", label: "Failed", tone: "danger" },
    orphaned: { icon: "orphan", label: "Tracking lost", tone: "orphan" },
    unknown: { icon: "unknown", label: "Unknown", tone: "quiet" },
    notrun: { icon: "circle", label: "Not run", tone: "quiet" },
    superseded: { icon: "superseded", label: "Superseded", tone: "quiet" },
    passed: { icon: "check", label: "Passed", tone: "ok" },
    done: { icon: "check", label: "Done", tone: "neutral" },
    merged: { icon: "merged", label: "Merged", tone: "merged" },
    cancelled: { icon: "stop", label: "Cancelled", tone: "quiet" },
    returned: { icon: "returned", label: "Sent back", tone: "neutral" },
    skipped: { icon: "skipped", label: "Skipped", tone: "quiet" },
    requested: { icon: "history", label: "Requested", tone: "neutral" },
    saved: { icon: "check", label: "Saved", tone: "neutral" },
    draft: { icon: "edit", label: "Draft", tone: "quiet" },
    locked: { icon: "lock", label: "Locked", tone: "quiet" },
    accepted: { icon: "history", label: "Accepted, not running", tone: "quiet" },
    refused: { icon: "stop", label: "Refused", tone: "quiet" },
  };

  function pill(status, text, extraClass) {
    var s = STATUS[status] || STATUS.unknown;
    return (
      '<span class="pill tone-' +
      s.tone +
      (extraClass ? " " + extraClass : "") +
      '">' +
      icon(s.icon) +
      "<span>" +
      esc(text || s.label) +
      "</span></span>"
    );
  }

  function glyph(status) {
    var s = STATUS[status] || STATUS.unknown;
    return (
      '<span class="glyph tone-' +
      s.tone +
      '" title="' +
      esc(s.label) +
      '">' +
      icon(s.icon) +
      "</span>"
    );
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function costText(cost) {
    return cost == null ? "Not reported" : cost;
  }

  function nowText() {
    return new Date().toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  /* Sample machines --------------------------------------------------
     Identity is the immutable id. The label is display only, and the ids match
     Work's sample machines in work-data.js. No address or token is real. */
  var MACHINE_ICON =
    '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>';

  var MACHINES = {
    mac: { id: "mac", name: "Sample Mac", status: "connected", statusText: "Connected" },
    work: { id: "work", name: "Work PC", status: "connected", statusText: "Connected" },
    build: {
      id: "build",
      name: "Build host",
      status: "offline",
      statusText: "Offline, sign-in failed",
    },
  };
  var MACHINE_ORDER = ["mac", "work", "build"];

  // The existing sample attempt belongs to one machine, just as Work pins one per request.
  var RUN_MACHINE = {
    "NEO-4821": "mac",
    "NEO-4807": "work",
    "NEO-4799": "mac",
    "NEO-4790": "build",
    "NEO-4785": "mac",
    "NEO-4776": "work",
    "NEO-4770": "mac",
    "NEO-4752": "mac",
    "NEO-4741": "build",
    "NEO-4733": "work",
    "NEO-4838": "work",
  };

  function machine(id) {
    return Object.prototype.hasOwnProperty.call(MACHINES, id) ? MACHINES[id] : null;
  }
  function machineLabel(id) {
    var m = machine(id);
    return m ? m.name : "Unknown machine";
  }
  function runMachine(id) {
    return Object.prototype.hasOwnProperty.call(RUN_MACHINE, id) ? RUN_MACHINE[id] : null;
  }
  function machineChip(id, extraClass) {
    var m = machine(id);
    var off = m && m.status !== "connected";
    var name = m ? m.name : "Unknown machine";
    var title = m
      ? m.name + " (" + m.id + "), " + m.statusText + ". Sample machine."
      : "Unknown sample machine id " + (id || "none");
    return (
      '<span class="nk-mchip' +
      (off ? " is-off" : "") +
      (extraClass ? " " + extraClass : "") +
      '" data-machine-id="' +
      esc(id || "") +
      '" title="' +
      esc(title) +
      '">' +
      MACHINE_ICON +
      "<span>" +
      esc(name) +
      "</span>" +
      (id ? '<span class="nk-mid">' + esc(id) + "</span>" : "") +
      (off ? '<span class="nk-mstate">offline</span>' : "") +
      "</span>"
    );
  }

  /* Shared prototype state ------------------------------------------
     A, B and C read and write one validated record for the selected original
     item/attempt, saved decisions, plan revisions and pinned approvals. Work's
     demo receipts stay in Work's own key and are read-only here. */

  var STORE_PREFIX = "neokod-symphony-proto:";
  var SHARED_KEY = STORE_PREFIX + "shared";
  var WORK_RECEIPTS_KEY = STORE_PREFIX + "work:receipts";
  var SAMPLE_ITEM = "NEO-4821";
  var SAMPLE_ATTEMPT = 3;
  var SAMPLE_HEAD = "7f3a9c2";
  var RECEIPT_RESULTS = ["accepted", "blocked", "unknown", "refused"];
  var REQUEST_TABS = ["summary", "execution", "plan", "evidence"];
  var MAX_TEXT = 20000;
  var MAX_NOTE = 2000;

  function defaultShared() {
    return {
      v: 1,
      selection: { kind: "original", itemId: SAMPLE_ITEM, attempt: SAMPLE_ATTEMPT },
      decisions: {},
      plan: {
        current: 5,
        revisions: [],
        draft: null,
        approval: {
          rev: 5,
          at: "13:43",
          by: "You",
          state: "approved",
          itemId: SAMPLE_ITEM,
          attempt: SAMPLE_ATTEMPT,
          head: SAMPLE_HEAD,
          machine: "mac",
        },
      },
      resumeApproval: null,
      requests: {},
      cTab: "plan",
      runsView: {
        scope: "active",
        filter: "all",
        machine: "all",
        selectedKey: "r:" + SAMPLE_ITEM,
        requestTab: "summary",
      },
    };
  }

  function isPlain(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }
  function str(v, max) {
    return typeof v === "string" ? v.slice(0, max || MAX_TEXT) : "";
  }
  function idText(v, max) {
    return typeof v === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(v)
      ? v.slice(0, max || 64)
      : null;
  }
  function intIn(v, min, max) {
    return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= min && v <= max
      ? v
      : null;
  }
  function pick(v, allowed, fallback) {
    return allowed.indexOf(v) >= 0 ? v : fallback;
  }

  function savedDecision(raw) {
    if (!isPlain(raw)) return null;
    var option = idText(raw.option, 24);
    if (!option) return null;
    return {
      option: option,
      note: str(raw.note, MAX_NOTE),
      at: str(raw.at, 40),
      by: str(raw.by, 80) || "You",
    };
  }
  function approvalRecord(raw) {
    if (!isPlain(raw)) return null;
    var out = {
      rev: intIn(raw.rev, 0, 9999),
      at: str(raw.at, 40),
      by: str(raw.by, 80),
      state: pick(raw.state, ["approved", "superseded"], "superseded"),
      itemId: idText(raw.itemId),
      attempt: intIn(raw.attempt, 0, 99),
      head: str(raw.head, 80),
      machine: idText(raw.machine),
    };
    if (raw.reason) out.reason = str(raw.reason, 240);
    if (raw.decisionAt !== undefined) out.decisionAt = str(raw.decisionAt, 40);
    return out;
  }
  function requestRecord(raw) {
    if (!isPlain(raw)) return null;
    var out = {};
    ["at", "itemId", "machine", "head", "decisionAt"].forEach(function (k) {
      if (raw[k] !== undefined) out[k] = str(raw[k], k === "itemId" ? 64 : 80);
    });
    if (raw.attempt !== undefined) out.attempt = intIn(raw.attempt, 0, 99);
    if (raw.planRev !== undefined) out.planRev = intIn(raw.planRev, 0, 9999);
    return out;
  }

  function sanitizeShared(raw) {
    var errors = [];
    var base = defaultShared();
    if (!isPlain(raw))
      return {
        state: base,
        error: "Saved prototype state was not an object; sample defaults are shown.",
      };
    if (raw.v !== 1) errors.push("saved prototype state has an unknown version");

    if (isPlain(raw.selection)) {
      var itemId = idText(raw.selection.itemId);
      var attempt = intIn(raw.selection.attempt, 0, 99);
      if (itemId && attempt !== null) {
        base.selection = {
          kind: raw.selection.kind === "reference" ? "reference" : "original",
          itemId: itemId,
          attempt: attempt,
        };
      } else errors.push("saved selected item or attempt was invalid");
    } else if (raw.selection !== undefined) errors.push("saved selection was invalid");

    if (isPlain(raw.decisions)) {
      Object.keys(raw.decisions).forEach(function (id) {
        if (!idText(id, 16) || !isPlain(raw.decisions[id])) return;
        var d = raw.decisions[id];
        var entry = {};
        if (d.draft !== undefined) entry.draft = d.draft === null ? null : idText(d.draft, 24);
        if (d.note !== undefined) entry.note = str(d.note, MAX_NOTE);
        if (d.saved !== undefined) {
          entry.saved = d.saved === null ? null : savedDecision(d.saved);
          if (d.saved !== null && !entry.saved) errors.push("a saved decision entry was invalid");
        }
        if (d.localDraft !== undefined)
          entry.localDraft =
            d.localDraft === null
              ? null
              : {
                  option: d.localDraft.option ? idText(d.localDraft.option, 24) : null,
                  note: str(d.localDraft.note, MAX_NOTE),
                  at: str(d.localDraft.at, 40),
                };
        if (Array.isArray(d.history))
          entry.history = d.history
            .slice(0, 40)
            .filter(isPlain)
            .map(function (h) {
              return { at: str(h.at, 40), by: str(h.by, 80), text: str(h.text, 500) };
            });
        base.decisions[id] = entry;
      });
    }

    if (isPlain(raw.plan)) {
      var cur = intIn(raw.plan.current, 1, 9999);
      if (cur !== null) base.plan.current = cur;
      else errors.push("saved plan revision was invalid");
      if (Array.isArray(raw.plan.revisions)) {
        var badRevision = false;
        base.plan.revisions = raw.plan.revisions
          .slice(-20)
          .filter(isPlain)
          .map(function (r) {
            var revNo = intIn(r.rev, 1, 9999);
            var planText = str(r.text, MAX_TEXT);
            if (revNo === null || !planText) badRevision = true;
            return {
              rev: revNo,
              by: str(r.by, 80) || "You",
              at: str(r.at, 40),
              note: str(r.note, 240),
              text: planText,
            };
          })
          .filter(function (r) {
            return r.rev !== null && r.text;
          });
        if (badRevision) errors.push("a saved plan revision was invalid");
      }
      if (isPlain(raw.plan.draft)) {
        var baseRev = intIn(raw.plan.draft.baseRev, 1, 9999);
        var text = str(raw.plan.draft.text, MAX_TEXT);
        if (baseRev !== null && typeof raw.plan.draft.text === "string")
          base.plan.draft = { baseRev: baseRev, text: text, at: str(raw.plan.draft.at, 40) };
      }
      if (raw.plan.approval !== undefined) {
        base.plan.approval = approvalRecord(raw.plan.approval);
      }
    } else if (raw.plan !== undefined) errors.push("saved plan state was invalid");

    if (raw.resumeApproval !== undefined) {
      base.resumeApproval = approvalRecord(raw.resumeApproval);
    }

    if (isPlain(raw.requests)) {
      Object.keys(raw.requests).forEach(function (runId) {
        if (!idText(runId) || !isPlain(raw.requests[runId])) return;
        var r = raw.requests[runId];
        var out = {};
        ["resume", "stop", "retry", "merge"].forEach(function (k) {
          if (r[k] != null) out[k] = requestRecord(r[k]);
        });
        if (isPlain(r.attnResolved))
          out.attnResolved = {
            at: str(r.attnResolved.at, 40),
            label: str(r.attnResolved.label, 160),
          };
        base.requests[runId] = out;
      });
    }

    base.cTab = pick(raw.cTab, ["plan", "decisions", "evidence"], "plan");

    if (isPlain(raw.runsView)) {
      base.runsView = {
        scope: pick(raw.runsView.scope, ["active", "history", "all"], "active"),
        filter: pick(
          raw.runsView.filter,
          ["all", "needs", "running", "paused", "failed", "orphaned", "queued", "accepted"],
          "all",
        ),
        machine:
          raw.runsView.machine === "all" || machine(raw.runsView.machine)
            ? raw.runsView.machine
            : "all",
        selectedKey: str(raw.runsView.selectedKey, 120) || base.runsView.selectedKey,
        requestTab: pick(raw.runsView.requestTab, REQUEST_TABS, "summary"),
      };
    }

    return {
      state: base,
      error: errors.length
        ? "Some saved prototype state was invalid (" +
          errors.join("; ") +
          "). Valid fields were kept and sample defaults fill the rest."
        : null,
    };
  }

  var storeError = null;
  function noticeEl() {
    var app = document.querySelector(".app");
    if (!app) return null;
    var el = document.getElementById("nk-store-notice");
    if (!el) {
      el = document.createElement("div");
      el.id = "nk-store-notice";
      el.className = "nk-store-notice";
      el.setAttribute("role", "status");
      var topbar = app.querySelector(".topbar");
      if (topbar && topbar.nextSibling) app.insertBefore(el, topbar.nextSibling);
      else app.insertBefore(el, app.firstChild);
    }
    return el;
  }
  function showStoreError(msg) {
    storeError = msg || null;
    var el = noticeEl();
    if (!el) return;
    if (storeError) {
      el.hidden = false;
      el.innerHTML = icon("alert") + "<span>" + esc(storeError) + "</span>";
    } else {
      el.hidden = true;
      el.innerHTML = "";
    }
  }
  function clearStoreError() {
    showStoreError(null);
  }

  function readRaw(key) {
    try {
      return { ok: true, raw: localStorage.getItem(key) };
    } catch (e) {
      return {
        ok: false,
        raw: null,
        error:
          "This browser blocked local storage. Saved state and drafts cannot persist, so changes last only until you reload.",
      };
    }
  }
  function writeRaw(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error:
          "This browser blocked local storage. Your change is visible on this page but was not saved, so a reload will lose it.",
      };
    }
  }

  function loadShared() {
    var base = defaultShared();
    var read = readRaw(SHARED_KEY);
    if (!read.ok) {
      showStoreError(read.error);
      return { state: base, error: read.error, stored: false };
    }
    if (!read.raw) return { state: base, error: null, stored: false };
    var raw;
    try {
      raw = JSON.parse(read.raw);
    } catch (e) {
      var msg =
        "Saved prototype state could not be read, so sample defaults are shown. It will be replaced when you change something.";
      showStoreError(msg);
      return { state: base, error: msg, stored: true };
    }
    var out = sanitizeShared(raw);
    if (out.error) showStoreError(out.error);
    return { state: out.state, error: out.error, stored: true };
  }

  function updateShared(fn) {
    var loaded = loadShared();
    var s = loaded.state;
    try {
      fn(s);
    } catch (e) {
      var msg = "A prototype state change failed and was not saved.";
      showStoreError(msg);
      return { state: s, ok: false, error: msg };
    }
    // Pages must never persist a request key or token; this store holds sample UI state only.
    var written = writeRaw(SHARED_KEY, s);
    if (!written.ok) {
      showStoreError(written.error);
      return { state: s, ok: false, error: written.error };
    }
    clearStoreError();
    return { state: s, ok: true, error: null };
  }

  function resetShared() {
    try {
      localStorage.removeItem(SHARED_KEY);
    } catch (e) {
      /* the in-memory reset still applies */
    }
    clearStoreError();
    return defaultShared();
  }

  function subscribeShared(fn) {
    window.addEventListener("storage", function (e) {
      if (e.key === SHARED_KEY || e.key === null) fn(loadShared().state);
    });
  }

  /* Pinned scope: an approval addresses one machine, item, attempt, plan and head.
     Resume approval also names the saved decision it covers. */
  function scopeProblem(a, ctx) {
    if (!a) return "No approval is recorded.";
    if (a.state !== "approved") return a.reason || "That approval is no longer in force.";
    if (a.itemId !== ctx.itemId)
      return "The approval was recorded for " + (a.itemId || "another item") + ".";
    if (Number(a.attempt) !== Number(ctx.attempt))
      return "The approval was recorded for attempt " + a.attempt + ".";
    if (Number(a.rev) !== Number(ctx.planRev))
      return "Plan r" + ctx.planRev + " is not approved; the approval covers r" + a.rev + ".";
    if ((a.head || "") !== (ctx.head || ""))
      return "The approval was recorded for head " + (a.head || "unknown") + ".";
    if (a.machine !== ctx.machine)
      return (
        "The approval was recorded for " +
        machineLabel(a.machine) +
        " (" +
        (a.machine || "none") +
        ")."
      );
    if (ctx.decisionAt !== undefined && (a.decisionAt || "") !== ctx.decisionAt)
      return "The approval does not cover the current saved decision.";
    return null;
  }

  /* Item tabs shared by A, B and C. The selected item and attempt travel in the
     query so a new tab or a reload lands on the same thing. */
  function itemHref(page, sel, extra) {
    var q =
      "?item=" +
      encodeURIComponent(sel.itemId) +
      "&attempt=" +
      encodeURIComponent(String(sel.attempt));
    if (extra) q += "&" + extra;
    return page + q + "#" + encodeURIComponent(sel.itemId);
  }
  function itemTabs(sel, active) {
    if (!sel || sel.kind !== "original" || !sel.itemId) return "";
    var tabs = [
      ["summary", "Summary", itemHref("runs.html", sel)],
      ["execution", "Execution", itemHref("workflow.html", sel)],
      ["decisions", "Plan and decisions", itemHref("planning.html", sel, "tab=decisions")],
      ["evidence", "Evidence", itemHref("planning.html", sel, "tab=evidence")],
    ];
    return (
      '<nav class="nk-item-tabs" aria-label="Selected item detail">' +
      tabs
        .map(function (t) {
          return (
            '<a href="' +
            t[2] +
            '"' +
            (t[0] === active ? ' aria-current="page"' : "") +
            ">" +
            esc(t[1]) +
            "</a>"
          );
        })
        .join("") +
      "</nav>"
    );
  }

  /* Request rows keep the exact receipt and issue identity. Their four detail tabs
     are local to Runs so a new Work request never borrows the attempt 3 fixture. */
  function receiptKey(receiptId, issueId) {
    return "q:" + receiptId + ":" + issueId;
  }
  function requestHref(receiptId, issueId, tab) {
    var q =
      "?receipt=" +
      encodeURIComponent(receiptId) +
      "&issue=" +
      encodeURIComponent(issueId) +
      "&tab=" +
      encodeURIComponent(pick(tab, REQUEST_TABS, "summary"));
    return "runs.html" + q + "#runs";
  }
  function receiptState(it) {
    var life = it && it.lifecycle;
    var resolution = it && it.resolution;
    if (life === "closed") return { status: "cancelled", text: "Closed in the demo, not running" };
    if (life === "refused") return { status: "refused", text: "Refused in the demo, not running" };
    if (life === "withdrawal_requested")
      return { status: "paused", text: "Withdrawal requested (demo), not closed" };
    if (life === "closure_unknown")
      return { status: "unknown", text: "Closure unknown (demo), not running" };
    if (it && it.result === "unknown" && resolution && resolution.outcome)
      return resolution.outcome === "refused"
        ? { status: "refused", text: "Resolved refused in Work (demo), not started" }
        : { status: "queued", text: "Resolved accepted in Work (demo), not running" };
    if (it && it.result === "accepted")
      return { status: "queued", text: "Queued in the demo, not running" };
    if (it && it.result === "refused") return { status: "refused", text: "Refused, not started" };
    if (it && it.result === "blocked") return { status: "refused", text: "Blocked, not started" };
    return { status: "unknown", text: "Acknowledgement unknown" };
  }

  /* Work's local demo receipts, read defensively. Unknown extra fields from other
     work on Work are ignored rather than trusted. */
  function workReceipts() {
    var read = readRaw(WORK_RECEIPTS_KEY);
    if (!read.ok) return { receipts: [], error: null, available: false };
    if (!read.raw) return { receipts: [], error: null, available: true };
    var raw;
    try {
      raw = JSON.parse(read.raw);
    } catch (e) {
      return {
        receipts: [],
        available: true,
        error: "Work's saved demo receipts could not be read, so no demo request rows are shown.",
      };
    }
    if (!Array.isArray(raw))
      return {
        receipts: [],
        available: true,
        error: "Work's saved demo receipts had an unexpected shape and were not shown.",
      };
    var invalid = 0;
    var receipts = raw
      .map(function (r) {
        if (!isPlain(r)) {
          invalid++;
          return null;
        }
        var id = idText(r.id, 40);
        if (!id) {
          invalid++;
          return null;
        }
        if (!Array.isArray(r.items)) {
          invalid++;
          return null;
        }
        var items = r.items;
        var out = [];
        items.forEach(function (it) {
          if (!isPlain(it)) {
            invalid++;
            return;
          }
          var issueId = idText(it.issueId);
          var result = pick(it.result, RECEIPT_RESULTS, null);
          if (!issueId || !result) {
            invalid++;
            return;
          }
          var resolution = null;
          if (isPlain(it.resolution)) {
            var outcome = pick(it.resolution.outcome, ["accepted", "refused"], null);
            if (outcome) resolution = { outcome: outcome, at: str(it.resolution.at, 40) };
            else invalid++;
          }
          var gate = null;
          if (isPlain(it.gate)) {
            var gateKind = pick(it.gate.kind, ["blocking", "advisory"], null);
            if (gateKind)
              gate = {
                kind: gateKind,
                stage: it.gate.stage == null ? null : str(it.gate.stage, 40),
                status: pick(it.gate.status, ["open", "decided"], "open"),
                question: str(it.gate.question, 500),
                decision: it.gate.decision == null ? null : str(it.gate.decision, 80),
                decisionLabel:
                  it.gate.decisionLabel == null ? null : str(it.gate.decisionLabel, 160),
                decisionRev: intIn(it.gate.decisionRev, 0, 9999) || 0,
                note: str(it.gate.note, 500),
              };
            else invalid++;
          }
          var reviewers = Array.isArray(it.reviewers)
            ? it.reviewers
                .filter(isPlain)
                .slice(0, 8)
                .map(function (rv) {
                  return {
                    id: idText(rv.id, 64) || str(rv.id, 64),
                    instance: idText(rv.instance, 80) || null,
                    model: str(rv.model, 120) || null,
                    name: str(rv.name, 120) || null,
                    via: str(rv.via, 80) || null,
                    effort: str(rv.effort, 40) || null,
                  };
                })
            : [];
          var checks = Array.isArray(it.checks)
            ? it.checks
                .filter(isPlain)
                .slice(0, 20)
                .map(function (c) {
                  return { text: str(c.text, 500), tone: str(c.tone, 20) };
                })
                .filter(function (c) {
                  return !!c.text;
                })
            : [];
          out.push({
            issueId: issueId,
            issueTitle: str(it.issueTitle, 240),
            source: isPlain(it.source)
              ? {
                  connectionId: str(it.source.connectionId, 120),
                  scopeId: str(it.source.scopeId, 120),
                  scopeRevision: intIn(it.source.scopeRevision, 0, 999999),
                  fetchedAt: str(it.source.fetchedAt, 80),
                  loaded: intIn(it.source.loaded, 0, 999999),
                  total: intIn(it.source.total, 0, 999999),
                }
              : null,
            result: result,
            machine: idText(it.machine) || str(it.machine, 80),
            implementer: str(it.implementer, 80),
            effort: str(it.effort, 40),
            effortRequired: !!it.effortRequired,
            instance: idText(it.instance, 80) || null,
            instanceName: str(it.instanceName, 120) || null,
            model: str(it.model, 120) || null,
            modelName: str(it.modelName, 120) || null,
            reviewers: reviewers,
            workflow: str(it.workflow, 60),
            base: str(it.base, 80),
            repoPath: str(it.repoPath, 300),
            planRev: intIn(it.planRev, 0, 9999),
            planText: str(it.planText, MAX_TEXT),
            decision: it.decision == null ? null : str(it.decision, 80),
            checks: checks,
            reason: it.reason == null ? null : str(it.reason, 500),
            lifecycle: it.lifecycle == null ? null : str(it.lifecycle, 40),
            lifeAt: it.lifeAt == null ? null : str(it.lifeAt, 40),
            resolution: resolution,
            gate: gate,
          });
        });
        return { id: id, key: str(r.key, 120), at: str(r.at, 40), items: out };
      })
      .filter(function (r) {
        return r && r.items.length;
      });
    return {
      receipts: receipts,
      available: true,
      error: invalid
        ? "Some saved Work demo receipt entries were invalid and were not shown."
        : null,
    };
  }

  /* Shared chrome styles: one definition for A, B and C, so the prototype
     pages do not copy the same rule blocks into three stylesheets. */
  function ensureSharedStyles() {
    if (document.getElementById("nk-shared-style")) return;
    var style = document.createElement("style");
    style.id = "nk-shared-style";
    style.textContent = [
      ".nk-mchip{display:inline-flex;align-items:center;gap:5px;max-width:220px;padding:1px 6px;border:1px solid var(--line);border-radius:999px;color:var(--text-2);font-size:var(--fs-meta);white-space:nowrap;vertical-align:middle}",
      ".nk-mchip .ic{width:12px;height:12px}",
      ".nk-mchip .nk-mid{color:var(--text-3);font-family:var(--mono);font-size:10px}",
      ".nk-mchip.is-off{border-style:dashed;color:var(--orphan)}",
      ".nk-mchip .nk-mstate{color:var(--orphan);font-size:10px}",
      ".nk-item-tabs{display:flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:var(--radius);background:var(--control);min-width:0}",
      ".nk-item-tabs a{padding:3px 9px;border-radius:6px;color:var(--text-2);font-size:var(--fs-meta);font-weight:500;white-space:nowrap}",
      ".nk-item-tabs a:hover{text-decoration:none;color:var(--text)}",
      '.nk-item-tabs a[aria-current="page"]{background:var(--elevated);color:var(--text);box-shadow:var(--elev)}',
      ".nk-store-notice{display:flex;align-items:flex-start;gap:8px;padding:6px 14px;border-bottom:1px solid color-mix(in srgb,var(--attn-mark) 36%,var(--line));background:var(--attn-soft);color:var(--attn);font-size:var(--fs-meta)}",
      ".nk-store-notice[hidden]{display:none}",
      ".nk-store-notice .ic{margin-top:2px}",
      ".nk-scope-line{color:var(--text-2);font-size:var(--fs-meta)}",
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  window.NK_SHARED = {
    SHARED_KEY: SHARED_KEY,
    WORK_RECEIPTS_KEY: WORK_RECEIPTS_KEY,
    SAMPLE_ITEM: SAMPLE_ITEM,
    SAMPLE_ATTEMPT: SAMPLE_ATTEMPT,
    SAMPLE_HEAD: SAMPLE_HEAD,
    defaultShared: defaultShared,
    sanitize: sanitizeShared,
    load: loadShared,
    get: function () {
      return loadShared().state;
    },
    update: updateShared,
    reset: resetShared,
    subscribe: subscribeShared,
    scopeProblem: scopeProblem,
    itemHref: itemHref,
    itemTabs: itemTabs,
    receiptKey: receiptKey,
    requestHref: requestHref,
    receiptState: receiptState,
    REQUEST_TABS: REQUEST_TABS,
    workReceipts: workReceipts,
    machine: machine,
    machineLabel: machineLabel,
    machineChip: machineChip,
    machineOrder: MACHINE_ORDER,
    runMachine: runMachine,
    machines: MACHINES,
    nowText: nowText,
    ensureStyles: ensureSharedStyles,
  };

  /* Theme ------------------------------------------------------------- */
  function storedTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }
  function applyTheme(t) {
    document.documentElement.classList.toggle("dark", t === "dark");
    var btn = document.querySelector("[data-theme-toggle]");
    if (btn) {
      btn.setAttribute("aria-pressed", t === "dark" ? "true" : "false");
      btn.setAttribute(
        "aria-label",
        t === "dark" ? "Switch to light theme" : "Switch to dark theme",
      );
      btn.innerHTML = icon(t === "dark" ? "sun" : "moon");
    }
  }
  function currentTheme() {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }
  (function initTheme() {
    var t = storedTheme();
    if (!t)
      t =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.documentElement.classList.toggle("dark", t === "dark");
  })();

  /* Toast (aria-live, no motion beyond a fade) ------------------------ */
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("show");
    }, 4200);
  }

  /* Wire up shared chrome once the DOM is ready --------------------- */
  function onReady(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  onReady(function () {
    applyTheme(currentTheme());
    ensureSharedStyles();
    if (storeError) showStoreError(storeError);
    var btn = document.querySelector("[data-theme-toggle]");
    if (btn) {
      btn.addEventListener("click", function () {
        var next = currentTheme() === "dark" ? "light" : "dark";
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch (e) {}
        applyTheme(next);
      });
    }
    // static icon placeholders: <span data-ic="name"></span>
    var nodes = document.querySelectorAll("[data-ic]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].outerHTML = icon(
        nodes[i].getAttribute("data-ic"),
        nodes[i].getAttribute("data-ic-class"),
      );
    }
  });

  window.NK = {
    icon: icon,
    iconBody: function (name) {
      return ICONS[name] || ICONS.circle;
    },
    pill: pill,
    glyph: glyph,
    esc: esc,
    toast: toast,
    costText: costText,
    nowText: nowText,
    STATUS: STATUS,
    onReady: onReady,
    clone: function (o) {
      return JSON.parse(JSON.stringify(o));
    },
    runById: function (runs, id) {
      for (var i = 0; i < runs.length; i++) if (runs[i].id === id) return runs[i];
      return null;
    },
    machine: machine,
    machineLabel: machineLabel,
    machineChip: machineChip,
    MACHINE_ORDER: MACHINE_ORDER,
    MACHINES: MACHINES,
    runMachine: runMachine,
    itemTabs: itemTabs,
    itemHref: itemHref,
    scopeProblem: scopeProblem,
    shared: window.NK_SHARED,
    workReceipts: workReceipts,
  };
})();
