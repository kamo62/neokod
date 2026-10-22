/* Work: select issues, assign machines and agents, preview, start a local demo.
   Static prototype. No tracker, machine, agent or network call. Local state only lives under
   localStorage keys prefixed neokod-symphony-proto:work: and holds no tokens.

   Receipt store rules (UX-01):
   - Every receipt read/check/allocate/write runs under one exclusive Web Lock, re-reads storage
     inside the lock, writes with crypto.randomUUID IDs, and only updates the page after the
     write succeeds.
   - Without Web Locks or working local storage, Start is disabled with a visible reason.
     Nothing is accepted in memory.
   - Unreadable stored receipts stay untouched and are surfaced as an explicit error. They are
     never replaced with an empty history.
   - Other tabs' receipt writes arrive through the storage event and refresh locks and stale
     previews.

   Request detail links: work.html#runs is the stable route. Deep links also parse
   #runs/<receiptId>/<issueId>, #work/<issueId>, #preview, and the query keys
   view, connection, scope, repo, issue, receipt. */
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
    edits: PREFIX + "edits",
    fixes: PREFIX + "fixes",
    context: PREFIX + "context",
  };
  const LOCK_NAME = PREFIX + "receipts";
  const SHARED_ID = "NEO-4821";
  const ISSUE_IDS = D.issues.map((i) => i.id);
  const NARROW = "(max-width: 860px)";
  const MACHINE_ICON =
    '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/></svg>';
  const ADMISSION_RESULTS = { accepted: true, unknown: true };

  let state;

  /* Small helpers ------------------------------------------------------ */
  const issueById = (id) => D.issues.find((i) => i.id === id) || null;
  const labelOf = (x) => {
    const i = typeof x === "string" ? issueById(x) : x;
    return i ? i.label || i.id : "Unknown issue";
  };
  const agent = (id) =>
    D.agents[id] || { name: String(id || "Unknown agent"), via: "Unknown provider", note: "" };
  const wf = (id) => D.workflows[id] || { name: "Unknown workflow", validation: [], approval: "" };
  const narrow = () => window.matchMedia(NARROW).matches;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
  const nowText = () =>
    new Date().toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const stamp = (v) => (v ? `${v} (sample time)` : "Time unknown");
  const demoStamp = (v) => (v ? `${v} (demo time)` : "Time unknown");
  const listText = (xs) =>
    xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
  const effortLabel = (e) =>
    e ? e.charAt(0).toUpperCase() + e.slice(1) : "No effort setting offered";

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function newId() {
    const c = window.crypto;
    if (!c || typeof c.randomUUID !== "function") return null;
    return "R-" + c.randomUUID();
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

  /* Source access ------------------------------------------------------ */
  const connectionById = (id) => D.connections.find((c) => c.id === id) || null;
  const scopeById = (id) => {
    for (const c of D.connections) {
      const s = c.scopes.find((x) => x.id === id);
      if (s) return { connection: c, scope: s };
    }
    return null;
  };
  const scopeInfo = () => (state.connectionId && state.scopeId ? scopeById(state.scopeId) : null);
  const issuesForScope = (scopeId) => D.issues.filter((i) => i.scope === scopeId);
  const loadedFor = (scopeId) => {
    const info = scopeById(scopeId);
    if (!info) return 0;
    const n = state.loadedByScope[scopeId];
    return Number.isInteger(n) ? Math.min(n, info.scope.total) : info.scope.loaded;
  };
  const repoFor = (issue, machineId) => {
    const info = scopeById(issue.scope);
    const wanted = state.repoByScope[issue.scope] || (info && info.scope.repositories[0].id);
    const m = machineById(machineId);
    const repo = m && m.repos.find((r) => r.id === wanted);
    const meta =
      info && info.scope.repositories.find((r) => r.id === wanted)
        ? info.scope.repositories.find((r) => r.id === wanted)
        : { id: wanted, name: "Unknown repository" };
    return { meta, repo: repo || null, id: wanted };
  };
  const defaultRepoFor = (scopeId) => {
    const info = scopeById(scopeId);
    return info ? info.scope.repositories[0].id : "";
  };
  const repoIdFor = (issue) => state.repoByScope[issue.scope] || defaultRepoFor(issue.scope);

  /* Machines and demo repairs ----------------------------------------- */
  function applyMachineFix(base, fix) {
    if (!fix) return base;
    const m = Object.assign({}, base, {
      providers: base.providers.map((p) => ({
        ...p,
        models: p.models.map((x) => ({ ...x })),
      })),
      repos: base.repos.map((r) => ({ ...r })),
      missing: Object.assign({}, base.missing),
      capabilities: base.capabilities.slice(),
    });
    if (fix.connected) {
      m.status = "connected";
      m.statusText = "Connected (demo restore)";
      m.checked = nowText();
      m.problem = null;
      m.lastKnown = null;
      m.queue = "1 run at a time (demo machine setting)";
      if (!m.providers.length) {
        const provider = (id, driver, name, account, models) => ({
          id,
          driver,
          name,
          account,
          models,
        });
        m.providers = [
          provider("pi_build_opencode", "opencode", "OpenCode (ACP)", "Demo restored profile", [
            {
              id: "deepseek/deepseek-flash",
              name: "DeepSeek V4.1 Flash",
              profile: "deepseek",
              efforts: ["high", "medium"],
              defaultEffort: "high",
              enabled: true,
            },
          ]),
          provider("pi_build_codex", "codex", "Codex", "Demo restored login", [
            {
              id: "gpt-6.1-sol",
              name: "Sol 6.1",
              profile: "sol",
              efforts: ["high", "medium"],
              defaultEffort: "high",
              enabled: true,
            },
          ]),
          provider("pi_build_claude", "claude", "Claude", "Demo restored login", [
            {
              id: "claude-opus-5-5",
              name: "Opus 5.5",
              profile: "opus",
              efforts: ["high", "low"],
              defaultEffort: "high",
              enabled: true,
            },
          ]),
          provider("pi_build_copilot", "copilot", "GitHub Copilot", "Demo restored seat", [
            {
              id: "sample-model-g",
              name: "Sample model G",
              profile: "copilot",
              efforts: [],
              defaultEffort: null,
              enabled: true,
            },
          ]),
        ];
      }
    }
    if (fix.providers) {
      fix.providers.forEach((profile) => {
        m.providers.forEach((p) =>
          p.models.forEach((x) => {
            if (x.profile === profile) {
              x.enabled = true;
              delete x.reason;
            }
          }),
        );
        delete m.missing[profile];
      });
    }
    if (fix.repos) {
      Object.keys(fix.repos).forEach((repoId) => {
        const repo = m.repos.find((r) => r.id === repoId);
        if (repo) Object.assign(repo, fix.repos[repoId]);
      });
    }
    return m;
  }

  function machineBase(id) {
    return D.machines.find((m) => m.id === id) || null;
  }
  function machineById(id) {
    const base = machineBase(id);
    if (!base) return null;
    return applyMachineFix(base, state && state.fixes ? state.fixes[id] : null);
  }
  function machineFix(mid, patch) {
    if (!state.fixes[mid]) state.fixes[mid] = {};
    Object.assign(state.fixes[mid], patch);
    state.fixRev += 1;
    persistFixes();
    invalidatePreviewForSettings();
  }

  const providerFor = (m, instanceId) =>
    (m && m.providers.find((p) => p.id === instanceId)) || null;
  const instanceName = (m, instanceId) => {
    const p = providerFor(m, instanceId);
    return p ? p.name : "Unknown provider instance";
  };

  function targetsOn(mid) {
    const m = machineById(mid);
    if (!m || m.status !== "connected") return [];
    const out = [];
    m.providers.forEach((p) =>
      p.models.forEach((x) => {
        out.push({
          instance: p.id,
          instanceName: p.name,
          account: p.account,
          driver: p.driver,
          model: x.id,
          name: x.name,
          profile: x.profile,
          efforts: (x.efforts || []).slice(),
          defaultEffort: x.defaultEffort || null,
          enabled: !!x.enabled,
          reason: x.reason || null,
        });
      }),
    );
    return out;
  }

  function firstTargetFor(mid, profile) {
    return targetsOn(mid).find((t) => t.profile === profile && t.enabled) || null;
  }

  function resolveTarget(mid, pick) {
    pick = pick || {};
    const m = machineById(mid);
    if (!m) return { ok: false, reason: "Choose a saved machine." };
    if (m.status !== "connected")
      return {
        ok: false,
        reason: `${m.name} is offline; its provider instances cannot be checked.`,
      };
    const all = targetsOn(mid);
    let t = null;
    if (pick.instance || pick.model) {
      if (!pick.instance || !pick.model)
        return {
          ok: false,
          reason:
            "The saved provider target is incomplete (it has only one of provider instance and model). Choose the exact target again; nothing is substituted.",
        };
      t = all.find((x) => x.instance === pick.instance && x.model === pick.model) || null;
      if (!t)
        return {
          ok: false,
          reason: `The saved provider instance ${pick.instance} with model ${pick.model} is not on ${m.name}. Choose it again; nothing is substituted.`,
        };
    } else if (pick.agent) {
      t = all.find((x) => x.profile === pick.agent) || null;
      if (!t)
        return {
          ok: false,
          reason: `${m.name} has no ${agent(pick.agent).name} provider instance that this sample account can use.`,
        };
    } else return { ok: false, reason: "Choose a provider instance and model." };
    if (!t.enabled)
      return {
        ok: false,
        target: t,
        reason: t.reason || `${t.name} is not enabled for this provider instance on ${m.name}.`,
      };
    if (!t.efforts.length) return { ok: true, target: t, effort: null };
    const effort = pick.effort == null || pick.effort === "" ? t.defaultEffort : pick.effort;
    if (t.efforts.length && effort && t.efforts.indexOf(effort) < 0)
      return {
        ok: false,
        target: t,
        reason: `${t.name} on ${m.name} does not offer effort ${effort}. Choose a supported effort; nothing is substituted.`,
      };
    if (t.efforts.length && !effort)
      return {
        ok: false,
        target: t,
        reason: `Choose a supported effort for ${t.name} on ${m.name}.`,
      };
    return { ok: true, target: t, effort: effort || null };
  }

  function pickSummary(mid, pick) {
    const res = resolveTarget(mid, pick);
    if (res.ok) {
      const m = machineById(mid);
      return {
        ok: true,
        name: res.target.name,
        instance: res.target.instance,
        instanceName: instanceName(m, res.target.instance),
        model: res.target.model,
        effort: res.effort,
        label: res.effort ? `${res.target.name} · ${effortLabel(res.effort)}` : res.target.name,
        reason: null,
      };
    }
    const known =
      pick && pick.model
        ? pick.model
        : pick && pick.agent
          ? agent(pick.agent).name
          : "Choose a model";
    return {
      ok: false,
      name: known,
      instance: pick && pick.instance,
      instanceName: pickInstanceName(mid, pick),
      model: pick && pick.model,
      effort: pick && pick.effort,
      label: known,
      reason: res.reason,
    };
  }
  function pickInstanceName(mid, pick) {
    const m = machineById(mid);
    return pick && pick.instance ? instanceName(m, pick.instance) : m ? m.name : "Unknown machine";
  }

  /* Storage: one namespace, JSON only, validated on read ------------- */
  function probeStorage() {
    try {
      const k = PREFIX + "probe";
      localStorage.setItem(k, "1");
      const ok = localStorage.getItem(k) === "1";
      localStorage.removeItem(k);
      return { ok: !!ok, reason: ok ? null : "This browser did not keep the test value." };
    } catch (e) {
      return {
        ok: false,
        reason:
          "This browser blocked local storage. Start is off because a receipt cannot be recorded safely.",
      };
    }
  }

  function locksAvailable() {
    const n = window.navigator;
    return !!(n && n.locks && typeof n.locks.request === "function");
  }

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
  function persistFixes() {
    if (!state) return;
    if (!writeJson(KEY.fixes, state.fixes)) {
      state.storageWriteError =
        "This browser blocked local storage. The demo repair lasts until you reload.";
      toast(state.storageWriteError);
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
      const left = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) left.push(k);
      }
      if (left.length)
        return {
          ok: false,
          error:
            "Reset could not remove every local demo key. Nothing was cleared from this page's state. Check browser storage permissions and try again.",
        };
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error:
          "Reset could not clear local demo data because this browser refused storage access. Nothing was reset." +
          (e && e.message ? " " + e.message : ""),
      };
    }
  }

  function receiptSnapshot() {
    try {
      return { ok: true, raw: localStorage.getItem(KEY.receipts) };
    } catch (e) {
      return {
        ok: false,
        error:
          "Local storage is unavailable, so Reset cannot verify the receipt history. Nothing was reset.",
      };
    }
  }

  /* Draft: selection and assignments ---------------------------------- */
  function pinFor(profile, effort, machine) {
    const t = firstTargetFor(machine, profile);
    const wanted =
      t && t.efforts.length
        ? effort && t.efforts.indexOf(effort) >= 0
          ? effort
          : t.defaultEffort
        : "";
    return Object.assign(
      { agent: profile, effort: wanted },
      t ? { instance: t.instance, model: t.model } : {},
    );
  }

  function defaultReviewers(machine) {
    return D.team.reviewers.map((r) => pinFor(r.agent, r.effort, machine || D.defaults.machine));
  }

  function emptyDraft() {
    const impl = pinFor(D.team.implementer, D.team.implementerEffort, D.defaults.machine);
    return {
      revision: 0,
      selected: [],
      defaults: {
        machine: D.defaults.machine,
        implementer: D.team.implementer,
        effort: impl.effort,
        instance: impl.instance,
        model: impl.model,
        reviewers: defaultReviewers(D.defaults.machine),
      },
      overrides: {},
    };
  }

  function sanitizeReviewers(raw, fallback, machine) {
    const out = [];
    if (Array.isArray(raw)) {
      raw.slice(0, 3).forEach((r) => {
        if (!r || typeof r !== "object" || !D.agents[r.agent]) return;
        const e = { agent: r.agent };
        if (typeof r.effort === "string") e.effort = r.effort;
        if (typeof r.instance === "string" && r.instance) e.instance = r.instance;
        if (typeof r.model === "string" && r.model) e.model = r.model;
        if (!e.instance && !e.model) {
          const pin = firstTargetFor(machine || D.defaults.machine, e.agent);
          if (pin) {
            e.instance = pin.instance;
            e.model = pin.model;
            if (e.effort == null) e.effort = pin.efforts.length ? pin.defaultEffort : "";
          }
        }
        out.push(e);
      });
    }
    return out.length
      ? out
      : fallback.map((r) => ({
          agent: r.agent,
          effort: r.effort == null ? "" : r.effort,
          ...(r.instance ? { instance: r.instance } : {}),
          ...(r.model ? { model: r.model } : {}),
        }));
  }

  function sanitizeDraft(raw) {
    const d = emptyDraft();
    if (!raw || typeof raw !== "object") return d;
    if (Number.isInteger(raw.revision) && raw.revision >= 0) d.revision = raw.revision;
    if (raw.defaults && typeof raw.defaults === "object") {
      // A stored default may refer to a different machine. Do not keep emptyDraft's pins for
      // another machine: take the stored pins, or materialise pins for the stored machine only.
      d.defaults.instance = null;
      d.defaults.model = null;
    }
    if (raw.defaults && machineById(raw.defaults.machine))
      d.defaults.machine = raw.defaults.machine;
    if (raw.defaults && D.agents[raw.defaults.implementer])
      d.defaults.implementer = raw.defaults.implementer;
    if (raw.defaults && typeof raw.defaults.effort === "string")
      d.defaults.effort = raw.defaults.effort;
    if (raw.defaults && typeof raw.defaults.instance === "string")
      d.defaults.instance = raw.defaults.instance;
    if (raw.defaults && typeof raw.defaults.model === "string")
      d.defaults.model = raw.defaults.model;
    if (!d.defaults.instance && !d.defaults.model) {
      // Legacy drafts have no exact pin. Materialise the project default's machine-specific
      // provider identity rather than resolving loosely by profile later.
      const pin = firstTargetFor(d.defaults.machine, d.defaults.implementer);
      if (pin) {
        d.defaults.instance = pin.instance;
        d.defaults.model = pin.model;
        if (!d.defaults.effort && pin.efforts.length) d.defaults.effort = pin.defaultEffort;
      }
    }
    d.defaults.reviewers = sanitizeReviewers(
      raw.defaults && raw.defaults.reviewers,
      defaultReviewers(d.defaults.machine),
      d.defaults.machine,
    );
    if (Array.isArray(raw.selected))
      d.selected = ISSUE_IDS.filter((id) => raw.selected.includes(id));
    if (raw.overrides && typeof raw.overrides === "object") {
      d.selected.forEach((id) => {
        const o = raw.overrides[id];
        if (!o || typeof o !== "object") return;
        const c = {};
        if (machineById(o.machine)) c.machine = o.machine;
        if (D.agents[o.implementer]) c.implementer = o.implementer;
        if (typeof o.effort === "string") c.effort = o.effort;
        if (typeof o.instance === "string" && o.instance) c.instance = o.instance;
        if (typeof o.model === "string" && o.model) c.model = o.model;
        if (Array.isArray(o.reviewers))
          c.reviewers = sanitizeReviewers(o.reviewers, [], o.machine || d.defaults.machine);
        if (c.reviewers && !c.reviewers.length) delete c.reviewers;
        if (Object.keys(c).length) d.overrides[id] = c;
      });
    }
    return d;
  }

  function canonical(d) {
    return JSON.stringify({
      s: ISSUE_IDS.filter((id) => d.selected.includes(id)),
      d: [
        d.defaults.machine,
        d.defaults.implementer,
        d.defaults.effort,
        d.defaults.instance || "",
        d.defaults.model || "",
        d.defaults.reviewers.map((r) => [
          r.agent,
          r.effort == null ? "" : r.effort,
          r.instance || "",
          r.model || "",
        ]),
      ],
      o: ISSUE_IDS.filter((id) => d.overrides[id]).map((id) => {
        const o = d.overrides[id];
        return [
          id,
          o.machine || "",
          o.implementer || "",
          o.instance || "",
          o.model || "",
          o.effort == null ? "" : o.effort,
          (o.reviewers || []).map((r) => [
            r.agent,
            r.effort == null ? "" : r.effort,
            r.instance || "",
            r.model || "",
          ]),
        ];
      }),
    });
  }

  const orderedSelected = () => ISSUE_IDS.filter((id) => state.draft.selected.includes(id));
  const isSelected = (id) => state.draft.selected.includes(id);

  function changeDraft(fn) {
    fn(state.draft);
    state.draft.revision += 1;
    scheduleRecovery();
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

  function draftBody(d) {
    return {
      v: 1,
      revision: d.revision,
      selected: ISSUE_IDS.filter((id) => d.selected.includes(id)),
      defaults: {
        machine: d.defaults.machine,
        implementer: d.defaults.implementer,
        effort: d.defaults.effort == null ? "" : d.defaults.effort,
        instance: d.defaults.instance || null,
        model: d.defaults.model || null,
        reviewers: d.defaults.reviewers.map((r) => ({
          agent: r.agent,
          effort: r.effort == null ? null : r.effort,
          instance: r.instance || null,
          model: r.model || null,
        })),
      },
      overrides: JSON.parse(JSON.stringify(d.overrides)),
      savedAt: nowText(),
    };
  }

  function saveDraft() {
    const at = nowText();
    const body = draftBody(state.draft);
    body.savedAt = at;
    if (!writeJson(KEY.draft, body)) {
      state.storageWriteError =
        "This browser blocked local storage. The draft lasts until you reload.";
      toast(state.storageWriteError);
      render();
      return;
    }
    state.storageWriteError = null;
    state.savedJson = canonical(state.draft);
    state.savedAt = at;
    persistRecovery();
    toast(`Draft saved at ${at}. Saving does not start anything.`);
  }

  // Accepted work leaves the stored draft too, so a reload cannot reselect it.
  function patchSavedDraft(ids) {
    const raw = readJson(KEY.draft);
    if (!raw) return;
    const d = sanitizeDraft(raw);
    dropFromDraft(d, ids);
    writeJson(KEY.draft, draftBody(d));
    state.savedJson = canonical(d);
    if (!state.draft.selected.some((id) => ids.includes(id))) return;
  }

  function assignment(id) {
    const issue = issueById(id);
    const o = state.draft.overrides[id] || {};
    const machine = o.machine || state.draft.defaults.machine;
    const implPick = o.instance
      ? {
          instance: o.instance,
          model: o.model,
          effort: o.effort == null ? undefined : o.effort,
          agent: o.implementer || state.draft.defaults.implementer,
        }
      : o.implementer
        ? {
            agent: o.implementer,
            effort: o.effort == null ? undefined : o.effort,
          }
        : {
            agent: state.draft.defaults.implementer,
            effort: o.effort == null ? state.draft.defaults.effort : o.effort,
            ...(state.draft.defaults.instance || state.draft.defaults.model
              ? {
                  instance: state.draft.defaults.instance || "",
                  model: state.draft.defaults.model || "",
                }
              : {}),
          };
    const impl = resolveTarget(machine, implPick);
    const reviewerPicks = o.reviewers || state.draft.defaults.reviewers;
    const reviewers = reviewerPicks.map((r, idx) => {
      const res = resolveTarget(machine, {
        agent: r.agent,
        ...(r.instance || r.model ? { instance: r.instance || "", model: r.model || "" } : {}),
        effort: r.effort,
      });
      return { index: idx, pick: r, res, agent: r.agent };
    });
    return {
      machine,
      machineOverridden: !!o.machine,
      implementerOverridden: !!o.implementer || !!o.instance,
      reviewersOverridden: !!o.reviewers,
      effortOverridden: o.effort != null && o.effort !== "",
      impl,
      implPick,
      reviewers,
      repo: issue ? repoFor(issue, machine) : null,
      issue,
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
    if (!writeJson(KEY.plans, state.plans)) {
      state.storageWriteError =
        "This browser blocked local storage. The plan lasts until you reload.";
      toast(state.storageWriteError);
      render();
    }
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
    persistRecovery();
    toast(
      `Plan r${cur.rev + 1} saved for ${labelOf(id)}. Nothing started.` +
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
    persistRecovery();
    toast(
      `Decision saved for ${labelOf(id)}. Saving does not start, resume or approve work.` +
        (stale ? " The preview is now out of date." : ""),
    );
  }

  function gateFor(id) {
    const issue = issueById(id);
    const q = issue && issue.question;
    if (!q) return null;
    const d = decisionOf(id);
    return {
      kind: q.kind === "blocking" ? "blocking" : "advisory",
      stage: q.kind === "blocking" ? q.holdsStage || "build" : null,
      status: d ? "decided" : "open",
      question: q.title,
      note: q.note || "",
      decision: d ? d.option : null,
      decisionLabel: d ? optionLabel(issue, d.option) : null,
      decisionRev: d ? d.rev : 0,
    };
  }

  /* Unsaved local recovery (UX-11) ------------------------------------ */
  let recoveryTimer = null;

  function scheduledRecovery() {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      persistRecovery();
    }, 250);
  }

  function hasRecoverable() {
    const planDirty = Object.keys(state.planEdits).some(
      (id) => state.planEdits[id] != null && state.planEdits[id] !== planOf(id).text,
    );
    const decisionDirty = Object.keys(state.decisionEdits).length > 0;
    return planDirty || decisionDirty || draftStatus().dirty;
  }

  function persistRecovery() {
    if (!state) return;
    if (!hasRecoverable()) {
      try {
        localStorage.removeItem(KEY.edits);
      } catch (e) {
        /* ignore */
      }
      state.recoveryError = null;
      state.recovered = null;
      return;
    }
    const body = {
      v: 1,
      at: nowText(),
      draft: draftBody(state.draft),
      planEdits: JSON.parse(JSON.stringify(state.planEdits)),
      decisionEdits: JSON.parse(JSON.stringify(state.decisionEdits)),
    };
    try {
      localStorage.setItem(KEY.edits, JSON.stringify(body));
      state.recoveryError = null;
    } catch (e) {
      state.recoveryError =
        "Could not save a recovery copy of these unsaved edits. Keep this tab open or save explicitly.";
    }
  }
  const scheduleRecovery = () => scheduledRecovery();

  function discardRecovery() {
    try {
      localStorage.removeItem(KEY.edits);
      if (localStorage.getItem(KEY.edits) !== null) throw new Error("Recovery removal failed");
    } catch (e) {
      state.recoveryError = "Could not discard the recovery copy. Your edits are still shown.";
      render("wk-recovered-discard");
      toast(state.recoveryError);
      return;
    }
    state.planEdits = {};
    state.decisionEdits = {};
    state.recovered = null;
    const raw = readJson(KEY.draft);
    if (raw) {
      const d = sanitizeDraft(raw);
      dropFromDraft(
        d,
        d.selected.filter((id) => activeItem(id)),
      );
      state.draft = d;
      state.savedJson = canonical(d);
    } else {
      state.draft = emptyDraft();
      state.savedJson = null;
      state.savedAt = null;
    }
    persistRecovery();
    render("wk-recovered-discard");
    toast("Recovered unsaved edits discarded. The last saved draft is shown.");
  }

  /* Receipts: serialized store and lifecycle -------------------------- */
  function sanitizeReceiptItems(rawItems) {
    if (!Array.isArray(rawItems)) return null;
    const items = [];
    for (const it of rawItems) {
      if (!it || typeof it !== "object") return null;
      const issue = issueById(it.issueId);
      if (!issue) return null;
      const result =
        it.result === "accepted" ||
        it.result === "blocked" ||
        it.result === "refused" ||
        it.result === "unknown"
          ? it.result
          : null;
      if (!result) return null;
      const machine = typeof it.machine === "string" && it.machine ? it.machine : null;
      if (!machine) return null;
      const implementer =
        typeof it.implementer === "string" && it.implementer
          ? it.implementer
          : it.model
            ? String(it.model)
            : "unknown";
      const rec = {
        issueId: it.issueId,
        issueTitle: typeof it.issueTitle === "string" ? it.issueTitle.slice(0, 240) : null,
        source: it.source && typeof it.source === "object" ? Object.assign({}, it.source) : null,
        scopeId: typeof it.scopeId === "string" ? it.scopeId : issue.scope,
        nativeId: typeof it.nativeId === "string" ? it.nativeId : issue.nativeId,
        result,
        reason: typeof it.reason === "string" ? it.reason : null,
        machine,
        machineOverridden: !!it.machineOverridden,
        implementer,
        implementerOverridden: !!it.implementerOverridden,
        effort: String(it.effort || ""),
        effortRequired: !!it.effortRequired,
        instance: typeof it.instance === "string" ? it.instance : null,
        model: typeof it.model === "string" ? it.model : null,
        instanceName: typeof it.instanceName === "string" ? it.instanceName : null,
        modelName: typeof it.modelName === "string" ? it.modelName : null,
        reviewers: Array.isArray(it.reviewers)
          ? it.reviewers
              .filter((r) => r && (D.agents[r.id] || typeof r.id === "string"))
              .map((r) => ({
                id: String(r.id),
                instance: typeof r.instance === "string" ? r.instance : null,
                model: typeof r.model === "string" ? r.model : null,
                name: typeof r.name === "string" ? r.name : agent(r.id).name,
                via: typeof r.via === "string" ? r.via : agent(r.id).via,
                effort: String(r.effort || ""),
              }))
          : [],
        workflow: wf(it.workflow).name === "Unknown workflow" ? issue.workflow : it.workflow,
        base: String(it.base || ""),
        repoPath: String(it.repoPath || ""),
        repoId: typeof it.repoId === "string" ? it.repoId : null,
        planRev: Number.isInteger(it.planRev) ? it.planRev : 1,
        planText: typeof it.planText === "string" ? it.planText : "",
        decision: typeof it.decision === "string" ? it.decision : null,
        checks: Array.isArray(it.checks)
          ? it.checks.filter((c) => c && typeof c.text === "string")
          : [],
        lifecycle:
          typeof it.lifecycle === "string" ? it.lifecycle : result === "accepted" ? "queued" : null,
        lifeAt: typeof it.lifeAt === "string" ? it.lifeAt : null,
        withdrawalAt: typeof it.withdrawalAt === "string" ? it.withdrawalAt : null,
        closureAt: typeof it.closureAt === "string" ? it.closureAt : null,
        closureUnknownAt: typeof it.closureUnknownAt === "string" ? it.closureUnknownAt : null,
        resolution:
          it.resolution && typeof it.resolution === "object"
            ? {
                outcome: it.resolution.outcome === "refused" ? "refused" : "accepted",
                at: typeof it.resolution.at === "string" ? it.resolution.at : "",
                source: "Simulated authoritative demo answer",
              }
            : null,
        reservation:
          it.reservation && typeof it.reservation === "object"
            ? {
                requestKey: String(it.reservation.requestKey || ""),
                machine: String(it.reservation.machine || machine),
                at: String(it.reservation.at || ""),
                state: it.reservation.state === "resolved" ? "resolved" : "unresolved",
              }
            : null,
        previous:
          it.previous && typeof it.previous === "object"
            ? {
                receipt: String(it.previous.receipt || ""),
                issueId: String(it.previous.issueId || it.issueId),
                machine: String(it.previous.machine || ""),
                at: String(it.previous.at || ""),
                kind: it.previous.kind === "refused" ? "refused" : "closed",
              }
            : null,
        gate:
          it.gate && typeof it.gate === "object"
            ? {
                kind: it.gate.kind === "blocking" ? "blocking" : "advisory",
                stage: typeof it.gate.stage === "string" ? it.gate.stage : null,
                status: it.gate.status === "decided" ? "decided" : "open",
                question: String(it.gate.question || ""),
                decision: typeof it.gate.decision === "string" ? it.gate.decision : null,
                decisionLabel:
                  typeof it.gate.decisionLabel === "string" ? it.gate.decisionLabel : null,
                decisionRev: Number.isInteger(it.gate.decisionRev) ? it.gate.decisionRev : 0,
                note: String(it.gate.note || ""),
              }
            : null,
      };
      items.push(rec);
    }
    return items;
  }

  function inspectReceipts(raw) {
    if (raw == null) return { ok: true, value: [] };
    if (!Array.isArray(raw))
      return {
        ok: false,
        error:
          "Stored demo receipts are not a list this page can read. They were left untouched, Start is off, and nothing has been overwritten.",
      };
    const out = [];
    for (const r of raw) {
      if (!r || typeof r.id !== "string" || typeof r.key !== "string") {
        return {
          ok: false,
          error:
            "Stored demo receipts contain an entry this page cannot read. They were left untouched, Start is off, and nothing has been overwritten.",
        };
      }
      const items = sanitizeReceiptItems(r.items);
      if (!items || !items.length) {
        return {
          ok: false,
          error:
            "Stored demo receipts contain an item this page cannot read. They were left untouched, Start is off, and nothing has been overwritten.",
        };
      }
      out.push({
        id: r.id,
        key: r.key,
        at: String(r.at || ""),
        outcome: typeof r.outcome === "string" ? r.outcome : null,
        source:
          r.source && typeof r.source === "object"
            ? {
                connectionId: String(r.source.connectionId || ""),
                scopeId: String(r.source.scopeId || ""),
                scopeRevision: Number.isInteger(r.source.scopeRevision)
                  ? r.source.scopeRevision
                  : 0,
                repoId: String(r.source.repoId || ""),
                fetchedAt: String(r.source.fetchedAt || ""),
              }
            : null,
        fixRev: Number.isInteger(r.fixRev) ? r.fixRev : 0,
        items,
      });
    }
    return { ok: true, value: out };
  }

  function readReceiptStore() {
    let raw;
    try {
      const text = localStorage.getItem(KEY.receipts);
      raw = text ? JSON.parse(text) : null;
    } catch (e) {
      return {
        ok: false,
        error:
          "Stored demo receipts could not be read as JSON. They were left untouched, Start is off, and nothing has been overwritten. Use Reset demo only if you deliberately want to clear them.",
      };
    }
    return inspectReceipts(raw);
  }

  const isAdmission = (it) => !!ADMISSION_RESULTS[it.result];
  const isAcceptedLike = (it) =>
    it.result === "accepted" ||
    (it.result === "unknown" && !!it.resolution && it.resolution.outcome === "accepted");
  const isClosed = (it) =>
    it.lifecycle === "closed" || (it.resolution && it.resolution.outcome === "refused");
  const isActive = (it) => isAdmission(it) && !isClosed(it);
  const activeItem = (id) => {
    for (const r of state.receipts)
      for (const it of r.items)
        if (it.issueId === id && isActive(it)) return { receipt: r, item: it };
    return null;
  };
  const receiptById = (rid) => state.receipts.find((r) => r.id === rid) || null;
  const activeCount = () => state.receipts.reduce((n, r) => n + r.items.filter(isActive).length, 0);
  const terminatedFor = (id) => {
    for (let ri = state.receipts.length - 1; ri >= 0; ri--) {
      const r = state.receipts[ri];
      for (let ii = r.items.length - 1; ii >= 0; ii--) {
        const it = r.items[ii];
        if (it.issueId !== id) continue;
        const refusedAfterUnknown =
          it.result === "unknown" && it.resolution && it.resolution.outcome === "refused";
        if (it.lifecycle === "closed" || it.result === "refused" || refusedAfterUnknown)
          return {
            receipt: r,
            item: it,
            kind: it.lifecycle === "closed" ? "closed" : "refused",
          };
      }
    }
    return null;
  };
  const priorRequestFor = (id) => terminatedFor(id);

  function withReceiptLock(fn) {
    if (!locksAvailable())
      return Promise.resolve({
        ok: false,
        reason:
          "This browser does not support the Web Locks API, so receipt writes cannot be serialised. Start is off.",
      });
    return Promise.resolve(
      window.navigator.locks.request(LOCK_NAME, { mode: "exclusive" }, fn),
    ).catch((e) => ({
      ok: false,
      reason: "Could not obtain the serialised receipt lock: " + (e && e.message ? e.message : e),
    }));
  }

  function startGuard() {
    if (!state.storageProbe.ok) return { ok: false, reason: state.storageProbe.reason };
    if (!locksAvailable())
      return {
        ok: false,
        reason:
          "This browser does not support the Web Locks API, so receipt writes cannot be serialised. Start is off.",
      };
    if (!window.crypto || typeof window.crypto.randomUUID !== "function")
      return {
        ok: false,
        reason:
          "This browser does not provide crypto.randomUUID, so a non-colliding receipt ID cannot be allocated. Start is off.",
      };
    if (state.receiptsError)
      return {
        ok: false,
        reason:
          "Stored demo receipts are unreadable. Start is off so the stored history is not overwritten.",
      };
    return { ok: true, reason: null };
  }

  function writeReceipts(receipts) {
    try {
      localStorage.setItem(KEY.receipts, JSON.stringify(receipts));
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error:
          "The browser refused to write the demo receipt. Nothing was accepted in memory. Check that storage is not full and try again.",
      };
    }
  }

  async function updateReceiptItem(rid, issueId, mutate, successMessage) {
    const guard = startGuard();
    if (!guard.ok) {
      state.startError = guard.reason;
      render();
      return { ok: false, reason: guard.reason };
    }
    const result = await withReceiptLock(() => {
      const read = readReceiptStore();
      if (!read.ok) {
        state.receiptsError = read.error;
        return { ok: false, reason: read.error };
      }
      const receipts = read.value;
      const receipt = receipts.find((r) => r.id === rid);
      const item = receipt && receipt.items.find((x) => x.issueId === issueId);
      if (!item) return { ok: false, reason: "That demo receipt item no longer exists." };
      const before = JSON.stringify(item);
      mutate(item, receipt);
      if (JSON.stringify(item) === before) return { ok: true, unchanged: true };
      const write = writeReceipts(receipts);
      if (!write.ok) return { ok: false, reason: write.error };
      state.receipts = receipts;
      return { ok: true, receipt };
    });
    if (!result.ok) {
      state.startError = result.reason;
      render();
      return result;
    }
    state.startError = null;
    if (successMessage) toast(successMessage);
    render();
    return result;
  }

  function requestWithdrawal(rid, issueId) {
    return updateReceiptItem(
      rid,
      issueId,
      (it) => {
        if (!isActive(it) || !isAcceptedLike(it)) return;
        if (it.lifecycle === "withdrawal_requested" || it.lifecycle === "closure_unknown") return;
        it.lifecycle = "withdrawal_requested";
        it.withdrawalAt = nowText();
        it.lifeAt = it.withdrawalAt;
      },
      "Withdrawal requested in the demo. This is not closure: the issue stays reserved until a simulated authoritative answer confirms closure.",
    );
  }

  function reconcileUnknown(rid, issueId, outcome) {
    return updateReceiptItem(
      rid,
      issueId,
      (it) => {
        if (it.result !== "unknown" || it.resolution) return;
        it.resolution = {
          outcome: outcome === "refused" ? "refused" : "accepted",
          at: nowText(),
          source: "Simulated authoritative demo answer",
        };
        it.lifecycle = outcome === "refused" ? "refused" : "queued";
        if (it.reservation) it.reservation.state = "resolved";
        it.lifeAt = it.resolution.at;
      },
      outcome === "refused"
        ? "Simulated authority refusal recorded. The request is not accepted; a new request may be prepared."
        : "Simulated authority acceptance recorded. The request stays queued; nothing was relaunched.",
    );
  }

  function reconcileWithdrawal(rid, issueId, outcome) {
    return updateReceiptItem(
      rid,
      issueId,
      (it) => {
        if (!isAcceptedLike(it)) return;
        if (it.lifecycle !== "withdrawal_requested" && it.lifecycle !== "closure_unknown") return;
        const at = nowText();
        if (outcome === "closed") {
          it.lifecycle = "closed";
          it.closureAt = at;
          it.lifeAt = at;
          if (it.reservation) it.reservation.state = "resolved";
        } else if (outcome === "unknown") {
          it.lifecycle = "closure_unknown";
          it.closureUnknownAt = at;
          it.lifeAt = at;
        } else if (outcome === "refused") {
          it.lifecycle = "queued";
          it.closureAt = null;
          it.lifeAt = at;
        }
      },
      outcome === "closed"
        ? "Simulated confirmed closure recorded. The issue is unlocked; the accepted history is kept."
        : outcome === "unknown"
          ? "Simulated closure unknown recorded. The issue stays reserved; time or an offline machine is not closure."
          : "Simulated withdrawal refusal recorded. The request stays accepted.",
    );
  }

  /* Assessment: simulated checks against sample machine facts -------- */
  const compatibleMachines = (issue, implementer) => {
    const caps = (issue.requires && issue.requires.capabilities) || [];
    return D.machines.filter((base) => {
      const m = machineById(base.id);
      if (!m || m.status !== "connected") return false;
      if (!caps.every((c) => m.capabilities.indexOf(c) >= 0)) return false;
      const repo = repoFor(issue, m.id);
      if (!repo.repo || repo.repo.state !== "found") return false;
      if (!firstTargetFor(m.id, implementer)) return false;
      return D.team.reviewers.every((r) => firstTargetFor(m.id, r.agent));
    });
  };

  function assess(id) {
    const issue = issueById(id);
    const a = assignment(id);
    const m = machineById(a.machine);
    const online = m && m.status === "connected";
    const checks = [];
    const fixes = [];
    let block = null;
    let blockText = null;
    const add = (tone, text, short) => {
      checks.push({ tone, text });
      if (tone === "block" && !block) {
        block = short || text;
        blockText = text;
      }
    };
    const alt = compatibleMachines(
      issue,
      a.implPick.agent || state.draft.defaults.implementer,
    ).filter((x) => x.id !== a.machine)[0];

    if (!m) add("block", "Choose a saved machine.", "No machine");
    else if (online)
      add("ok", `${m.name} is connected. Sample status, last checked ${stamp(m.checked)}.`);
    else
      add(
        "block",
        `${m.name} is offline. ${m.problem || ""}` +
          (alt ? ` Choose a connected machine such as ${alt.name}.` : ""),
        `${m.name} is offline`,
      );

    // Repository target.
    if (a.repo) {
      const repo = a.repo.repo;
      if (!m) add("unknown", "No machine selected, so the repository path cannot be resolved.");
      else if (!repo)
        add("block", `${a.repo.meta.name} is not known on ${m.name}.`, "Repository missing");
      else if (repo.state === "missing") {
        add(
          "block",
          `${a.repo.meta.name} is not on ${m.name}. ${repo.reason || ""} Add it in Settings, Connections (fixture), or choose another machine or repository.`,
          "Repository missing",
        );
        fixes.push({
          kind: "settings",
          machine: m.id,
          repo: a.repo.meta.id,
          label: "Repair repository in Settings, Connections",
        });
      } else if (repo.state === "found" && online)
        add("ok", `Repository found at ${repo.path}, base ${repo.base}.`);
      else if (repo.state !== "found" && online) {
        add(
          "block",
          `Repository ${a.repo.meta.name} is recorded on ${m.name}, but its path or base is unknown, so admission cannot pin a base. Add a sample path in Settings, Connections (fixture), or choose another machine.`,
          "Repository path or base unknown",
        );
        fixes.push({
          kind: "settings",
          machine: m.id,
          repo: a.repo.meta.id,
          label: "Repair repository in Settings, Connections",
        });
      } else if (repo.state !== "found")
        add(
          "unknown",
          `Repository last seen at ${repo.path || "an unknown path"}. It cannot be checked while ${m.name} is offline or unknown.`,
        );
      else if (repo.state === "found")
        add(
          "unknown",
          `Repository path is recorded at ${repo.path}, but ${m.name} is offline. It cannot be checked.`,
        );
    }

    // Required capabilities are separate from preferences.
    const caps = (issue.requires && issue.requires.capabilities) || [];
    if (caps.length) {
      const missing = caps.filter((c) => !m || m.capabilities.indexOf(c) < 0);
      if (missing.length) {
        add(
          "block",
          `${issue.requires.text} ${m ? m.name : "This machine"} does not provide ${listText(
            missing,
          )}. Choose a machine that does, or change the issue's requirements.`,
          `Missing required capability: ${listText(missing)}`,
        );
        const capable = D.machines
          .map((base) => machineById(base.id))
          .find(
            (x) =>
              x &&
              x.id !== a.machine &&
              x.status === "connected" &&
              caps.every((c) => x.capabilities.indexOf(c) >= 0) &&
              (() => {
                const repo = repoFor(issue, x.id);
                return !!(repo.repo && repo.repo.state === "found");
              })(),
          );
        if (capable)
          fixes.push({
            kind: "machine",
            machine: capable.id,
            label: `Use ${capable.name}, which provides ${listText(missing)}`,
            note: "Capability requirement, not a preference.",
          });
      } else add("ok", `${m.name} provides required capability ${listText(caps)}.`);
    }

    // Implementer target: exact instance/model/effort.
    if (!m || !online) {
      add(
        "unknown",
        `Agents cannot be checked while ${m ? m.name : "no machine"} is offline. Last known: ${
          m && m.lastKnown ? m.lastKnown : "not recorded"
        }.`,
      );
    } else if (!a.impl.ok) {
      add("block", a.impl.reason, "Provider target unavailable");
      const altTarget = firstTargetFor(m.id, a.implPick.agent || "");
      if (!altTarget && a.implPick.instance) {
        const replacement = firstTargetFor(m.id, state.draft.defaults.implementer);
        if (replacement)
          fixes.push({
            kind: "model",
            machine: m.id,
            label: `Use this machine's ${replacement.name}`,
            note: "Explicit replacement after the saved provider instance was not found.",
            instance: replacement.instance,
            model: replacement.model,
            effort: replacement.defaultEffort,
          });
      }
      if (!issue.prefers)
        targetsOn(m.id)
          .filter((t) => t.enabled && t.profile)
          .slice(0, 2)
          .forEach((t) =>
            fixes.push({
              kind: "model",
              machine: m.id,
              label: `Use ${t.name} on ${m.name}`,
              note: "Explicit implementer choice; nothing is substituted automatically.",
              instance: t.instance,
              model: t.model,
              effort: t.defaultEffort,
            }),
          );
    } else {
      add(
        "ok",
        `Implementer ${a.impl.target.name} through ${a.impl.target.instanceName} is available on ${m.name}. Effort: ${
          a.impl.effort ? effortLabel(a.impl.effort) : "not offered"
        }. Instance ${a.impl.target.instance}, model ${a.impl.target.model}.`,
      );
    }

    // Reviewers: exact targets, no substitution.
    if (online) {
      const missing = a.reviewers.filter((r) => !r.res.ok);
      if (missing.length)
        add(
          "block",
          `${m.name} cannot resolve reviewer ${listText(
            missing.map((r) => agent(r.agent).name),
          )}. ${missing[0].res.reason}`,
          "Reviewer target unavailable",
        );
      else {
        const dup = a.reviewers.some((r) => r.agent === (a.impl.target && a.impl.target.profile));
        add(
          "ok",
          `Reviewers ${listText(a.reviewers.map((r) => r.res.target.name))} are available on ${m.name}, the same machine as the implementer.`,
        );
        if (dup)
          add("warn", "The implementer is also a reviewer, so its review is less independent.");
      }
    }

    if (a.impl.target && a.impl.target.profile !== D.team.implementer)
      add(
        "info",
        `You chose ${a.impl.target.name} instead of the project default, ${
          agent(D.team.implementer).name
        }. Neokod never swaps agents on its own.`,
      );
    if (a.machineOverridden)
      add("info", `This issue runs on ${m.name} instead of the batch default.`);
    if (a.reviewersOverridden)
      add("info", "This issue uses its own reviewer targets, not the project reviewer defaults.");

    // Preference overrides are explicit; they never masquerade as capability blocks.
    if (issue.prefers) {
      if (issue.prefers.machine === a.machine)
        add(
          "info",
          `Preferred machine: ${machineBase(issue.prefers.machine).name}. ${issue.prefers.text}`,
        );
      else {
        add(
          "warn",
          `Preference override: this issue prefers ${machineBase(issue.prefers.machine).name}; you chose ${m.name}. This is your explicit override, not a capability requirement.`,
        );
        if (machineBase(issue.prefers.machine))
          fixes.push({
            kind: "machine",
            machine: issue.prefers.machine,
            label: `Use preferred machine (${machineBase(issue.prefers.machine).name})`,
            note: "Preference only.",
          });
      }
    }

    // If the preferred machine is blocked for the default implementer, keep the preference
    // visible and offer compatible implementers there rather than recommending a silent move.
    if (issue.prefers && issue.prefers.machine === a.machine && !a.impl.ok) {
      const preferred = machineById(issue.prefers.machine);
      const compatible = preferred
        ? targetsOn(preferred.id).filter((t) => t.enabled && t.profile && t.profile !== "copilot")
        : [];
      compatible.slice(0, 2).forEach((t) =>
        fixes.push({
          kind: "model",
          machine: preferred.id,
          label: `Use ${t.name} on ${preferred.name} (keeps the preference)`,
          note: "Explicit implementer choice on the preferred machine.",
          instance: t.instance,
          model: t.model,
          effort: t.defaultEffort,
        }),
      );
      if (alt)
        fixes.push({
          kind: "machine",
          machine: alt.id,
          label: `Run on ${alt.name} (overrides the preference)`,
          note: "The preferred machine cannot run the default implementer.",
          ...(() => {
            const t = firstTargetFor(alt.id, a.implPick.agent || D.team.implementer);
            return t ? { instance: t.instance, model: t.model, effort: t.defaultEffort } : {};
          })(),
        });
    }

    if (issue.existing) add("block", issue.existing.text, issue.existing.short);
    const active = activeItem(id);
    if (active) {
      const lc = active.item.lifecycle;
      const what =
        active.item.result === "unknown"
          ? active.item.resolution
            ? `${active.item.resolution.outcome} after a simulated unknown acknowledgement`
            : "acknowledgement unknown"
          : "accepted";
      add(
        "block",
        `Already recorded in demo as ${what} in receipt ${active.receipt.id} on ${machineById(active.item.machine).name}${
          lc === "withdrawal_requested"
            ? ", withdrawal requested. A request to withdraw is not closure."
            : lc === "closure_unknown"
              ? ", closure unknown. It stays reserved."
              : ""
        }.`,
        active.item.result === "unknown" && !active.item.resolution
          ? "Acknowledgement unknown in this demo"
          : "Already queued in this demo",
      );
    }
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
      p.savedAt
        ? `Plan r${p.rev}, saved ${stamp(p.savedAt)}.`
        : `Plan r${p.rev}, drafted from the issue.`,
    );
    const gate = gateFor(id);
    if (gate)
      add(
        gate.kind === "blocking" && gate.status === "open" ? "warn" : "info",
        gate.kind === "blocking"
          ? gate.status === "open"
            ? `Blocking question holds ${D.STAGE_NAMES[gate.stage] || gate.stage}: ${gate.question} Saving an answer is not execution approval.`
            : `Blocking question answered: ${gate.decisionLabel}. It held ${D.STAGE_NAMES[gate.stage] || gate.stage}; the saved answer is not execution approval.`
          : `Advisory question (no stage hold): ${gate.question}`,
      );
    if (state.planEdits[id] != null && state.planEdits[id] !== p.text)
      add("warn", "Unsaved plan edits are not included. Save the plan to include them.");

    return {
      ready: !block,
      block,
      blockText,
      fixes,
      checks,
      a,
      m,
      impl: a.impl.target || null,
      gate,
    };
  }

  /* Preview and Start ------------------------------------------------- */
  function sourceForScope(scopeId) {
    const info = scopeById(scopeId);
    return {
      connectionId: info ? info.connection.id : null,
      scopeId,
      scopeRevision: info ? info.scope.revision : 0,
      repoId: scopeId ? state.repoByScope[scopeId] || defaultRepoFor(scopeId) : "",
      fetchedAt: info ? info.scope.fetchedAt : "",
      loaded: scopeId ? loadedFor(scopeId) : 0,
      total: info ? info.scope.total : 0,
    };
  }

  function previewSource() {
    return sourceForScope(state.scopeId);
  }

  function buildPreview() {
    const pins = {};
    const source = previewSource();
    const items = orderedSelected().map((id) => {
      pins[id] = pinKey(id);
      const r = assess(id);
      const p = planOf(id);
      const d = decisionOf(id);
      const issue = issueById(id);
      const prior = priorRequestFor(id);
      const target = r.impl;
      return {
        issueId: id,
        label: labelOf(issue),
        scopeId: issue.scope,
        nativeId: issue.nativeId,
        source: sourceForScope(issue.scope),
        ready: r.ready,
        blockShort: r.block,
        blockText: r.blockText,
        machine: r.a.machine,
        machineOverridden: r.a.machineOverridden,
        implementer:
          (target && target.profile) || r.a.implPick.agent || state.draft.defaults.implementer,
        implementerName: target ? target.name : agent(r.a.implPick.agent).name,
        implementerOverridden: r.a.implementerOverridden,
        instance: target ? target.instance : null,
        instanceName: target ? target.instanceName : null,
        model: target ? target.model : null,
        modelName: target ? target.name : null,
        effort: target && r.a.impl.ok ? r.a.impl.effort : null,
        effortRequired: !!(target && target.efforts.length),
        reviewers: r.a.reviewers.map((rv) => ({
          id: rv.agent,
          name: rv.res.ok ? rv.res.target.name : agent(rv.agent).name,
          instance: rv.res.ok ? rv.res.target.instance : rv.pick.instance || null,
          model: rv.res.ok ? rv.res.target.model : rv.pick.model || null,
          via: rv.res.ok ? rv.res.target.instanceName : agent(rv.agent).via,
          effort: rv.res.ok ? rv.res.effort : rv.pick.effort || null,
          ready: rv.res.ok,
        })),
        workflow: issue.workflow,
        base: (r.a.repo && r.a.repo.repo && r.a.repo.repo.base) || "Unknown base",
        repoPath: (r.a.repo && r.a.repo.repo && r.a.repo.repo.path) || "",
        repoId: r.a.repo ? r.a.repo.meta.id : null,
        planRev: p.rev,
        planText: p.text,
        decision: d ? d.option : null,
        checks: r.checks,
        gate: r.gate,
        issueStamp: issue.updated,
        priorRef: prior ? prior.receipt.id : "",
        previous: prior
          ? {
              receipt: prior.receipt.id,
              issueId: id,
              machine: prior.item.machine,
              at:
                prior.item.closureAt ||
                (prior.item.resolution && prior.item.resolution.at) ||
                prior.receipt.at,
              kind: prior.kind,
            }
          : null,
      };
    });
    const sig = JSON.stringify([
      state.draft.revision,
      pins,
      source,
      state.fixRev,
      items.map((i) => [
        i.issueId,
        i.issueStamp,
        i.priorRef,
        i.ready,
        i.machine,
        i.instance,
        i.model,
        i.effort,
        i.repoId,
        i.source,
        (i.previous && i.previous.receipt) || "",
        i.reviewers.map((r) => [r.id, r.instance, r.model, r.effort]),
      ]),
    ]);
    return {
      key: "wk-" + hash(sig),
      draftRevision: state.draft.revision,
      fixRev: state.fixRev,
      source,
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
        return `The plan or decision for ${labelOf(id)} was saved after it was created.`;
    const info = scopeInfo();
    if (!info) return "The source connection or scope is no longer selected.";
    if (pv.source.connectionId !== state.connectionId)
      return "The source connection changed after it was created.";
    if (pv.source.scopeId !== state.scopeId)
      return "The source scope changed after it was created.";
    if (pv.source.scopeRevision !== info.scope.revision)
      return "The sample source changed after it was created. Fetch or refresh changed its revision.";
    if (pv.source.loaded !== loadedFor(state.scopeId))
      return "The loaded issue coverage changed after it was created.";
    if (pv.source.repoId !== (state.repoByScope[state.scopeId] || defaultRepoFor(state.scopeId)))
      return "The target repository changed after it was created.";
    if (pv.fixRev !== state.fixRev)
      return "Machine, provider or repository settings changed after it was created.";
    const changedSource = pv.items.find(
      (i) => JSON.stringify(i.source) !== JSON.stringify(sourceForScope(i.scopeId)),
    );
    if (changedSource)
      return `The source evidence for ${labelOf(changedSource.issueId)} changed after preview. Preview again.`;
    const edited = pv.items.find((i) => {
      const cur = issueById(i.issueId);
      return !cur || cur.updated !== i.issueStamp;
    });
    if (edited) return `The issue ${labelOf(edited.issueId)} changed after it was created.`;
    const moved = pv.items.find((i) => {
      const active = activeItem(i.issueId);
      return active && active.receipt.id !== pv.receiptId;
    });
    if (moved)
      return `Another tab or receipt already recorded ${labelOf(moved.issueId)}. This preview is out of date.`;
    return null;
  }

  function invalidatePreviewForSettings() {
    // The preview keeps its snapshot for inspection; staleReason reports the change.
    state.startError = null;
  }

  async function startDemo(outcome) {
    const pv = state.preview;
    const out = outcome || state.outcome || "accepted";
    if (!pv) return { ok: false, reason: "Create a preview first." };
    if (pv.receiptId)
      return {
        ok: true,
        replay: true,
        receiptId: pv.receiptId,
        accepted: 0,
        unknown: 0,
        refused: 0,
        blocked: 0,
      };
    const guard = startGuard();
    if (!guard.ok) {
      state.startError = guard.reason;
      render();
      return { ok: false, reason: guard.reason };
    }
    const stale = staleReason(pv);
    if (stale) {
      state.startError = "This preview is out of date. " + stale;
      render();
      return { ok: false, reason: state.startError };
    }
    if (!pv.items.some((i) => i.ready)) {
      state.startError = "Nothing in this preview is ready to start.";
      render();
      return { ok: false, reason: state.startError };
    }
    if (state.starting) return { ok: false, reason: "A start is already in progress." };
    state.starting = true;
    state.startError = null;
    render();
    const result = await withReceiptLock(() => {
      // Re-read, re-check the snapshot and allocate inside the lock.
      const read = readReceiptStore();
      if (!read.ok) {
        state.receiptsError = read.error;
        return { ok: false, reason: read.error };
      }
      const receipts = read.value;
      const againStale = staleReason(pv);
      if (againStale)
        return {
          ok: false,
          reason: "The preview changed while waiting for the receipt lock. " + againStale,
        };
      const replay = receipts.find(
        (r) => r.key === pv.key && r.items.some((it) => isAdmission(it) && isActive(it)),
      );
      state.receipts = receipts;
      if (replay) {
        pv.receiptId = replay.id;
        return {
          ok: true,
          replay: true,
          receiptId: replay.id,
          accepted: 0,
          unknown: 0,
          refused: 0,
          blocked: 0,
        };
      }
      const id = newId();
      if (!id)
        return {
          ok: false,
          reason:
            "This browser does not provide crypto.randomUUID, so a non-colliding receipt ID cannot be allocated. Start is off.",
        };
      const at = nowText();
      const items = pv.items.map((it) => {
        const rec = {
          issueId: it.issueId,
          issueTitle: issueById(it.issueId).title,
          source: it.source,
          scopeId: it.scopeId,
          nativeId: it.nativeId,
          result: "blocked",
          reason: it.blockText || null,
          machine: it.machine,
          machineOverridden: it.machineOverridden,
          implementer: it.implementer,
          implementerOverridden: it.implementerOverridden,
          effort: it.effort || "",
          effortRequired: !!it.effortRequired,
          instance: it.instance,
          instanceName: it.instanceName,
          model: it.model,
          modelName: it.modelName,
          reviewers: it.reviewers,
          workflow: it.workflow,
          base: it.base,
          repoPath: it.repoPath,
          repoId: it.repoId,
          planRev: it.planRev,
          planText: it.planText,
          decision: it.decision,
          checks: it.checks,
          gate: it.gate,
          previous: it.previous,
          lifecycle: null,
          lifeAt: null,
          reservation: null,
          resolution: null,
        };
        if (!it.ready) return rec;
        if (!it.instance || !it.model || (it.effortRequired && !it.effort)) {
          rec.reason =
            "The exact provider instance, model or supported effort is missing, so this item cannot start.";
          return rec;
        }
        const locked = activeItemFrom(receipts, it.issueId);
        if (locked) {
          rec.reason = `Already recorded in receipt ${locked.receipt.id} as ${
            locked.item.result === "unknown" ? "acknowledgement unknown" : "accepted"
          }. Nothing new was admitted.`;
          return rec;
        }
        if (out === "refused") {
          rec.result = "refused";
          rec.reason =
            "Simulated typed target refusal: the sample target paused new admissions for this queue. This is a demo refusal, not a timeout or an offline machine.";
          return rec;
        }
        if (out === "unknown") {
          rec.result = "unknown";
          rec.reason =
            "Simulated lost acknowledgement: no authoritative answer was received. The request key and target reservation are kept; it stays locked until a simulated authoritative answer resolves it.";
          rec.lifecycle = "queued";
          rec.lifeAt = at;
          rec.reservation = {
            requestKey: pv.key,
            machine: it.machine,
            at,
            state: "unresolved",
          };
          return rec;
        }
        rec.result = "accepted";
        rec.reason = null;
        rec.lifecycle = "queued";
        rec.lifeAt = at;
        return rec;
      });
      const admitted = items.filter((i) => i.result !== "blocked").length;
      if (!admitted)
        return {
          ok: false,
          reason: "Every item is blocked at preview or already reserved. No receipt was written.",
        };
      const receipt = {
        id,
        key: pv.key,
        at,
        outcome: out,
        source: pv.source,
        fixRev: pv.fixRev,
        items,
      };
      const next = receipts.concat([receipt]);
      const write = writeReceipts(next);
      if (!write.ok) return { ok: false, reason: write.error };
      // Only now, after a successful write, is the result acknowledged on the page.
      state.receipts = next;
      state.receiptsError = null;
      pv.receiptId = id;
      const accepted = items.filter((i) => i.result === "accepted").length;
      const unknown = items.filter((i) => i.result === "unknown").length;
      const refused = items.filter((i) => i.result === "refused").length;
      const blocked = items.filter((i) => i.result === "blocked").length;
      return { ok: true, receiptId: id, accepted, unknown, refused, blocked };
    });
    state.starting = false;
    if (!result.ok) {
      state.startError = result.reason;
      render();
      return result;
    }
    const touched = result.receiptId
      ? (receiptById(result.receiptId) || { items: [] }).items
          .filter((i) => i.result === "accepted" || i.result === "unknown")
          .map((i) => i.issueId)
      : [];
    if (touched.length) {
      changeDraft((d) => dropFromDraft(d, touched));
      patchSavedDraft(touched);
      state.highlight = result.receiptId;
      state.view = "runs";
      state.runSel = { receipt: result.receiptId, issue: touched[0] };
      state.runTab = "summary";
      state.runDetailOpen = false;
      render("rc-" + result.receiptId);
    } else {
      render();
    }
    if (result.replay) {
      toast(
        `Already recorded as ${result.receiptId}. Starting the same request again queued nothing new. Simulated demo only.`,
      );
    } else {
      toast(
        `Demo only, simulated: ${result.receiptId} recorded ${plural(
          result.accepted,
          "accepted item",
        )}, ${result.unknown} acknowledgement unknown, ${result.refused} refused, ${
          result.blocked
        } blocked. No agent started.`,
      );
    }
    return result;
  }

  function activeItemFrom(receipts, id) {
    for (const r of receipts)
      for (const it of r.items)
        if (it.issueId === id && isActive(it)) return { receipt: r, item: it };
    return null;
  }

  function openReceipt(rid) {
    const r = receiptById(rid);
    if (!r) return;
    const first = r.items.find((i) => isAdmission(i)) || r.items[0];
    state.view = "runs";
    state.runSel = first ? { receipt: rid, issue: first.issueId } : state.runSel;
    state.runDetailOpen = false;
    render("rc-" + rid);
  }

  function currentRun() {
    const s = state.runSel;
    if (s) {
      const r = receiptById(s.receipt);
      const it = r && r.items.find((x) => x.issueId === s.issue);
      if (it) return { r, it };
    }
    for (let k = state.receipts.length - 1; k >= 0; k--) {
      const r = state.receipts[k];
      const it = r.items.find((x) => isAdmission(x));
      if (it) return { r, it };
    }
    return null;
  }

  /* Render: flow bar --------------------------------------------------- */
  function previewSummary() {
    const pv = state.preview;
    if (!pv) return "Not created";
    if (pv.receiptId) {
      const r = receiptById(pv.receiptId);
      const unknown = r && r.items.some((i) => i.result === "unknown");
      return unknown
        ? `Unknown: ${pv.receiptId.slice(0, 10)}`
        : `Recorded ${pv.receiptId.slice(0, 10)}`;
    }
    if (staleReason(pv)) return "Out of date";
    const ready = pv.items.filter((i) => i.ready).length;
    return `${ready} ready, ${pv.items.length - ready} blocked`;
  }

  function renderSteps() {
    const n = state.draft.selected.length;
    const q = activeCount();
    const pvState = previewSummary();
    const steps = [
      ["work", "1", "Select and assign", n ? `${n} selected` : "Nothing selected"],
      ["preview", "2", "Preview", pvState],
      ["runs", "3", "Saved requests", q ? `${q} active (demo)` : "None yet"],
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
    const err = state.recoveryError ? " · recovery copy failed" : "";
    const html = `<span class="wk-dot ${s.dirty ? "is-dirty" : "is-clean"}" aria-hidden="true"></span>${esc(
      s.text,
    )}${esc(err)}`;
    const el = $("wk-savestate");
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function storageBanner() {
    const bits = [];
    if (!state.storageProbe.ok)
      bits.push(
        `<div class="wk-stale" role="alert">${icon("alert")}<p><strong>Local storage is unavailable.</strong> ${esc(
          state.storageProbe.reason,
        )}</p></div>`,
      );
    if (state.receiptsError)
      bits.push(
        `<div class="wk-stale" role="alert">${icon("alert")}<p><strong>Stored demo receipts are unreadable.</strong> ${esc(
          state.receiptsError,
        )}</p><p>Nothing has been overwritten. Use Reset demo only if you deliberately want to clear the stored demo.</p></div>`,
      );
    if (state.recoveryError)
      bits.push(
        `<div class="wk-stale" role="alert">${icon("alert")}<p>${esc(state.recoveryError)}</p></div>`,
      );
    if (state.startError)
      bits.push(
        `<div class="wk-stale" role="alert">${icon("alert")}<p><strong>Start did not record anything.</strong> ${esc(
          state.startError,
        )}</p></div>`,
      );
    if (state.sourceChanged)
      bits.push(
        `<div class="wk-stale" role="status">${icon("history")}<p><strong>Sample source changed.</strong> ${esc(
          state.sourceChanged,
        )}. Existing previews are out of date; create a new preview before starting.</p></div>`,
      );
    if (state.recovered)
      bits.push(
        `<div class="wk-done" role="status">${icon("history")}<p><strong>Recovered unsaved work.</strong> Edits and an unsaved draft from ${esc(
          demoStamp(state.recovered.at),
        )} were restored from this browser. Review them, save explicitly, or discard the recovery.</p><button type="button" class="btn sm" id="wk-recovered-discard" data-act="discard-recovery">Discard recovered edits</button></div>`,
      );
    return bits.join("");
  }

  /* Render: Work view -------------------------------------------------- */
  function scopeRemaining(info) {
    return info ? Math.max(0, info.scope.total - loadedFor(info.scope.id)) : 0;
  }
  function effectiveScopeState(info) {
    if (!info) return "none";
    const s = info.scope.state;
    if (s === "loading" || s === "error" || s === "empty") return s;
    return scopeRemaining(info) > 0 ? "partial" : "ready";
  }
  function scopeStatusText(info) {
    if (!info) return "No source selected.";
    const s = info.scope;
    const loaded = loadedFor(s.id);
    const remaining = scopeRemaining(info);
    const state = effectiveScopeState(info);
    if (state === "loading")
      return `Loading sample issues from ${s.nativeId}. This is a fixture loading state; nothing is fetched.`;
    if (state === "error") return s.error || "The sample source failed to load.";
    if (state === "empty")
      return `Empty result: 0 matching issues. Fetched ${stamp(s.fetchedAt)}. This is a fetched empty state, not a failure.`;
    if (state === "partial")
      return `Partial: ${loaded} of ${s.total} matching issues loaded, fetched ${stamp(
        s.fetchedAt,
      )}. ${plural(remaining, "issue remains", "issues remain")} on a next page.`;
    return `Complete: loaded ${loaded} of ${s.total} matching issues, fetched ${stamp(
      s.fetchedAt,
    )}. No remaining page.`;
  }

  function renderSourceSection() {
    const conn = connectionById(state.connectionId);
    const info = scopeInfo();
    const connOptions = D.connections
      .map(
        (c) =>
          `<option value="${esc(c.id)}"${c.id === state.connectionId ? " selected" : ""}>${esc(
            c.name,
          )}${c.state === "error" ? " (sample error)" : ""}</option>`,
      )
      .join("");
    const scopeOptions = conn
      ? conn.scopes
          .map(
            (s) =>
              `<option value="${esc(s.id)}"${s.id === state.scopeId ? " selected" : ""}>${esc(
                s.project.key,
              )} · ${esc(s.name)}${s.state === "empty" ? " (empty)" : ""}</option>`,
          )
          .join("")
      : "";
    const repoOptions =
      info && info.scope.repositories
        ? info.scope.repositories
            .map(
              (r) =>
                `<option value="${esc(r.id)}"${
                  r.id === repoIdFor({ scope: info.scope.id }) ? " selected" : ""
                }>${esc(r.name)}</option>`,
            )
            .join("")
        : "";
    const effective = info ? effectiveScopeState(info) : "none";
    const statePill =
      effective === "loading"
        ? lpill("quiet", "history", "Loading")
        : effective === "partial"
          ? lpill("attn", "alert", "Partial")
          : effective === "empty"
            ? lpill("quiet", "minus", "Empty")
            : effective === "error"
              ? lpill("danger", "x", "Unavailable")
              : lpill("neutral", "check", "Complete");
    return `<section class="wk-sec wk-sec-project">
      <p class="wk-project">${icon("folder")}<span>${esc(
        info ? info.scope.project.name : conn ? conn.name : "Neokod",
      )}</span></p>
      <div class="wk-form wk-source-form">
        <label for="wk-conn">Connection</label>
        <select id="wk-conn" class="field">${connOptions}</select>
        <label for="wk-scope">Project scope</label>
        <select id="wk-scope" class="field"${scopeOptions ? "" : " disabled"}>${
          scopeOptions || '<option value="">No scope loaded</option>'
        }</select>
        <label for="wk-repo">Repository</label>
        <select id="wk-repo" class="field"${repoOptions ? "" : " disabled"}>${
          repoOptions || '<option value="">No repository</option>'
        }</select>
      </div>
      ${
        conn && conn.state === "error"
          ? `<div class="wk-stale" role="alert">${icon("alert")}<p><strong>Connection unavailable.</strong> ${esc(
              conn.error,
            )}</p><button type="button" class="btn sm" data-act="repair-connection">Repair sample connection (fixture)</button></div>`
          : `<p class="wk-coverage">${statePill}<span>${esc(scopeStatusText(info))}</span></p>
             <dl class="wk-facts">
               <dt>Connection ID</dt><dd class="mono">${esc(state.connectionId || "none")}</dd>
               <dt>Scope ID</dt><dd class="mono">${esc(state.scopeId || "none")} / ${esc(
                 info ? info.scope.nativeId : "none",
               )}</dd>
               <dt>Revision</dt><dd>${info ? info.scope.revision : 0} (sample source)</dd>
             </dl>
             <p class="wk-links">
               ${
                 info && loadedFor(info.scope.id) < info.scope.total
                   ? `<button type="button" class="btn sm" id="act-load-more" data-act="load-more">Load ${plural(
                       info.scope.total - loadedFor(info.scope.id),
                       "more issue",
                     )}</button>`
                   : ""
               }
               <button type="button" class="btn ghost sm" data-act="refresh-source">Refresh sample source</button>
             </p>`
      }
      <p class="wk-hint">Fixture connection. No network request is made and no token is read or stored. ${
        info && info.scope.unsupported.length
          ? `Only ${listText(info.scope.filters)} filters are supported here; ${listText(
              info.scope.unsupported,
            )} filters are not offered.`
          : ""
      }</p>
    </section>`;
  }

  function renderSide() {
    const machines = D.machines
      .map((base) => {
        const m = machineById(base.id);
        const n = m.providers.reduce((x, p) => x + p.models.length, 0);
        return `<li><button type="button" class="wk-mbtn" id="mb-${m.id}" data-machine="${
          m.id
        }" aria-pressed="${state.machineOpen === m.id}">
          <span class="wk-dot ${m.status === "connected" ? "is-on" : "is-off"}" aria-hidden="true"></span>
          <span class="nm">${esc(m.name)}</span>
          <span class="st">${esc(m.statusText)}</span>
          <span class="sub">${esc(m.os)}${
            m.status === "connected" ? `, ${plural(n, "provider model")}` : ", agents unknown"
          }</span>
        </button></li>`;
      })
      .join("");
    $("wk-side").innerHTML = `
      ${renderSourceSection()}
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
        <p class="demo-note">Saved in Settings, Connections, Machines. These are sample machines, not machines detected on this computer. Open one for its scoped sample Settings, Connections panel.</p>
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
    $("wk-main").innerHTML = `
      <div class="wk-head">
        <h1 class="wk-h1" id="wk-h1">Agent-ready issues</h1>
        <p class="wk-coverage" id="wk-coverage"></p>
      </div>
      <div id="wk-storage"></div>
      <div class="wk-toolbar">
        <label class="wk-search">
          ${icon("search")}
          <span class="sr-only">Search loaded issues</span>
          <input id="wk-q" type="search" placeholder="Search loaded issues by ID, title or label" autocomplete="off" />
          <span class="kbd" aria-hidden="true">/</span>
        </label>
        <label class="wk-labelsel" id="wk-labelsel">
          <span class="sr-only">Filter by label</span>
          <select id="wk-label" class="field">
            <option value="all">Any label</option>
          </select>
        </label>
      </div>
      <div class="wk-chips" id="wk-chips" role="group" aria-label="Filter by workflow"></div>
      <p class="wk-unsupported" id="wk-unsupported"></p>
      <div class="wk-listhead" id="wk-listhead"></div>
      <div class="wk-list" id="wk-list" role="list" aria-label="Loaded issues"></div>
      <div id="wk-loadmore"></div>
      <div id="wk-hiddensel"></div>
      <div class="wk-batch" id="wk-batch" role="region" aria-label="Selected work"></div>`;
  }

  function currentIssues() {
    if (!state.scopeId) return [];
    const info = scopeInfo();
    if (!info || info.scope.state === "loading") return [];
    const n = loadedFor(state.scopeId);
    return issuesForScope(state.scopeId).slice(0, n);
  }

  function filteredIssues() {
    const q = state.q.trim().toLowerCase();
    const info = scopeInfo();
    const supportsLabel = info && info.scope.filters.indexOf("label") >= 0;
    return currentIssues().filter(
      (i) =>
        (state.wf === "all" || i.workflow === state.wf) &&
        (!supportsLabel || state.label === "all" || i.labels.indexOf(state.label) >= 0) &&
        (!q || (i.label + " " + i.title + " " + i.labels.join(" ")).toLowerCase().indexOf(q) >= 0),
    );
  }

  const isSelectable = (i) => !activeItem(i.id) && !i.existing && state.scopeId === i.scope;

  function issueRow(i) {
    const sel = isSelected(i.id);
    const active = activeItem(i.id);
    let runOn;
    let ready;
    if (active) {
      runOn = mchip(active.item.machine);
      ready = `${effectivePill(active.item)}<button type="button" class="linkish wk-openrun" id="or-${hash(
        i.id,
      )}" data-openrun="${esc(active.receipt.id)}|${esc(i.id)}">Open request</button>`;
    } else if (i.existing) {
      runOn = mchip(i.existing.machine);
      ready = `${lpill("quiet", "lock", "Not selectable")}<a class="linkish" id="ex-${hash(
        i.id,
      )}" href="runs.html#${esc(i.existing.anchor)}">Open existing run: ${esc(
        machineById(i.existing.machine).name,
      )}, ${esc(i.existing.item)}, accepted record ${esc(i.existing.record)}</a>`;
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
      ready = "";
    }
    const cbLabel = active
      ? `${labelOf(i)} is already recorded in the demo`
      : i.existing
        ? `${labelOf(i)} already has an existing run and cannot be selected as new work`
        : `Select ${labelOf(i)}, ${i.title}`;
    return `<div class="wk-row${sel ? " is-sel" : ""}${active ? " is-acc" : ""}${
      i.existing ? " is-existing" : ""
    }" role="listitem" data-row="${esc(i.id)}"${
      state.focusId === i.id ? ' aria-current="true"' : ""
    }>
      <span class="wk-cbwrap"><input type="checkbox" class="wk-cb" id="cb-${hash(
        i.id,
      )}" data-cb="${esc(i.id)}"${sel ? " checked" : ""}${
        !isSelectable(i) ? " disabled" : ""
      } aria-label="${esc(cbLabel)}" /></span>
      <span class="wk-id">${esc(labelOf(i))}${
        i.scope !== "scope_neo_open" ? '<span class="wk-scopetag">other scope</span>' : ""
      }</span>
      <button type="button" class="wk-title" id="tt-${hash(i.id)}" data-inspect="${esc(i.id)}">
        <span class="t">${esc(i.title)}</span>
        <span class="s"><span>${esc(wf(i.workflow).name)}</span><span>${esc(
          i.labels.join(", "),
        )}</span><span>Edited ${esc(stamp(i.updated))}</span>${
          i.shared ? '<span class="wk-sharedtag">Shared sample</span>' : ""
        }${i.requires ? '<span class="wk-sharedtag">Requires ' + esc(i.requires.capabilities.join(", ")) + "</span>" : ""}</span>
      </button>
      <span class="wk-runon">${runOn}</span>
      <span class="wk-ready">${ready}</span>
    </div>`;
  }

  function renderMain() {
    const info = scopeInfo();
    const conn = connectionById(state.connectionId);
    const h1 = $("wk-h1");
    if (h1) h1.textContent = info ? info.scope.name : "Source unavailable";
    const cov = $("wk-coverage");
    if (cov)
      cov.innerHTML = `${icon("history")}<span>${esc(scopeStatusText(info))} ${
        info
          ? `Canonical scope ${esc(info.scope.nativeId)} on ${esc(info.connection.name)}. Selecting visible never includes unseen matches or another scope.`
          : "Choose a connection with a loaded scope, or repair the sample connection."
      }</span>`;
    const storage = $("wk-storage");
    if (storage) storage.innerHTML = storageBanner();

    const supportedLabel = !!(info && info.scope.filters.indexOf("label") >= 0);
    const labelSel = $("wk-labelsel");
    if (labelSel) labelSel.hidden = !supportedLabel;
    if (supportedLabel) {
      const labels = Array.from(new Set(currentIssues().flatMap((i) => i.labels))).sort();
      const sel = $("wk-label");
      if (sel) {
        sel.innerHTML =
          '<option value="all">Any label</option>' +
          labels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("");
        sel.value = labels.indexOf(state.label) >= 0 ? state.label : "all";
      }
    }
    const unsupported = $("wk-unsupported");
    if (unsupported)
      unsupported.textContent =
        info && info.scope.unsupported.length
          ? `Not offered by this connection: ${listText(info.scope.unsupported)} filters. Search only covers the ${loadedFor(
              info.scope.id,
            )} loaded issues.`
          : "";

    const qEl = $("wk-q");
    if (qEl && qEl.value !== state.q) qEl.value = state.q;

    const wfs = ["all"].concat(Object.keys(D.workflows));
    const chips = $("wk-chips");
    if (chips)
      chips.innerHTML = wfs
        .map((w) => {
          const n = currentIssues().filter((i) => w === "all" || i.workflow === w).length;
          return `<button type="button" id="wf-${w}" data-wf="${w}" aria-pressed="${
            state.wf === w
          }">${esc(w === "all" ? "All workflows" : wf(w).name)}<span class="n">${n}</span></button>`;
        })
        .join("");

    const list = filteredIssues();
    const selectable = list.filter(isSelectable);
    const selVis = selectable.filter((i) => isSelected(i.id)).length;
    const all = selectable.length > 0 && selVis === selectable.length;
    const head = $("wk-listhead");
    if (head)
      head.innerHTML = `
      <label class="wk-selvis"><input type="checkbox" id="wk-selvis"${all ? " checked" : ""}${
        selectable.length ? "" : " disabled"
      } /><span>Select visible (${selectable.length})</span></label>
      <span class="wk-col wk-col-runon">Run on</span>
      <span class="wk-col wk-col-ready">Readiness</span>`;
    const sv = $("wk-selvis");
    if (sv) sv.indeterminate = selVis > 0 && !all;

    let listHtml;
    if (!info)
      listHtml = `<div class="wk-empty" role="listitem"><p>${
        conn && conn.state === "error" ? esc(conn.error) : "No scope is selected."
      }</p><button type="button" class="btn sm" data-act="${
        conn && conn.state === "error" ? "repair-connection" : "refresh-source"
      }">${conn && conn.state === "error" ? "Repair sample connection" : "Try the sample fetch again"}</button></div>`;
    else if (info.scope.state === "loading")
      listHtml = `<div class="wk-empty" role="listitem"><p>Loading sample issues… This fixture wait demonstrates the loading state; no request is made.</p></div>`;
    else if (info.scope.state === "error")
      listHtml = `<div class="wk-empty" role="listitem"><p><strong>This scope did not load.</strong> ${esc(
        info.connection.error || "The sample source failed.",
      )}</p><button type="button" class="btn sm" data-act="repair-connection">Repair sample connection (fixture)</button></div>`;
    else if (info.scope.state === "empty")
      listHtml = `<div class="wk-empty" role="listitem"><p>Fetched successfully: no issue matches this scope. This is an empty result, not a load failure.</p><button type="button" class="btn sm" data-act="refresh-source">Fetch again</button></div>`;
    else if (list.length) listHtml = list.map(issueRow).join("");
    else
      listHtml = `<div class="wk-empty" role="listitem"><p>No loaded issue matches these filters. Unloaded issues are never selected.</p><button type="button" class="btn sm" id="act-clear-filters" data-act="clear-filters">Clear filters</button></div>`;
    const listEl = $("wk-list");
    if (listEl) listEl.innerHTML = listHtml;

    const more = info ? info.scope.total - loadedFor(info.scope.id) : 0;
    const loadmore = $("wk-loadmore");
    if (loadmore)
      loadmore.innerHTML =
        info && more > 0
          ? `<div class="wk-loadmore"><p>${more} matching ${more === 1 ? "issue is" : "issues are"} not loaded. They cannot be selected.</p><button type="button" class="btn sm" data-act="load-more">Load more (${more})</button></div>`
          : "";

    const hidden = state.draft.selected.filter((id) => !list.some((i) => i.id === id)).length;
    const hiddenEl = $("wk-hiddensel");
    if (hiddenEl)
      hiddenEl.innerHTML = hidden
        ? `<p class="wk-hiddensel">${icon("eye")}<span>${plural(
            hidden,
            "selected issue is",
            "selected issues are",
          )} hidden by the current filters or scope and stay${
            hidden === 1 ? "s" : ""
          } selected. Unseen issues are never added.</span><button type="button" class="linkish" id="act-show-all" data-act="clear-filters">Show all</button></p>`
        : "";

    const n = state.draft.selected.length;
    const dirty = draftStatus().dirty;
    const defM = machineById(state.draft.defaults.machine);
    const defPick = {
      agent: state.draft.defaults.implementer,
      effort: state.draft.defaults.effort,
    };
    const defSum = pickSummary(state.draft.defaults.machine, defPick);
    const blocked = orderedSelected().filter((id) => !assess(id).ready).length;
    const batch = $("wk-batch");
    if (batch)
      batch.innerHTML = `
      <span class="wk-batch-n"><strong>${n}</strong> selected${
        n && blocked ? `<span class="wk-batch-blk">, ${blocked} blocked</span>` : ""
      }</span>
      <span class="wk-batch-def">Defaults: ${esc(defM ? defM.name : "No machine")}, ${esc(
        defSum.label,
      )}</span>
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

  /* Composer-shaped model control (UX-04) ----------------------------- */
  const modelRegistry = Object.create(null);

  function providerDefaultInstance(m, pick) {
    if (!m || !m.providers.length) return "";
    if (pick && pick.instance && providerFor(m, pick.instance)) return pick.instance;
    const byAgent =
      pick && pick.agent
        ? m.providers.find((p) => p.models.some((x) => x.profile === pick.agent)) || null
        : null;
    return (byAgent || m.providers.find((p) => p.models.some((x) => x.enabled)) || m.providers[0])
      .id;
  }

  function modelControl(ctx, desc) {
    const m = machineById(desc.machine);
    const pick = desc.pick || {};
    const sum = pickSummary(desc.machine, pick);
    const open = state.modelOpen === ctx;
    const disabledReason = !m
      ? "Choose a saved machine first."
      : m.status !== "connected"
        ? `${m.name} is offline, so its provider instances cannot be checked.`
        : null;
    modelRegistry[ctx] = desc;
    const instId = state.modelInstance[ctx] || providerDefaultInstance(m, sum.ok ? sum : pick);
    const provider = providerFor(m, instId);
    const query = (state.modelQuery || "").trim().toLowerCase();
    const allTargets = m ? targetsOn(desc.machine) : [];
    const rows = m
      ? (query ? allTargets : allTargets.filter((t) => t.instance === instId)).filter(
          (t) =>
            !query ||
            (t.name + " " + t.model + " " + t.instanceName + " " + (t.profile || ""))
              .toLowerCase()
              .indexOf(query) >= 0,
        )
      : [];
    const activeTarget = sum.ok
      ? allTargets.find((t) => t.instance === sum.instance && t.model === sum.model)
      : null;
    const effortTarget = activeTarget || (rows.length === 1 ? rows[0] : null);
    const inherited = desc.allowDefault
      ? desc.kind === "implDefault"
        ? "Project default implementer"
        : "Project default reviewer"
      : "This issue only";
    return `<div class="wk-model${disabledReason ? " is-disabled" : ""}" data-model-ctx="${esc(ctx)}">
      <button type="button" class="btn ghost sm wk-model-trigger" id="wk-model-trigger-${esc(
        ctx,
      )}" data-model-open="${esc(ctx)}" aria-expanded="${open}" aria-controls="wk-model-pop-${esc(
        ctx,
      )}"${disabledReason ? " disabled" : ""}>
        <span class="wk-model-instance">${esc(sum.instanceName || (m ? m.name : "No machine"))}</span>
        <span class="wk-model-summary">${esc(sum.label)}</span>
        <span class="wk-model-caret" aria-hidden="true">${icon("chevronDown")}</span>
      </button>
      <span class="wk-model-inherit">${esc(inherited)}</span>
      ${
        disabledReason
          ? `<span class="wk-model-disabled" role="note">${esc(disabledReason)}</span>`
          : sum.ok
            ? ""
            : `<span class="wk-model-warn" role="note">${esc(sum.reason)}</span>`
      }
      ${
        open
          ? `<div class="wk-model-pop" id="wk-model-pop-${esc(ctx)}" role="group" aria-label="Provider instance, model and effort">
          <p class="wk-model-note">Choose the provider instance, model and effort on this machine. Availability is sample data; no provider is contacted.</p>
          <label class="wk-model-search"><span class="sr-only">Search models on ${esc(
            m ? m.name : "the selected machine",
          )}</span><input class="field" id="wk-model-q-${esc(
            ctx,
          )}" type="search" data-model-q="${esc(
            ctx,
          )}" value="${esc(state.modelQuery || "")}" placeholder="Search models or provider instances" autocomplete="off" /></label>
          <div class="wk-model-body">
            <div class="wk-model-instances" role="group" aria-label="Provider instances">
              ${(m ? m.providers : [])
                .map(
                  (p) =>
                    `<button type="button" class="wk-model-instance-row${
                      p.id === instId ? " is-active" : ""
                    }" data-model-instance="${esc(ctx)}|${esc(p.id)}" aria-pressed="${
                      p.id === instId
                    }">${esc(p.name)}<span class="sub">${esc(p.account)}</span></button>`,
                )
                .join("")}
            </div>
            <div class="wk-model-list" role="group" aria-label="Models">
              ${
                rows.length
                  ? rows
                      .map((t) => {
                        const disabled = !t.enabled;
                        return `<button type="button" class="wk-model-row${
                          activeTarget &&
                          activeTarget.instance === t.instance &&
                          activeTarget.model === t.model
                            ? " is-active"
                            : ""
                        }${disabled ? " is-disabled" : ""}" data-model-pick="${esc(
                          ctx,
                        )}|${esc(t.instance)}|${esc(t.model)}"${
                          disabled ? " disabled" : ""
                        } aria-pressed="${
                          !!activeTarget &&
                          activeTarget.instance === t.instance &&
                          activeTarget.model === t.model
                        }">
                          <span class="wk-model-name">${esc(t.name)}${
                            t.profile === D.team.implementer && !desc.allowDefault
                              ? '<span class="suggested">default implementer</span>'
                              : t.profile
                                ? `<span class="wk-model-tag">${esc(agent(t.profile).name)}</span>`
                                : ""
                          }</span>
                          <span class="wk-model-slug mono">${esc(t.model)}</span>
                          <span class="wk-model-eff">${esc(
                            t.efforts.length
                              ? "Effort: " + t.efforts.join(", ")
                              : "No effort setting offered",
                          )}</span>
                          ${
                            disabled
                              ? `<span class="wk-model-disabled">${esc(
                                  t.reason || "Not available for this sample account.",
                                )}</span>`
                              : ""
                          }
                        </button>`;
                      })
                      .join("")
                  : `<p class="muted">No model matches this search on ${esc(
                      m ? m.name : "this machine",
                    )}. Nothing is substituted.</p>`
              }
            </div>
          </div>
          <div class="wk-model-footer">
            <span class="wk-model-footer-label">Provider options</span>
            ${
              effortTarget
                ? effortTarget.efforts.length
                  ? `<span class="wk-model-efforts" role="group" aria-label="Effort">${effortTarget.efforts
                      .map(
                        (e) =>
                          `<button type="button" class="btn sm wk-model-effort${
                            sum.effort === e ? " is-active" : ""
                          }" data-model-effort="${esc(ctx)}|${esc(e)}" aria-pressed="${
                            sum.effort === e
                          }">${esc(effortLabel(e))}</button>`,
                      )
                      .join("")}</span>`
                  : `<span class="faint">No effort setting offered by ${esc(
                      effortTarget.instanceName,
                    )}. That is a supported state, not a missing value.</span>`
                : `<span class="faint">Choose an available model to see its supported effort.</span>`
            }
            ${
              desc.allowDefault
                ? `<button type="button" class="btn ghost sm" data-model-reset="${esc(
                    ctx,
                  )}">Use project default</button>`
                : `<button type="button" class="btn ghost sm" data-model-reset="${esc(
                    ctx,
                  )}">Clear this issue's override</button>`
            }
          </div>
        </div>`
          : ""
      }
    </div>`;
  }

  function applyModelPick(ctx, instance, modelId, effortOverride) {
    const desc = modelRegistry[ctx];
    if (!desc) return;
    const m = machineById(desc.machine);
    const target = targetsOn(desc.machine).find(
      (t) => t.instance === instance && t.model === modelId,
    );
    if (!target || !target.enabled) {
      toast("That model is not available for this sample provider instance.");
      return;
    }
    const effort =
      effortOverride != null
        ? effortOverride
        : target.efforts.indexOf(desc.pick && desc.pick.effort) >= 0
          ? desc.pick.effort
          : target.defaultEffort;
    changeDraft((d) => {
      if (desc.kind === "implDefault") {
        d.defaults.implementer = target.profile || d.defaults.implementer;
        d.defaults.effort = effort || "";
        d.defaults.instance = target.instance;
        d.defaults.model = target.model;
      } else if (desc.kind === "revDefault") {
        d.defaults.reviewers[desc.index] = {
          agent: target.profile,
          effort: effort || "",
          instance: target.instance,
          model: target.model,
        };
      } else {
        const o = Object.assign({}, d.overrides[desc.id]);
        if (desc.kind === "implItem") {
          o.implementer = target.profile || o.implementer;
          o.instance = target.instance;
          o.model = target.model;
          o.effort = effort || "";
          if (o.machine === d.defaults.machine) delete o.machine;
        } else {
          const picks = (o.reviewers || d.defaults.reviewers).map((r) => Object.assign({}, r));
          picks[desc.index] = {
            agent: target.profile,
            instance: target.instance,
            model: target.model,
            effort: effort || null,
          };
          o.reviewers = picks;
        }
        d.overrides[desc.id] = o;
      }
    });
    state.modelOpen = null;
    state.modelQuery = "";
    toast(
      `${m.name}: ${target.name} in ${target.instanceName}, effort ${
        effort ? effortLabel(effort) : "not offered"
      }. Exact target pinned in the preview; nothing is substituted.`,
    );
    render("wk-model-trigger-" + ctx);
  }

  function resetModelPick(ctx) {
    const desc = modelRegistry[ctx];
    if (!desc) return;
    changeDraft((d) => {
      if (desc.allowDefault) {
        if (desc.kind === "implDefault") {
          const pin = pinFor(D.team.implementer, D.team.implementerEffort, d.defaults.machine);
          d.defaults.implementer = D.team.implementer;
          d.defaults.effort = pin.effort == null ? "" : pin.effort;
          d.defaults.instance = pin.instance;
          d.defaults.model = pin.model;
        } else {
          const pin = defaultReviewers(d.defaults.machine)[desc.index];
          d.defaults.reviewers[desc.index] = Object.assign({}, pin);
        }
        return;
      }
      const o = Object.assign({}, d.overrides[desc.id]);
      if (desc.kind === "implItem") {
        delete o.implementer;
        delete o.instance;
        delete o.model;
        delete o.effort;
      } else if (o.reviewers) {
        const fallback =
          defaultReviewers(d.defaults.machine)[desc.index] ||
          defaultReviewers(d.defaults.machine)[0];
        o.reviewers[desc.index] = Object.assign({}, fallback);
        if (o.reviewers.length !== state.draft.defaults.reviewers.length)
          o.reviewers = state.draft.defaults.reviewers.map((r, idx) =>
            Object.assign({}, o.reviewers[idx] || r),
          );
      }
      if (Object.keys(o).length) d.overrides[desc.id] = o;
      else delete d.overrides[desc.id];
    });
    state.modelOpen = null;
    toast("Target override cleared. It will follow the project default until you choose again.");
    render("wk-model-trigger-" + ctx);
  }

  function defaultPickFor(machineId) {
    void machineId;
    const d = state.draft.defaults;
    return {
      agent: d.implementer,
      ...(d.instance || d.model ? { instance: d.instance || "", model: d.model || "" } : {}),
      effort: d.effort == null ? "" : d.effort,
    };
  }

  function reviewerDefaultPick(machineId, index) {
    void machineId;
    const r =
      state.draft.defaults.reviewers[index] ||
      defaultReviewers(state.draft.defaults.machine)[index];
    return {
      agent: r.agent,
      ...(r.instance || r.model ? { instance: r.instance || "", model: r.model || "" } : {}),
      effort: r.effort == null ? "" : r.effort,
    };
  }

  function itemPick(id, which, index) {
    const a = assignment(id);
    if (which === "impl")
      return a.impl.ok
        ? {
            agent: a.impl.target.profile,
            instance: a.impl.target.instance,
            model: a.impl.target.model,
            effort: a.impl.effort,
          }
        : a.implPick;
    const rv = a.reviewers[index];
    if (!rv)
      return { agent: D.team.reviewers[index].agent, effort: D.team.reviewers[index].effort };
    return rv.res.ok
      ? {
          agent: rv.res.target.profile,
          instance: rv.res.target.instance,
          model: rv.res.target.model,
          effort: rv.res.effort,
        }
      : rv.pick;
  }

  /* Render: Inspector --------------------------------------------------- */
  function renderInsp() {
    const el = $("wk-insp");
    const key = state.machineOpen
      ? "m:" + state.machineOpen + (state.machineSettings ? ":s" : "")
      : state.tab + ":" + state.focusId;
    if (key !== state.inspKey) {
      el.scrollTop = 0;
      state.inspKey = key;
    }
    if (state.machineOpen) {
      el.innerHTML = machinePanel(state.machineOpen);
      return;
    }
    if (!state.focusId || !issueById(state.focusId)) {
      el.innerHTML =
        '<div class="wk-pv-empty"><p>No issue is focused. Select a loaded issue to inspect it.</p></div>';
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
    const info = scopeById(i.scope);
    const conn = info ? info.connection : null;
    if (!i.shared)
      return `<p class="wk-scope">${icon(
        "doc",
      )}<span>Separate demo sample in scope ${esc(info ? info.scope.nativeId : i.scope)}${
        conn ? " on " + esc(conn.name) : ""
      }. Tracker key ${esc(labelOf(i))}, native ID ${esc(
        i.nativeId,
      )}. This key is not shared with any other scope.</span></p>`;
    return `<div class="wk-scope is-shared">
      <p><strong>Shared sample issue.</strong> The Runs, Workflow map and Plan and decisions pages show an existing example attempt 3 for ${esc(
        labelOf(i),
      )} on Sample Mac (machine id mac), waiting on decision D-3. A request you start here appears in the canonical Runs overview as a separate, unobserved request. Existing attempt 3 stays distinct and is not relabelled as yours.</p>
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

  function teamLines(mid, it, efforts) {
    void mid;
    const lines = [
      `<li><span class="wk-role">Implementer</span><span>${esc(it.implementerName || agent(it.implementer).name)}${
        it.instanceName ? " through " + esc(it.instanceName) : ""
      }<span class="faint">${it.instance ? ", " + esc(it.instance) : ""}${
        it.model ? ", model " + esc(it.model) : ""
      }, effort ${esc(efforts ? efforts.impl : it.effort ? effortLabel(it.effort) : "unknown")}</span></span></li>`,
    ];
    (it.reviewers || []).forEach((r, idx) => {
      const eff = efforts ? (efforts.reviewers[idx] || {}).effort : r.effort;
      lines.push(
        `<li><span class="wk-role">Reviewer</span><span>${esc(r.name || agent(r.id).name)}${
          r.via ? " through " + esc(r.via) : ""
        }<span class="faint">${r.instance ? ", " + esc(r.instance) : ""}${
          r.model ? ", model " + esc(r.model) : ""
        }, effort ${esc(eff ? effortLabel(eff) : "unknown")}</span></span></li>`,
      );
    });
    return `<ul class="wk-team">${lines.join("")}</ul>`;
  }

  function gateCard(gate, ctx) {
    if (!gate) return "";
    const blocking = gate.kind === "blocking";
    const held = blocking && gate.status === "open";
    return `<section class="wk-isec wk-gate is-${gate.kind}" aria-label="Question gate">
      <h3>${icon("question")} ${blocking ? "Blocking question" : "Advisory question"}</h3>
      <p><strong>${esc(gate.question)}</strong></p>
      <p>${
        blocking
          ? held
            ? `Admits to Intake. ${esc(
                D.STAGE_NAMES[gate.stage] || gate.stage,
              )} is held until an answer is saved.`
            : `Answer saved: ${esc(gate.decisionLabel)}. ${esc(
                D.STAGE_NAMES[gate.stage] || gate.stage,
              )} is no longer held by this question.`
          : "Advisory only. It does not hold a named stage and creates no gate."
      }</p>
      <p class="wk-hint">${esc(gate.note)} Saving an answer is not execution approval.</p>
      <button type="button" class="btn ghost sm" ${
        ctx === "execution" ? 'data-rtab-go="plan"' : 'data-tab="plan"'
      }>${icon("edit")}Open plan and decision</button>
      <span class="sr-only">Gate context ${esc(ctx)}</span>
    </section>`;
  }

  function detailsPanel(id) {
    const i = issueById(id);
    const active = activeItem(id);
    const sel = isSelected(id);
    let assign;
    if (active) {
      const life = lifecycleLabel(active.item);
      assign = `<p>Recorded in demo receipt ${esc(active.receipt.id)} as ${esc(
        resultLabel(active.item),
      )}, pinned to ${mchip(active.item.machine)}.${life ? " Lifecycle: " + esc(life) + "." : ""} It cannot be selected again while this request stays reserved.</p>
        <div class="wk-row-actions"><button type="button" class="btn sm" id="d-openrun" data-openrun="${esc(
          active.receipt.id,
        )}|${esc(id)}">Open request detail</button></div>`;
    } else if (i.existing) {
      assign = `<p class="wk-blocktext">${esc(i.existing.text)}</p>
        <div class="wk-row-actions"><a class="btn sm" href="runs.html#${esc(
          i.existing.anchor,
        )}">${icon("list")}Open existing run: ${esc(machineById(i.existing.machine).name)}, ${esc(
          i.existing.item,
        )}, accepted record ${esc(i.existing.record)}</a>
        <button type="button" class="btn ghost sm" data-act="open-existing-settings" data-machine="${esc(
          i.existing.machine,
        )}">Repair ${esc(machineById(i.existing.machine).name)} in Settings, Connections</button></div>`;
    } else if (sel) {
      const r = assess(id);
      assign = `<dl class="wk-kv">
          <dt>Run on</dt><dd>${mchip(r.a.machine)} <span class="faint">${
            r.a.machineOverridden ? "Set for this issue" : "Batch default"
          }</span></dd>
          <dt>Repository</dt><dd class="wk-path">${esc(
            (r.a.repo && r.a.repo.repo && r.a.repo.repo.path) || "Not resolved",
          )} <span class="faint">${esc((r.a.repo && r.a.repo.meta.name) || "")}</span></dd>
          <dt>Implementer</dt><dd>${modelControl("item-" + id + "-impl", {
            kind: "implItem",
            id,
            machine: r.a.machine,
            pick: itemPick(id, "impl"),
            allowDefault: false,
          })}</dd>
          <dt>Reviewers</dt><dd>${r.a.reviewers
            .map(
              (rv, idx) =>
                `<div class="wk-reviewer">${modelControl("item-" + id + "-rev-" + idx, {
                  kind: "revItem",
                  id,
                  index: idx,
                  machine: r.a.machine,
                  pick: itemPick(id, "rev", idx),
                  allowDefault: false,
                })}</div>`,
            )
            .join("")}<span class="faint">${
            r.a.reviewersOverridden ? "This issue only" : "Project reviewer defaults"
          }; same machine as the implementer.</span></dd>
          <dt>Readiness</dt><dd>${
            r.ready
              ? lpill("neutral", "check", "Ready to preview")
              : lpill("attn", "alert", "Blocked")
          }${r.ready ? "" : `<p class="wk-blocktext">${esc(r.blockText)}</p>`}</dd>
        </dl>
        ${fixButtons(r, id)}
        <div class="wk-row-actions">
          <button type="button" class="btn sm" id="d-assign" data-act="show-selected" data-id="${esc(
            id,
          )}">Change assignment</button>
          <button type="button" class="btn ghost sm" id="d-deselect" data-act="deselect" data-id="${esc(
            id,
          )}">Remove from selection</button>
        </div>`;
    } else {
      assign = `<p class="muted">Not selected. Selecting adds it to the draft batch with the batch defaults. Nothing starts until you preview and start.</p>
        <div class="wk-row-actions"><button type="button" class="btn sm" id="d-select" data-act="select" data-id="${esc(
          id,
        )}">Select ${esc(labelOf(i))}</button></div>`;
    }
    const info = scopeById(i.scope);
    return `
      <div class="wk-ihead">
        <p class="wk-meta"><span>${esc(labelOf(i))}</span><span>${
          info ? esc(info.connection.name) : "Unknown connection"
        } issue #${i.number}</span><span>Open</span><span>Edited ${esc(stamp(i.updated))}</span></p>
        <h2>${esc(i.title)}</h2>
        <p class="wk-tags"><span class="tag">${esc(wf(i.workflow).name)}</span>${i.labels
          .map((l) => `<span class="tag observed">${esc(l)}</span>`)
          .join("")}</p>
      </div>
      ${scopeNote(i)}
      ${gateCard(gateFor(id), "details")}
      ${
        i.requires
          ? `<section class="wk-isec"><h3>Required capability (not a preference)</h3><p>${esc(
              i.requires.text,
            )} Required: ${esc(i.requires.capabilities.join(", "))}.</p></section>`
          : ""
      }
      ${
        i.prefers
          ? `<section class="wk-isec"><h3>Preference (not a capability)</h3><p>Prefers ${esc(
              machineBase(i.prefers.machine).name,
            )}. ${esc(i.prefers.text)}</p></section>`
          : ""
      }
      <section class="wk-isec"><h3>Description</h3><p>${esc(i.description)}</p></section>
      <section class="wk-isec"><h3>Acceptance criteria</h3>${
        i.acceptance.length
          ? `<ul class="wk-ac">${i.acceptance
              .map((a) => `<li>${icon("circle")}<span>${esc(a)}</span></li>`)
              .join("")}</ul>`
          : `<p class="wk-blocktext">None in the issue. Reviewers will check against the description only. Add criteria in ${
              info ? esc(info.connection.adapter) : "the tracker"
            } and fetch again.</p>`
      }</section>
      <section class="wk-isec"><h3>Assignment</h3>${assign}</section>
      <p class="wk-native">Tracker reference ${esc(i.nativeId)} in ${esc(
        info ? info.connection.id : "unknown",
      )}, scope ${esc(i.scope)}. Kept so a renamed or renumbered issue is still the same issue, and so another scope's similar key cannot collide.</p>`;
  }

  function fixButtons(r, id) {
    if (!r.fixes.length) return "";
    return `<div class="wk-row-actions wk-fixes">${r.fixes
      .slice(0, 4)
      .map(
        (f, idx) =>
          `<button type="button" class="btn sm" data-act="${
            f.kind === "settings" ? "open-fix-settings" : "apply-fix"
          }" data-id="${esc(id)}" data-fix="${idx}" data-machine="${esc(
            f.machine || "",
          )}" data-instance="${esc(f.instance || "")}" data-model="${esc(
            f.model || "",
          )}" data-effort="${esc(f.effort || "")}" title="${esc(f.note || "")}">${esc(
            f.label,
          )}</button>`,
      )
      .join("")}</div>`;
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
          <span class="faint">${p.savedAt ? `Saved ${esc(stamp(p.savedAt))}` : "Drafted from the issue (sample)"}</span>
          <span class="wk-planstate" id="plan-state-${ctx}">${dirty ? "Unsaved edits" : ""}</span>
        </div>
        <label class="sr-only" for="plan-text-${ctx}">Plan for ${esc(labelOf(i))}</label>
        <textarea class="field wk-plantext" id="plan-text-${ctx}" data-plan="${esc(
          id,
        )}" data-ctx="${ctx}" rows="11" spellcheck="true">${esc(text)}</textarea>
        <div class="wk-row-actions">
          <button type="button" class="btn sm" id="plan-save-${ctx}" data-act="save-plan" data-id="${esc(
            id,
          )}"${dirty ? "" : " disabled"}>Save plan</button>
          <button type="button" class="btn ghost sm" id="plan-discard-${ctx}" data-act="discard-plan" data-id="${esc(
            id,
          )}"${dirty ? "" : " disabled"}>Discard edits</button>
        </div>
        <p class="wk-hint">Saving a plan starts nothing and grants no permission to run. ${esc(note)} Unsaved edits are kept as a local recovery copy.</p>
      </section>
      ${i.question ? decisionBlock(i, ctx) : ""}`;
  }

  function decisionBlock(i, ctx) {
    const d = decisionOf(i.id);
    const draft = state.decisionEdits[i.id];
    const chosen = draft || (d && d.option) || "";
    const canSave = !!draft && (!d || draft !== d.option);
    const gate = gateFor(i.id);
    return `
      <section class="wk-isec">
        <fieldset class="wk-fs">
          <legend><span class="wk-fs-k">${
            gate.kind === "blocking"
              ? `Blocking question · holds ${esc(D.STAGE_NAMES[gate.stage])}`
              : "Advisory question · no stage hold"
          }</span><span class="wk-fs-q">${esc(i.question.title)}</span></legend>
          ${i.question.options
            .map(
              (o) =>
                `<label class="choice"><input type="radio" name="dq-${ctx}" value="${esc(
                  o.id,
                )}" data-decision="${esc(i.id)}" data-ctx="${ctx}"${
                  chosen === o.id ? " checked" : ""
                } /><span class="c-label">${esc(o.label)}${
                  o.suggested ? ' <span class="suggested">Suggested</span>' : ""
                }</span></label>`,
            )
            .join("")}
        </fieldset>
        <div class="wk-row-actions">
          <button type="button" class="btn sm" id="dec-save-${ctx}" data-act="save-decision" data-id="${esc(
            i.id,
          )}"${canSave ? "" : " disabled"}>Save decision</button>
        </div>
        <p class="wk-hint">${
          d
            ? `Saved: ${esc(optionLabel(i, d.option))}, at ${esc(stamp(d.savedAt))}.`
            : "No decision saved."
        } ${esc(gate.note)} Saving a decision does not start, resume or approve work.</p>
      </section>`;
  }

  function planPanel(id) {
    const i = issueById(id);
    const active = activeItem(id);
    const note = active
      ? `The request recorded in ${active.receipt.id} keeps the plan it was accepted with; a new revision applies to a future request.`
      : "It makes any preview that includes this issue out of date.";
    return `
      <div class="wk-ihead">
        <p class="wk-meta"><span>${esc(labelOf(i))}</span><span>Plan and decisions</span></p>
        <h2>${esc(i.title)}</h2>
      </div>
      ${
        i.shared
          ? `<p class="wk-scope is-shared">${icon(
              "doc",
            )}<span>This is a plan for a new demo request. The existing example attempt 3 uses plan r5 on the <a href="planning.html">Plan and decisions page</a>. This request starts from a fresh plan r1 with its own provenance; it does not inherit r5 or attempt 3's execution approval.</span></p>`
          : ""
      }
      ${gateCard(gateFor(id), "plan")}
      ${planEditor(id, "insp", note)}`;
  }

  function selectedItem(id) {
    const i = issueById(id);
    const r = assess(id);
    const o = state.draft.overrides[id] || {};
    return `<li class="wk-selitem${state.focusId === id ? " is-cur" : ""}" id="si-${hash(id)}">
      <div class="wk-selhead">
        <button type="button" class="linkish wk-selid" id="si-open-${hash(
          id,
        )}" data-inspect="${esc(id)}">${esc(labelOf(i))}</button>
        <span class="wk-seltitle">${esc(i.title)}</span>
        <button type="button" class="btn ghost icon wk-remove" id="si-rm-${hash(
          id,
        )}" data-act="deselect" data-id="${esc(
          id,
        )}" aria-label="Remove ${esc(labelOf(i))} from selection">${icon("x")}</button>
      </div>
      <div class="wk-form">
        <label for="ov-m-${hash(id)}">Run on</label>
        <select id="ov-m-${hash(id)}" class="field wk-sel" data-ov="machine" data-id="${esc(
          id,
        )}">${machineOptions(o.machine || "", r.a.implPick.agent, true)}</select>
        <span class="wk-form-l">Repository</span><span class="wk-path">${esc(
          (r.a.repo && r.a.repo.repo && r.a.repo.repo.path) || "Not resolved",
        )} <span class="faint">${esc((r.a.repo && r.a.repo.meta.name) || "")}</span></span>
        <span class="wk-form-l">Implementer</span>
        <div>${modelControl("item-" + id + "-impl-sel", {
          kind: "implItem",
          id,
          machine: r.a.machine,
          pick: itemPick(id, "impl"),
          allowDefault: false,
        })}<span class="faint">${
          r.a.implementerOverridden ? "This issue only" : "Project default"
        }</span></div>
        <span class="wk-form-l">Reviewers</span>
        <div>${r.a.reviewers
          .map(
            (rv, idx) =>
              `<div class="wk-reviewer">${modelControl("item-" + id + "-rev-sel-" + idx, {
                kind: "revItem",
                id,
                index: idx,
                machine: r.a.machine,
                pick: itemPick(id, "rev", idx),
                allowDefault: false,
              })}</div>`,
          )
          .join("")}<span class="faint">${
          r.a.reviewersOverridden ? "This issue only" : "Project reviewer defaults"
        }</span></div>
      </div>
      <div class="wk-readiness">
        ${r.ready ? lpill("neutral", "check", "Ready to preview") : lpill("attn", "alert", "Blocked")}
      </div>
      ${r.ready ? "" : `<p class="wk-blocktext">${esc(r.blockText)}</p>`}
      ${fixButtons(r, id)}
    </li>`;
  }

  function machineOptions(selectedId, implementer, withDefault) {
    const optFor = (m) => {
      let suffix = "";
      if (m.status !== "connected") suffix = " (offline)";
      else if (!firstTargetFor(m.id, implementer)) suffix = ` (no ${agent(implementer).name})`;
      return m.name + suffix;
    };
    let html = "";
    if (withDefault) {
      const dm = machineById(state.draft.defaults.machine);
      html += `<option value=""${selectedId ? "" : " selected"}>Batch default: ${esc(
        dm ? optFor(dm) : "No machine",
      )}</option>`;
    }
    D.machines.forEach((base) => {
      const m = machineById(base.id);
      html += `<option value="${m.id}"${selectedId === m.id ? " selected" : ""}>${esc(
        optFor(m),
      )}</option>`;
    });
    return html;
  }

  function selectedPanel() {
    const ids = orderedSelected();
    const defs = state.draft.defaults;
    const ready = ids.filter((id) => assess(id).ready).length;
    return `
      <section class="wk-isec">
        <h3>Batch defaults</h3>
        <p class="wk-hint wk-hint-top">Saving this draft starts nothing. A default resolves to an exact provider instance, model and effort on the selected machine; the preview pins them. Nothing is substituted if they are unavailable.</p>
        <div class="wk-form">
          <label for="def-machine">Run on</label>
          <select id="def-machine" class="field wk-sel" data-def="machine">${machineOptions(
            defs.machine,
            defs.implementer,
            false,
          )}</select>
          <span class="wk-form-l">Implementer</span>
          <div>${modelControl("def-impl", {
            kind: "implDefault",
            machine: defs.machine,
            pick: defaultPickFor(defs.machine),
            allowDefault: true,
          })}</div>
          <span class="wk-form-l">Reviewers</span>
          <div>${defs.reviewers
            .map(
              (r, idx) =>
                `<div class="wk-reviewer">${modelControl("def-rev-" + idx, {
                  kind: "revDefault",
                  index: idx,
                  machine: defs.machine,
                  pick: reviewerDefaultPick(defs.machine, idx),
                  allowDefault: true,
                })}</div>`,
            )
            .join(
              "",
            )}<span class="faint">Inherited by every selected issue without its own reviewer targets.</span></div>
        </div>
        <p class="wk-hint">Defaults apply to every selected issue without its own choice. Changing a default never changes an issue you set individually. Another provider is used only when you pick it here; there is no automatic fallback. Reviewer defaults are editable here, and a single issue can override them.</p>
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

  /* Machine inspector and scoped Settings fixture ---------------------- */
  function machinePanel(mid) {
    const m = machineById(mid);
    const online = m.status === "connected";
    const here = orderedSelected().filter((id) => assignment(id).machine === mid);
    const queued = [];
    state.receipts.forEach((r) =>
      r.items.forEach((it) => {
        if (isActive(it) && it.machine === mid) queued.push({ r, it });
      }),
    );
    const agentRows = D.AGENT_ORDER.map((a) => {
      const x = agent(a);
      const target = firstTargetFor(mid, a);
      const any = targetsOn(mid).find((t) => t.profile === a);
      const cap = target || any;
      const role =
        a === D.team.implementer
          ? "Project default implementer"
          : D.team.reviewers.some((r) => r.agent === a)
            ? "Project reviewer"
            : "Optional, by your choice";
      return `<tr>
        <th scope="row">${esc(x.name)}<span class="sub">${esc(x.via)}</span></th>
        <td>${
          target
            ? lpill("neutral", "check", "Available")
            : any
              ? lpill("quiet", "minus", "Not available")
              : lpill("quiet", "minus", "No provider instance")
        }${!target && cap && cap.reason ? `<span class="sub">${esc(cap.reason)}</span>` : ""}</td>
        <td>${target ? esc(target.efforts.length ? target.efforts.join(", ") : "No effort setting offered") : "None"}</td>
        <td class="faint">${esc(role)}</td>
      </tr>`;
    }).join("");
    const missingProfiles = D.AGENT_ORDER.filter((a) => !firstTargetFor(mid, a));
    const selectedRepo = scopeInfo() ? repoFor({ scope: state.scopeId }, mid) : null;
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
        ${!online && m.problem ? `<p class="wk-blocktext">${esc(m.problem)}</p>` : ""}
        <dl class="wk-kv">
          <dt>Machine ID</dt><dd class="mono">${esc(m.id)}</dd>
          <dt>Address</dt><dd class="mono">${esc(m.address)}</dd>
          <dt>Connection</dt><dd>${esc(m.route)}</dd>
          <dt>System</dt><dd>${esc(m.os)}</dd>
          <dt>Last check</dt><dd>${esc(stamp(m.checked))}</dd>
          <dt>Access</dt><dd>Token kept in Settings, Connections, Machines. It is never shown here, entered here or copied into a draft.</dd>
          <dt>Capabilities</dt><dd>${esc(m.capabilities.join(", ") || "None recorded")}</dd>
          <dt>Queue</dt><dd>${esc(m.queue)}</dd>
        </dl>
        <section class="wk-isec">
          <h3>Agents on this machine</h3>
          ${
            online
              ? `<table class="wk-table"><thead><tr><th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Effort</th><th scope="col">Role</th></tr></thead><tbody>${agentRows}</tbody></table>`
              : `<p class="muted">Unknown while offline. Last known: ${esc(m.lastKnown || "not recorded")}.</p>`
          }
        </section>
        <section class="wk-isec wk-settings-fixture" id="wk-settings-fixture">
          <h3>Settings, Connections (fixture)</h3>
          <p class="wk-hint wk-hint-top">Scoped to ${esc(
            m.name,
          )}. This is a sample panel: no token field, no token read, no token storage, and no real connection. A repair keeps your draft intact and requires a new preview; it never starts work.</p>
          <div class="wk-row-actions">
            ${
              !online
                ? `<button type="button" class="btn sm" data-act="demo-restore" data-machine="${esc(
                    m.id,
                  )}">${icon("link")}Restore demo connection</button>`
                : ""
            }
            ${(online ? missingProfiles : [])
              .map(
                (a) =>
                  `<button type="button" class="btn sm" data-act="demo-provider" data-machine="${esc(
                    m.id,
                  )}" data-agent="${esc(a)}">${icon("plus")}Enable ${esc(
                    agent(a).name,
                  )} demo provider</button>`,
              )
              .join("")}
            ${
              selectedRepo && selectedRepo.repo && selectedRepo.repo.state !== "found"
                ? `<button type="button" class="btn sm" data-act="demo-repo" data-machine="${esc(
                    m.id,
                  )}" data-repo="${esc(selectedRepo.meta.id)}">${icon("folder")}Add sample path for ${esc(
                    selectedRepo.meta.name,
                  )}</button>`
                : ""
            }
          </div>
          <p class="faint">After a demo repair, return to Work: your selection stays, and Preview is required again because the approved inputs changed.</p>
          <button type="button" class="btn ghost sm" data-act="back-to-work">Back to Work with draft intact</button>
        </section>
        <section class="wk-isec">
          <h3>Used by this draft</h3>
          ${
            here.length
              ? `<ul class="wk-plain">${here
                  .map(
                    (id) =>
                      `<li><button type="button" class="linkish" id="mu-${hash(
                        id,
                      )}" data-inspect="${esc(id)}">${esc(labelOf(id))}</button> ${esc(
                        issueById(id).title,
                      )}</li>`,
                  )
                  .join("")}</ul>`
              : '<p class="muted">No selected issue runs here.</p>'
          }
          ${
            queued.length
              ? `<p class="wk-hint">Recorded here in this demo: ${queued
                  .map(
                    (q) =>
                      `<button type="button" class="linkish" id="mq-${hash(
                        q.it.issueId,
                      )}" data-openrun="${esc(q.r.id)}|${esc(q.it.issueId)}">${esc(
                        labelOf(q.it.issueId),
                      )}</button> (${esc(resultLabel(q.it))})`,
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
    )}<p><strong>Simulated local preview and start.</strong> Checked against sample machine facts in this page, not a server. It reserves nothing, holds no queue slot and is not admission. Start only records a demo receipt; it is never proof of server admission. No build, validation or agent command runs.</p></div>`;
  }

  function stageTable(rows) {
    return `<table class="wk-table"><thead><tr><th scope="col">Stage</th><th scope="col">Who</th><th scope="col">Allowed to</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function stageWho(stage, it, machine) {
    const role = D.stagePlan[stage].role;
    if (role === "implementer") return it.implementerName || agent(it.implementer).name;
    if (role === "reviewers")
      return listText((it.reviewers || []).map((r) => r.name || agent(r.id).name));
    if (role === "host")
      return `Validation on ${machine ? machineById(machine).name : "the target machine"}`;
    if (role === "system") return "System opens the PR; you review and merge";
    return "You";
  }

  function outcomeRadios(disabled) {
    const opts = [
      ["accepted", "Accepted (simulated admission)"],
      ["refused", "Target refuses (typed demo refusal)"],
      ["unknown", "Acknowledgement unknown (lost response)"],
    ];
    return `<fieldset class="wk-fs wk-outcome"${disabled ? " disabled" : ""}>
      <legend><span class="wk-fs-k">Demo outcome before Start</span><span class="wk-fs-q">What the sample target reports. This is simulated; no server is contacted.</span></legend>
      ${opts
        .map(
          ([v, l]) =>
            `<label class="choice"><input type="radio" name="wk-outcome" value="${v}" data-outcome="${v}"${
              state.outcome === v ? " checked" : ""
            } /><span class="c-label">${esc(l)}</span></label>`,
        )
        .join("")}
    </fieldset>
    <p class="wk-hint">${esc(outcomeNotice(state.outcome))}</p>`;
  }

  function outcomeNotice(outcome) {
    if (outcome === "unknown")
      return "Unknown keeps the same request key and target reservation. The issue stays locked and cannot be selected or started elsewhere. Check status only accepts an explicit simulated authoritative answer; time passing or an offline machine never resolves it.";
    if (outcome === "refused")
      return "A refusal keeps its typed reason in the receipt. It is distinct from a preview block: the item was ready, and the sample target refused it. No request stays reserved.";
    return "An accepted demo receipt records the request. It is not a started agent, not a queue slot, and not server admission.";
  }

  function previewItem(it) {
    const i = issueById(it.issueId);
    const m = machineById(it.machine);
    const w = wf(it.workflow);
    const gate = it.gate;
    const held = gate && gate.kind === "blocking" && gate.status === "open";
    return `<li class="wk-pvi ${it.ready ? "is-ready" : "is-blocked"}${held ? " has-hold" : ""}">
      <div class="wk-pvi-head">
        ${it.ready ? lpill("neutral", "check", "Ready") : lpill("attn", "alert", "Blocked at preview")}
        <span class="wk-id">${esc(it.label || labelOf(i))}</span>
        <span class="wk-pvi-title">${esc(i.title)}</span>
        ${mchip(it.machine)}
      </div>
      ${
        it.ready
          ? ""
          : `<p class="wk-pvi-why"><strong>Will not start.</strong> ${esc(it.blockText)}
             <button type="button" class="linkish" id="pv-fix-${hash(
               i.id,
             )}" data-act="fix-in-work" data-id="${esc(i.id)}">Change in Work</button></p>`
      }
      <div class="wk-pvi-body">
        <dl class="wk-kv">
          <dt>Run on</dt><dd>${esc(m ? m.name : "Unknown machine")} <span class="faint">${
            it.machineOverridden ? "set for this issue" : "batch default"
          }</span> <span class="mono">${esc(it.machine)}</span><br /><span class="wk-path">${esc(
            it.repoPath,
          )}</span> <span class="faint">${esc(it.repoId || "")}</span></dd>
          <dt>Implementer</dt><dd>${esc(it.implementerName)} through ${esc(
            it.instanceName || "unknown provider instance",
          )}, effort ${esc(it.effort ? effortLabel(it.effort) : "not offered")}${
            it.implementerOverridden ? ' <span class="faint">set for this issue</span>' : ""
          }<br /><span class="mono">${esc(it.instance || "")} · ${esc(it.model || "")}</span></dd>
          <dt>Reviewers</dt><dd>${(it.reviewers || [])
            .map(
              (r) =>
                `${esc(r.name || agent(r.id).name)} through ${esc(
                  r.via || agent(r.id).via,
                )}, effort ${esc(r.effort ? effortLabel(r.effort) : "not offered")}${
                  r.instance
                    ? ` <span class="mono">${esc(r.instance)} · ${esc(r.model || "")}</span>`
                    : ""
                }${r.ready ? "" : ' <span class="wk-blocktext">Unavailable; the preview is blocked.</span>'}`,
            )
            .join(
              "<br />",
            )}<br /><span class="faint">Same machine as the implementer; exact targets, no substitution.</span></dd>
          <dt>Workflow</dt><dd>${esc(w.name)}</dd>
          <dt>Validation</dt><dd>${w.validation
            .map((c) => `<code>${esc(c)}</code>`)
            .join(" ")} <span class="faint">Planned. Nothing runs here.</span></dd>
          <dt>Base</dt><dd>${esc(it.base)}</dd>
          <dt>Issue</dt><dd>${esc(labelOf(i))} in ${esc(i.nativeId)}; as edited ${esc(stamp(i.updated))}</dd>
          <dt>Plan</dt><dd>r${it.planRev}${
            it.decision ? `, decision: ${esc(optionLabel(i, it.decision))}` : ""
          }${i.shared ? ". Fresh provenance for this request; existing attempt 3 plan r5 is not inherited and carries no execution approval." : ""}</dd>
          <dt>Gate</dt><dd>${
            gate
              ? gate.kind === "blocking"
                ? held
                  ? `Admits to Intake. ${esc(
                      D.STAGE_NAMES[gate.stage] || gate.stage,
                    )} held until the question is answered.`
                  : `Blocking question answered. ${esc(
                      D.STAGE_NAMES[gate.stage] || gate.stage,
                    )} no longer held.`
                : "Advisory question; no stage hold."
              : "No question gate."
          }</dd>
          <dt>Approval</dt><dd>${esc(w.approval)}; saving a plan or decision is not execution approval.</dd>
          <dt>If started</dt><dd>${
            it.ready
              ? `Recorded as simulated ${esc(state.outcome)}. ${esc(m ? m.queue : "")}. No slot is reserved.`
              : "Not sent. Fix it in Work and create a new preview."
          }</dd>
        </dl>
        <div>
          <p class="wk-checks-h">Sample checks</p>
          <ul class="wk-checks" aria-label="Sample checks for ${esc(labelOf(i))}">${it.checks
            .map(checkLine)
            .join("")}</ul>
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
        ${storageBanner()}
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
    const guard = startGuard();
    const startable = !pv.receiptId && !stale && ready.length > 0 && guard.ok && !state.starting;
    const startReason = !guard.ok
      ? guard.reason
      : stale
        ? stale
        : pv.receiptId
          ? "This preview is already recorded."
          : !ready.length
            ? "No item in this preview is ready."
            : null;
    const perMachine = D.machines
      .map((base) => {
        const m = machineById(base.id);
        return [m, pv.items.filter((i) => i.machine === m.id).length];
      })
      .filter((x) => x[1])
      .map(([m, c]) => `${m.name} ${c}`);
    const roleLabel = {
      implementer: "Implementer",
      reviewers: "Reviewers",
      host: "Target machine",
      system: "System, then you",
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
          <p class="faint">Created ${esc(demoStamp(pv.createdAt))} for ${plural(
            pv.items.length,
            "selected issue",
          )}. Request key <span class="mono">${esc(pv.key)}</span>.</p>
        </div>
        <div class="wk-row-actions">
          <button type="button" class="btn" id="pv-back" data-act="go-work">Back to Work</button>
          <button type="button" class="btn" id="pv-refresh" data-act="create-preview"${
            n ? "" : " disabled"
          }>${stale ? "Create new preview" : "Preview again"}</button>
          <button type="button" class="btn primary" id="pv-start" data-act="start"${
            startable ? "" : " disabled"
          } aria-describedby="pv-start-reason">${
            state.starting
              ? "Recording demo receipt…"
              : pv.receiptId
                ? "Already recorded"
                : `Start ${plural(ready.length, "ready item")} (demo ${esc(state.outcome)})`
          }</button>
        </div>
      </header>
      ${simNote()}
      ${storageBanner()}
      ${
        startReason
          ? `<p class="wk-hint wk-start-reason" id="pv-start-reason" role="status">Start is off: ${esc(
              startReason,
            )}</p>`
          : '<p class="wk-hint wk-start-reason" id="pv-start-reason" role="status">Start serialises one receipt write under the Web Locks API and verifies the write before acknowledging.</p>'
      }
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
          ? `<div class="wk-done">${icon("check")}<p>Recorded as demo receipt ${esc(
              pv.receiptId,
            )}. Starting this preview again returns the same receipt and queues nothing new. Accepted is not started.</p><button type="button" class="btn sm" id="pv-open-receipt" data-act="open-receipt" data-receipt="${esc(
              pv.receiptId,
            )}">Open request detail</button></div>`
          : ""
      }
      ${pv.receiptId ? "" : `<div class="wk-isec wk-outcome-choice">${outcomeRadios(false)}</div>`}
      <p class="wk-pv-sum" id="pv-sum"><strong>${ready.length} ready, ${blocked} blocked at preview.</strong> By machine: ${esc(
        perMachine.join(", "),
      )}. Each machine gets its own result; the batch is not all-or-nothing. Blocked items stay listed and are not sent. ${esc(
        outcomeNotice(state.outcome),
      )}</p>
      <details class="wk-perm">
        <summary>Stages, gates and permissions for these workflows</summary>
        ${stageTable(rows)}
        <p class="wk-hint">Agents never merge. The system opens the pull request after validation; a person reviews and merges. A blocking question can admit Intake while holding a later named stage.</p>
      </details>
      <ol class="wk-pv-list">${pv.items.map(previewItem).join("")}</ol>
    </div>`;
  }

  /* Render: Saved demo requests --------------------------------------- */
  function resultLabel(it) {
    if (it.result === "accepted") return "Accepted (demo)";
    if (it.result === "refused") return "Refused (demo)";
    if (it.result === "unknown") return "Acknowledgement unknown (demo)";
    return "Blocked at preview";
  }

  function effectiveState(it) {
    if (it.lifecycle === "closed") return "closed";
    if (
      it.result === "refused" ||
      (it.result === "unknown" && it.resolution && it.resolution.outcome === "refused")
    )
      return "refused";
    if (it.lifecycle === "closure_unknown") return "closure_unknown";
    if (it.lifecycle === "withdrawal_requested") return "withdrawal_requested";
    if (it.result === "unknown" && !it.resolution) return "unknown";
    if (isAcceptedLike(it)) return "accepted";
    return "idle";
  }
  function effectiveStateText(it) {
    const state = effectiveState(it);
    if (state === "closed")
      return "Closed after a simulated confirmed closure. The accepted history is retained.";
    if (state === "refused")
      return it.result === "unknown"
        ? "Refused after a simulated unknown acknowledgement. This is a typed refusal, not a timeout; nothing is running."
        : "Refused by the sample target with a typed reason. Nothing is running and the request is not reserved.";
    if (state === "closure_unknown")
      return "Closure is unknown (simulated). The request stays reserved; elapsed time is not closure.";
    if (state === "withdrawal_requested")
      return "Withdrawal requested in this demo. This is not closure; the request stays reserved.";
    if (state === "unknown")
      return "Acknowledgement unknown (simulated). Nothing is running and the request is not closed.";
    if (it.result === "unknown" && it.resolution && it.resolution.outcome === "accepted")
      return "Queued in this demo after a simulated authority acceptance of the unknown acknowledgement. No agent has started.";
    return "Queued in this demo. No agent has started and nothing is running.";
  }
  function effectivePill(it) {
    const state = effectiveState(it);
    if (state === "closed") return lpill("neutral", "check", lifecycleLabel(it));
    if (state === "refused") return lpill("danger", "x", lifecycleLabel(it));
    if (state === "unknown" || state === "closure_unknown")
      return lpill("attn", "unknown", lifecycleLabel(it));
    if (state === "withdrawal_requested") return lpill("attn", "history", lifecycleLabel(it));
    return lpill("neutral", "history", lifecycleLabel(it));
  }
  function effectiveNote(it) {
    return `<p class="wk-hint wk-hint-top wk-effective">Current simulated state: ${esc(
      lifecycleLabel(it),
    )}. ${esc(effectiveStateText(it))} ${
      it.result === "unknown"
        ? "The receipt's recorded raw outcome remains unknown as history."
        : ""
    }</p>`;
  }
  function lifecycleLabel(it) {
    if (it.lifecycle === "withdrawal_requested") return "Withdrawal requested; not closure";
    if (it.lifecycle === "closure_unknown") return "Closure unknown; stays reserved";
    if (it.lifecycle === "closed") return "Closed (simulated confirmation)";
    if (it.lifecycle === "refused") return "Refused after unknown (simulated)";
    if (it.result === "accepted") return "Queued (demo)";
    if (it.result === "unknown")
      return it.resolution
        ? it.resolution.outcome === "accepted"
          ? "Accepted after unknown (simulated); queued"
          : "Refused after unknown (simulated)"
        : "Unknown acknowledgement; not closure";
    if (it.result === "refused") return "Target refused (simulated)";
    return "Not started";
  }

  function receiptBlock(r, cur) {
    return `<section class="wk-receipt${state.highlight === r.id ? " is-new" : ""}" aria-labelledby="rc-${esc(
      r.id,
    )}">
      <h2 id="rc-${esc(r.id)}" tabindex="-1">Request ${esc(r.id)}</h2>
      <p class="wk-rmeta">Recorded ${esc(demoStamp(r.at))}. Raw outcome at recording (historical): ${esc(
        r.outcome || "mixed",
      )}. Request key <span class="mono">${esc(r.key)}</span>. ${r.items.length} item${
        r.items.length === 1 ? "" : "s"
      }, each with its own current state.</p>
      <ul class="wk-rlist">
        ${r.items
          .map((it) => {
            const on = cur && cur.r.id === r.id && cur.it.issueId === it.issueId;
            const admission = isAdmission(it);
            if (admission || it.result === "refused") {
              return `<li><button type="button" class="wk-ritem" id="ri-${esc(r.id)}-${hash(
                it.issueId,
              )}" data-openrun="${esc(r.id)}|${esc(it.issueId)}"${on ? ' aria-current="true"' : ""}>
                ${effectivePill(it)}
                <span class="wk-id">${esc(labelOf(it.issueId))}</span>
                <span class="t">${esc(issueById(it.issueId).title)}</span>
                ${mchip(it.machine)}
              </button></li>`;
            }
            return `<li class="wk-rblocked">
              ${lpill("quiet", "minus", "Not started")}
              <span class="wk-id">${esc(labelOf(it.issueId))}</span>
              <span class="t">${esc(it.reason || "Blocked at preview")}</span>
              ${mchip(it.machine)}
              <button type="button" class="linkish" data-act="fix-in-work" data-id="${esc(
                it.issueId,
              )}">Change in Work</button>
            </li>`;
          })
          .join("")}
      </ul>
    </section>`;
  }

  function needsYou(r, it) {
    const rows = [];
    if (it.gate) {
      if (it.gate.kind === "blocking" && it.gate.status === "open")
        rows.push(
          `<li>${lpill("attn", "alert", "Needs you")} Blocking question holds ${
            D.STAGE_NAMES[it.gate.stage] || it.gate.stage
          }: ${esc(it.gate.question)} <button type="button" class="linkish" data-rtab-go="plan">Open plan and decision</button></li>`,
        );
      else if (it.gate.kind === "blocking")
        rows.push(
          `<li>${lpill("neutral", "check", "Answered")} Decision pinned when recorded: ${esc(
            it.gate.decisionLabel,
          )}. It held ${esc(D.STAGE_NAMES[it.gate.stage] || it.gate.stage)}; it is not execution approval.</li>`,
        );
      else
        rows.push(
          `<li>${lpill("quiet", "dot", "Advisory")} ${esc(
            it.gate.question,
          )}. No stage is held; saving an answer is not approval.</li>`,
        );
    }
    if (it.result === "unknown" && !it.resolution)
      rows.push(
        `<li>${lpill("attn", "unknown", "Needs you")} Acknowledgement unknown since ${esc(
          demoStamp(it.reservation ? it.reservation.at : r.at),
        )}. Check status with an explicit simulated authoritative answer. Do not start it elsewhere.</li>`,
      );
    if (it.lifecycle === "withdrawal_requested")
      rows.push(
        `<li>${lpill("attn", "history", "Needs you")} Withdrawal requested at ${esc(
          demoStamp(it.withdrawalAt),
        )}. A request is not closure; the issue stays reserved.</li>`,
      );
    if (it.lifecycle === "closure_unknown")
      rows.push(
        `<li>${lpill("attn", "unknown", "Needs you")} Closure is unknown. The issue stays reserved until positive confirmation.</li>`,
      );
    if (!rows.length)
      rows.push(
        `<li>${lpill("quiet", "minus", "Nothing waiting")} No blocking question or unknown acknowledgement is recorded for this request.</li>`,
      );
    return `<section class="wk-isec wk-needsyou"><h3>Needs you</h3><ul class="wk-plain">${rows.join(
      "",
    )}</ul></section>`;
  }

  function lifecycleActions(r, it) {
    const withdrawalButtons = `<div class="wk-row-actions">
      <button type="button" class="btn sm" data-act="reconcile-withdrawal" data-receipt="${esc(
        r.id,
      )}" data-issue="${esc(it.issueId)}" data-outcome="closed">Simulate closure confirmed</button>
      <button type="button" class="btn sm" data-act="reconcile-withdrawal" data-receipt="${esc(
        r.id,
      )}" data-issue="${esc(it.issueId)}" data-outcome="unknown">Simulate closure unknown</button>
      <button type="button" class="btn ghost sm" data-act="reconcile-withdrawal" data-receipt="${esc(
        r.id,
      )}" data-issue="${esc(it.issueId)}" data-outcome="refused">Simulate withdrawal refused</button>
    </div>`;
    const newRequest = `<div class="wk-row-actions"><button type="button" class="btn sm" data-act="link-new-request" data-receipt="${esc(
      r.id,
    )}" data-issue="${esc(it.issueId)}" data-machine="${esc(
      it.machine,
    )}">Prepare a new request</button></div>`;
    if (it.result === "unknown" && !it.resolution)
      return `<section class="wk-isec wk-actions">
        <h3>Reconcile acknowledgement (simulated)</h3>
        <p class="wk-hint wk-hint-top">This request keeps request key <span class="mono">${esc(
          r.key,
        )}</span> and its ${esc(machineById(it.machine).name)} reservation. Offline status or elapsed time is never closure. Only an explicit simulated authoritative answer resolves it, and acceptance never relaunches the work.</p>
        <div class="wk-row-actions">
          <button type="button" class="btn sm" data-act="reconcile-unknown" data-receipt="${esc(
            r.id,
          )}" data-issue="${esc(it.issueId)}" data-outcome="accepted">Simulate authoritative accepted</button>
          <button type="button" class="btn sm" data-act="reconcile-unknown" data-receipt="${esc(
            r.id,
          )}" data-issue="${esc(it.issueId)}" data-outcome="refused">Simulate authoritative refused</button>
        </div>
      </section>`;
    if (
      it.result === "refused" ||
      (it.result === "unknown" && it.resolution && it.resolution.outcome === "refused")
    )
      return `<section class="wk-isec wk-actions">
        <h3>Lifecycle</h3>
        <p class="wk-hint wk-hint-top">${
          it.result === "refused"
            ? "The sample target refused this request with a typed reason. It is not accepted and does not stay reserved."
            : "The simulated authority refused this request. It is not accepted and does not stay reserved."
        }</p>${newRequest}</section>`;
    if (!isAcceptedLike(it)) return "";
    if (it.lifecycle === "queued")
      return `<section class="wk-isec wk-actions">
        <h3>Lifecycle</h3>
        <p class="wk-hint wk-hint-top">Accepted is not started. A request to withdraw does not stop or close the work by itself.</p>
        <div class="wk-row-actions">
          <button type="button" class="btn sm" data-act="request-withdrawal" data-receipt="${esc(
            r.id,
          )}" data-issue="${esc(it.issueId)}">Request withdrawal</button>
          <a class="btn ghost sm" href="runs.html">Open the Runs page (canonical operating view)</a>
        </div>
      </section>`;
    if (it.lifecycle === "withdrawal_requested" || it.lifecycle === "closure_unknown")
      return `<section class="wk-isec wk-actions">
        <h3>Withdrawal reconciliation (simulated)</h3>
        <p class="wk-hint wk-hint-top">Requested at ${esc(demoStamp(it.withdrawalAt))}. This is not closure. Reassignment or a new request is blocked until positive closure; unknown work stays reserved.</p>
        ${withdrawalButtons}
      </section>`;
    if (it.lifecycle === "closed")
      return `<section class="wk-isec wk-actions">
        <h3>Closed (simulated)</h3>
        <p class="wk-hint wk-hint-top">Positive closure was recorded at ${esc(
          demoStamp(it.closureAt),
        )}. The accepted history is kept. You can prepare a new request, linked to this one; nothing starts until you preview and start again.</p>
        ${newRequest}
      </section>`;
    return "";
  }

  function runSummary(r, it) {
    const i = issueById(it.issueId);
    const m = machineById(it.machine);
    const w = wf(it.workflow);
    return `
      ${needsYou(r, it)}
      <div class="wk-now">
        <p class="k">Now</p>
        <p class="b">${esc(effectiveStateText(it))}</p>
        <p class="n">This page is the admission receipt detail for one request. The canonical Runs operating view is <a href="runs.html">runs.html</a>. Accepted means this page recorded the request; it is not server admission and not a started agent.</p>
      </div>
      <section class="wk-isec">
        <h3>Agent team</h3>
        ${teamLines(it.machine, it, {
          impl: it.effort ? effortLabel(it.effort) : "unknown",
          reviewers: it.reviewers,
        })}
        <p class="wk-hint">All three run on ${esc(
          m.name,
        )}. Exact provider instance, model and effort are pinned when recorded; choosing agents never moves an existing session.</p>
      </section>
      <section class="wk-isec">
        <h3>Request</h3>
        <dl class="wk-kv">
          <dt>Issue</dt><dd>${esc(labelOf(i))}, ${esc(
            scopeById(i.scope) ? scopeById(i.scope).connection.name : "tracker",
          )} issue #${i.number}, native ${esc(i.nativeId)}, as edited ${esc(stamp(i.updated))}</dd>
          <dt>Run on</dt><dd>${mchip(it.machine)} <span class="mono">${esc(
            m.address,
          )}</span> <span class="faint">machine id ${esc(it.machine)}</span></dd>
          <dt>Repository</dt><dd class="wk-path">${esc(it.repoPath)}</dd>
          <dt>Base</dt><dd>${esc(it.base)}</dd>
          <dt>Workflow</dt><dd>${esc(w.name)}</dd>
          <dt>Plan</dt><dd>r${it.planRev}, pinned when recorded${
            it.decision ? `; decision: ${esc(optionLabel(i, it.decision))}` : ""
          }</dd>
          <dt>Gate</dt><dd>${
            it.gate
              ? it.gate.kind === "blocking"
                ? `Blocking question; holds ${esc(
                    D.STAGE_NAMES[it.gate.stage] || it.gate.stage,
                  )}. ${esc(it.gate.status === "open" ? "Still open." : "Answer pinned when recorded.")}`
                : "Advisory question; no stage hold."
              : "None."
          }</dd>
          <dt>Approval</dt><dd>${esc(w.approval)}. Decisions and plans are not approvals.</dd>
          <dt>Receipt</dt><dd>${esc(r.id)}, recorded ${esc(demoStamp(r.at))}. Historical raw outcome: ${esc(
            r.outcome || "mixed",
          )} (simulated). Current state is shown under Lifecycle.</dd>
          <dt>Lifecycle</dt><dd>${esc(lifecycleLabel(it))}</dd>
          ${
            it.previous
              ? `<dt>Previous request</dt><dd>New request after ${
                  it.previous.kind === "refused" ? "a typed target refusal" : "a confirmed closure"
                } of request ${esc(it.previous.receipt)} on ${esc(
                  machineById(it.previous.machine).name,
                )} at ${esc(demoStamp(it.previous.at))}. The earlier target, request and evidence are retained.</dd>`
              : ""
          }
          <dt>Target match</dt><dd>Exact provider instance, model, supported effort, base and plan as previewed. Nothing was substituted.</dd>
        </dl>
      </section>
      ${lifecycleActions(r, it)}
      <section class="wk-isec">
        <h3>Machine</h3>
        <p>This request stays on ${esc(
          m.name,
        )}. Running it elsewhere needs positive closure and a new linked request; it is never moved silently, and an offline status is not closure.</p>
      </section>
      ${
        i.shared
          ? `<section class="wk-isec wk-shared"><h3>Existing example attempt 3</h3><p>The other prototype pages show an existing example attempt 3 for ${esc(
              labelOf(i),
            )} on Sample Mac (machine id mac). It is not this request: this request appears in the canonical Runs overview as a separate, unobserved request and has no execution history here.</p>${sharedLinks()}</section>`
          : `<p class="wk-scope">${icon(
              "doc",
            )}<span>This request appears in Runs with its own Execution, Plan and decisions, and Evidence tabs. No execution has been observed.</span></p>`
      }`;
  }

  function runExecution(r, it) {
    const i = issueById(it.issueId);
    const w = wf(it.workflow);
    const lifetime = effectiveState(it);
    const admitted =
      lifetime === "accepted" ||
      lifetime === "withdrawal_requested" ||
      lifetime === "closure_unknown";
    const held = admitted && it.gate && it.gate.kind === "blocking" && it.gate.status === "open";
    const notStarted =
      lifetime === "unknown"
        ? "Unknown acknowledgement; not started"
        : lifetime === "refused"
          ? "Not started (refused)"
          : lifetime === "closed"
            ? "Not started (closed)"
            : "Not started";
    const nodes = D.STAGES.map((s, idx) => {
      const isHeld = held && s === it.gate.stage;
      const queued = admitted && idx === 0 && !isHeld;
      return `<li class="wk-stage ${isHeld ? "is-held" : queued ? "is-queued" : "is-planned"}">
        <span class="wk-node" aria-hidden="true"></span>
        <span class="nm">${esc(D.STAGE_NAMES[s])}</span>
        <span class="st">${isHeld ? "Held: blocking question unanswered" : queued ? "Queued (demo)" : esc(notStarted)}</span>
        <span class="who">${esc(stageWho(s, it, it.machine))}</span>
      </li>`;
    }).join("");
    const rows = D.STAGES.map((s) => {
      const isHeld = held && s === it.gate.stage;
      return `<tr><th scope="row">${esc(D.STAGE_NAMES[s])}</th><td>${esc(
        stageWho(s, it, it.machine),
      )}</td><td>${esc(D.stagePlan[s].perm)}${
        isHeld ? ' <span class="pill tone-attn">Held</span>' : ""
      }</td></tr>`;
    }).join("");
    return `
      ${effectiveNote(it)}
      <p class="wk-hint wk-hint-top">Planned from the ${esc(
        w.name,
      )} workflow. Nothing has been observed, because no agent has started.${
        held
          ? ` ${esc(D.STAGE_NAMES[it.gate.stage] || it.gate.stage)} is held by a blocking question.`
          : ""
      }</p>
      ${admitted ? gateCard(it.gate, "execution") : ""}
      <ol class="wk-stages" aria-label="Stages">${nodes}</ol>
      <div class="wk-legend" aria-label="Legend">
        <span><i class="wk-lg wk-lg-queued"></i>Queued in this demo</span>
        <span><i class="wk-lg wk-lg-planned"></i>Planned, not observed</span>
        <span><i class="wk-lg wk-lg-observed"></i>Observed on the machine (none yet)</span>
        <span class="wk-held-legend">Held by a blocking question or gate</span>
      </div>
      <section class="wk-isec"><h3>Who does what</h3>${stageTable(rows)}
        <p class="wk-hint">The system pushes the branch and opens the PR; a person reviews and merges. No agent merges.</p>
      </section>
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
      ${effectiveNote(it)}
      <section class="wk-isec">
        <h3>Pinned for this request</h3>
        <p class="wk-hint wk-hint-top">Plan r${it.planRev}, as recorded ${esc(demoStamp(r.at))}.${
          it.decision ? ` Decision when recorded: ${esc(optionLabel(i, it.decision))}.` : ""
        } This pinned text is immutable.</p>
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
        "Edits here apply to the next request for this issue. This request keeps its pinned plan, and saving does not resume or restart it.",
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
      ${effectiveNote(it)}
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
        <ul class="wk-evlist">${(it.reviewers || [])
          .map(
            (x) =>
              `<li>${lpill("quiet", "minus", "Not run")}<span>${esc(
                x.name || agent(x.id).name,
              )} through ${esc(x.via || agent(x.id).via)}</span></li>`,
          )
          .join("")}</ul>
      </section>
      <section class="wk-isec">
        <h3>Preview checks when recorded</h3>
        <p class="wk-hint wk-hint-top">Simulated sample checks recorded ${esc(
          demoStamp(r.at),
        )}. They are not host evidence and prove nothing about the machine.</p>
        <ul class="wk-checks">${it.checks.map(checkLine).join("")}</ul>
      </section>
      <section class="wk-isec">
        <h3>Receipt</h3>
        <dl class="wk-kv">
          <dt>Receipt</dt><dd>${esc(r.id)}</dd>
          <dt>Request key</dt><dd class="mono">${esc(r.key)}</dd>
          <dt>Recorded</dt><dd>${esc(demoStamp(r.at))}</dd>
          <dt>Issue source</dt><dd>${it.source ? esc(`${it.source.connectionId} / ${it.source.scopeId}, revision ${it.source.scopeRevision}, fetched ${it.source.fetchedAt}, coverage ${it.source.loaded}/${it.source.total}`) : "Not recorded in this older receipt"}</dd>
          <dt>Outcome</dt><dd>${esc(r.outcome || "mixed")} (historical simulated outcome)</dd>
          <dt>Current state</dt><dd>${esc(lifecycleLabel(it))}</dd>
          <dt>Batch</dt><dd>${plural(
            r.items.filter((x) => x.result === "accepted").length,
            "item",
          )} accepted, ${r.items.filter((x) => x.result === "unknown").length} unknown, ${
            r.items.filter((x) => x.result === "refused").length
          } refused, ${r.items.filter((x) => x.result === "blocked").length} blocked. Each result stands on its own.</dd>
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
        )}Saved requests</button>
        <p class="wk-meta"><span>${esc(labelOf(i))}</span><span>Admission receipt ${esc(
          r.id,
        )}</span><span>Recorded ${esc(demoStamp(r.at))}</span></p>
        <h2 id="run-title" tabindex="-1">${esc(i.title)}</h2>
        <p><a class="btn ghost sm" href="runs.html?receipt=${encodeURIComponent(r.id)}&amp;issue=${encodeURIComponent(it.issueId)}&amp;tab=${state.runTab}#runs">Open this request in Runs</a></p>
        <div class="wk-pinrow">
          ${effectivePill(it)}
          <span class="wk-pin">${icon("lock")}Pinned to ${mchip(it.machine)}<span class="wk-path">${esc(
            it.repoPath,
          )}</span></span>
          <span class="faint">Machine ${esc(it.machine)}, issue ${esc(it.issueId)}, request ${esc(
            r.id,
          )}. Label or machine name changes do not change these identities.</span>
        </div>
        <div class="wk-tabs" role="tablist" aria-label="Request detail">
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
      el.innerHTML = `<div class="wk-pv"><header class="wk-pv-head"><div><h1 id="runs-title" tabindex="-1">Saved demo requests</h1></div></header>
        ${storageBanner()}
        <div class="wk-pv-empty"><p>No demo receipts yet. Select issues, create a preview, then start the ready items. Each receipt is admission evidence from this page, not a top-level run list.</p>
        <div class="wk-row-actions"><button type="button" class="btn" id="runs-go-work" data-act="go-work">Go to Work</button><a class="btn ghost" href="runs.html">Open the canonical Runs page</a></div></div></div>`;
      return;
    }
    const cur = currentRun();
    el.dataset.detail = state.runDetailOpen ? "true" : "false";
    el.innerHTML = `
      <div class="wk-runs-list" id="wk-runs-list">
        <div class="wk-runs-head">
          <h1 id="runs-title" tabindex="-1">Saved demo requests</h1>
          <p class="faint">Admission receipts recorded by this page. They are request details here, not a competing Runs view. The canonical operating view is <a href="runs.html">runs.html</a>, where these appear as separate unobserved requests. No agent runs here, and none of them become the existing example attempt 3.</p>
        </div>
        ${storageBanner()}
        ${state.receipts
          .slice()
          .reverse()
          .map((r) => receiptBlock(r, cur))
          .join("")}
      </div>
      <section class="wk-run" id="wk-run" aria-label="Saved request detail">${
        cur
          ? runDetail(cur)
          : '<div class="wk-pv-empty"><p>No request was recorded. Every item in these receipts was blocked.</p></div>'
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

    Object.keys(modelRegistry).forEach((k) => delete modelRegistry[k]);
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
    let h = state.view === "work" ? "" : "#" + state.view;
    if (state.view === "runs" && state.runDetailOpen && state.runSel)
      h = `#runs/${encodeURIComponent(state.runSel.receipt)}/${encodeURIComponent(
        state.runSel.issue,
      )}`;
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
    state.machineSettings = false;
    if (!quiet && state.tab === "selected") state.tab = "details";
    if (!quiet) state.drawer = true;
  }

  function toggleSelect(id, on, focus) {
    const issue = issueById(id);
    if (!issue) return;
    if (activeItem(id) || issue.existing || (on && issue.scope !== state.scopeId)) return;
    if (on === isSelected(id)) return;
    changeDraft((d) => {
      if (on) d.selected.push(id);
      else dropFromDraft(d, [id]);
    });
    if (on) state.focusId = id;
    render(focus);
  }

  function applyFix(t) {
    const id = t.dataset.id;
    const machine = t.dataset.machine;
    const instance = t.dataset.instance;
    const model = t.dataset.model;
    const effort = t.dataset.effort;
    changeDraft((d) => {
      const o = Object.assign({}, d.overrides[id]);
      const previousMachine = o.machine || d.defaults.machine;
      if (machine) {
        if (machine === d.defaults.machine) delete o.machine;
        else o.machine = machine;
        if (machine !== previousMachine && !instance && !model) {
          // An explicit machine change drops the old machine's exact provider target; the
          // default profile resolves on the chosen machine or the row blocks.
          delete o.instance;
          delete o.model;
          delete o.effort;
        }
      }
      if (instance && model) {
        o.instance = instance;
        o.model = model;
        if (effort) o.effort = effort;
      }
      if (Object.keys(o).length) d.overrides[id] = o;
      else delete d.overrides[id];
    });
    state.modelOpen = null;
    render("ov-m-" + hash(id));
    toast(
      `${labelOf(id)} assignment changed. Preview again to check the exact target; nothing starts from this change.`,
    );
  }

  function openMachine(mid, settings) {
    state.machineOpen = mid;
    state.machineSettings = !!settings;
    state.drawer = true;
    render("wk-settings-fixture");
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
        const el = $("ov-m-" + hash(t.dataset.id));
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
      toggleSelect(
        id,
        false,
        fromList ? (next ? "si-rm-" + hash(next) : "itab-selected") : "d-select",
      );
      toast(`${labelOf(id)} removed from the selection.`);
    },
    "apply-fix"(t) {
      applyFix(t);
    },
    "open-fix-settings"(t) {
      openMachine(t.dataset.machine, true);
      toast(
        "Settings, Connections fixture opened for this machine. No token is requested or stored. Your draft is intact; preview again after a repair.",
      );
    },
    "create-preview"() {
      if (!state.draft.selected.length) {
        toast("Select at least one issue first.");
        return;
      }
      const outside = orderedSelected().filter((id) => issueById(id).scope !== state.scopeId);
      if (outside.length) {
        toast(
          `${plural(outside.length, "selected issue")} belongs to another source or scope. Clear the selection or switch back before previewing; one preview keeps one source scope.`,
        );
        return;
      }
      state.preview = buildPreview();
      state.view = "preview";
      state.startError = null;
      state.sourceChanged = null;
      render("pv-title");
    },
    start() {
      startDemo(state.outcome);
    },
    "go-work"() {
      state.view = "work";
      render("step-work");
    },
    "fix-in-work"(t) {
      const issue = issueById(t.dataset.id);
      if (issue) {
        state.connectionId = issue.connection;
        state.scopeId = issue.scope;
        state.repoByScope[issue.scope] =
          state.repoByScope[issue.scope] || defaultRepoFor(issue.scope);
      }
      state.view = "work";
      state.focusId = t.dataset.id;
      state.machineOpen = null;
      state.tab = "selected";
      state.drawer = true;
      render("itab-selected");
      const el = $("ov-m-" + hash(t.dataset.id));
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
      persistRecovery();
      render();
      toast("Plan edits discarded. The saved plan is unchanged.");
    },
    "save-decision"(t) {
      saveDecision(t.dataset.id);
      render();
    },
    "close-drawer"() {
      state.drawer = false;
      render("tt-" + hash(state.focusId));
    },
    "close-machine"() {
      closeMachine();
    },
    "close-run"() {
      const cur = currentRun();
      state.runDetailOpen = false;
      render(cur ? `ri-${cur.r.id}-${hash(cur.it.issueId)}` : "runs-title");
    },
    "clear-filters"() {
      state.q = "";
      state.wf = "all";
      state.label = "all";
      render("wk-q");
    },
    "load-more"() {
      const info = scopeInfo();
      if (!info) return;
      const remaining = scopeRemaining(info);
      state.loadedByScope[info.scope.id] = info.scope.total;
      persistContext();
      render("act-load-more");
      toast(
        `Loaded the remaining ${plural(remaining, "sample issue")}. All ${info.scope.total} matching issues are now visible; a changed preview must be created again.`,
      );
    },
    "refresh-source"() {
      const info = scopeInfo();
      if (!info) {
        render();
        return;
      }
      if (info.scope.state === "loading") return;
      const scope = info.scope;
      const resume =
        scope.state === "empty" ? "empty" : loadedFor(scope.id) < scope.total ? "partial" : "ready";
      scope.state = "loading";
      render("wk-conn");
      window.setTimeout(() => {
        scope.state = resume;
        scope.revision += 1;
        scope.fetchedAt = nowText();
        state.sourceChanged = `New sample revision ${scope.revision}, fetched ${stamp(
          scope.fetchedAt,
        )}`;
        render("wk-conn");
        toast(
          "Sample source refreshed after a fixture loading state. Existing previews are out of date; no fetch or tracker write happened.",
        );
      }, 700);
    },
    "repair-connection"() {
      const conn = connectionById(state.connectionId);
      if (!conn || conn.state !== "error") return;
      conn.state = "ready";
      conn.scopes.forEach((s) => {
        if (s.state === "error") {
          s.loaded = s.total;
          s.state = s.total ? "ready" : "empty";
          s.revision += 1;
          s.fetchedAt = nowText();
        }
      });
      if (!state.scopeId && conn.scopes.length) {
        state.scopeId = conn.scopes[0].id;
        state.repoByScope[state.scopeId] = defaultRepoFor(state.scopeId);
      }
      if (!state.focusId && state.scopeId) {
        const first = issuesForScope(state.scopeId)[0];
        if (first) state.focusId = first.id;
      }
      render("wk-conn");
      toast(
        "Sample connection repaired in this fixture. No token was entered, read or stored. Your draft is intact; preview again.",
      );
    },
    "open-existing-settings"(t) {
      openMachine(t.dataset.machine, true);
    },
    "demo-restore"(t) {
      machineFix(t.dataset.machine, { connected: true });
      render("wk-settings-fixture");
      toast(
        `${machineById(t.dataset.machine).name} marked connected in this demo. No real connection was made. Your draft is intact; preview again.`,
      );
    },
    "demo-provider"(t) {
      const fix = state.fixes[t.dataset.machine] || {};
      const profiles = (fix.providers || []).slice();
      if (profiles.indexOf(t.dataset.agent) < 0) profiles.push(t.dataset.agent);
      machineFix(t.dataset.machine, { providers: profiles });
      render("wk-settings-fixture");
      toast(
        `${agent(t.dataset.agent).name} enabled on ${machineById(t.dataset.machine).name} in this demo only. No token was read or stored. Preview again.`,
      );
    },
    "demo-repo"(t) {
      const mid = t.dataset.machine;
      const repoId = t.dataset.repo;
      const path =
        mid === "work"
          ? "C:\\Users\\sample\\src\\" +
            (repoId === "repo_docs_01" ? "neokod-docs" : "neokod-mirror")
          : "/srv/" + (repoId === "repo_docs_01" ? "neokod-docs" : "neokod-mirror");
      const fix = state.fixes[mid] || {};
      const repos = Object.assign({}, fix.repos);
      repos[repoId] = { state: "found", path, base: "main at 7ac20f1" };
      machineFix(mid, { repos });
      render("wk-settings-fixture");
      toast(
        `Sample repository path added for ${machineById(mid).name}. This is fixture data. Your draft is intact; preview again.`,
      );
    },
    "back-to-work"() {
      state.view = "work";
      render("step-work");
      toast("Draft kept. Create a new preview before starting; nothing was launched.");
    },
    "discard-recovery"() {
      discardRecovery();
    },
    "request-withdrawal"(t) {
      requestWithdrawal(t.dataset.receipt, t.dataset.issue);
    },
    "reconcile-unknown"(t) {
      reconcileUnknown(t.dataset.receipt, t.dataset.issue, t.dataset.outcome);
    },
    "reconcile-withdrawal"(t) {
      reconcileWithdrawal(t.dataset.receipt, t.dataset.issue, t.dataset.outcome);
    },
    "link-new-request"(t) {
      const id = t.dataset.issue;
      const r = receiptById(t.dataset.receipt);
      if (!r) return;
      state.view = "work";
      state.scopeId = issueById(id).scope;
      state.connectionId = issueById(id).connection;
      state.focusId = id;
      state.tab = "selected";
      if (!isSelected(id) && !activeItem(id)) {
        changeDraft((d) => {
          if (!d.selected.includes(id)) d.selected.push(id);
        });
      }
      render("itab-selected");
      toast(
        "Linked new demo request prepared. The previous request, machine and target are retained in its receipt; preview and start again. Nothing was launched.",
      );
    },
  };

  function closeMachine() {
    const mid = state.machineOpen;
    state.machineOpen = null;
    state.machineSettings = false;
    if (narrow()) state.drawer = false;
    render(mid ? "mb-" + mid : null);
  }

  function selectVisible(on) {
    const list = filteredIssues().filter(isSelectable);
    const changed = list.filter((i) => isSelected(i.id) !== on).map((i) => i.id);
    if (!changed.length) return render("wk-selvis");
    changeDraft((d) => {
      if (on) changed.forEach((id) => d.selected.push(id));
      else dropFromDraft(d, changed);
    });
    render("wk-selvis");
    const info = scopeInfo();
    const notLoaded = info ? info.scope.total - loadedFor(info.scope.id) : 0;
    toast(
      on
        ? `Selected ${plural(changed.length, "visible issue")}. Issues outside the filters, the ${notLoaded} not loaded and the other scope were not selected.`
        : `Cleared ${plural(changed.length, "visible issue")}. Selected issues hidden by filters or scope were kept.`,
    );
  }

  function persistContext() {
    if (
      !writeJson(KEY.context, {
        connectionId: state.connectionId,
        scopeId: state.scopeId,
        repoByScope: state.repoByScope,
        loadedByScope: state.loadedByScope,
      })
    )
      state.storageWriteError =
        "Could not save the selected source and repository. Keep this tab open.";
  }
  function restoreContext(s) {
    const c = readJson(KEY.context);
    if (!c || typeof c !== "object") return;
    const scope = scopeById(c.scopeId);
    if (scope && scope.connection.id === c.connectionId) {
      s.connectionId = c.connectionId;
      s.scopeId = c.scopeId;
    }
    D.connections.forEach((conn) =>
      conn.scopes.forEach((scope) => {
        const repo = c.repoByScope && c.repoByScope[scope.id];
        if (scope.repositories.some((r) => r.id === repo)) s.repoByScope[scope.id] = repo;
        const loaded = c.loadedByScope && c.loadedByScope[scope.id];
        if (Number.isInteger(loaded) && loaded >= 0 && loaded <= scope.total)
          s.loadedByScope[scope.id] = loaded;
      }),
    );
  }

  function setConnection(id) {
    const conn = connectionById(id);
    state.connectionId = id;
    state.modelOpen = null;
    state.label = "all";
    state.wf = "all";
    state.sourceChanged = null;
    if (!conn || !conn.scopes.length) {
      state.scopeId = null;
      state.focusId = null;
    } else if (!conn.scopes.some((s) => s.id === state.scopeId)) {
      state.scopeId = conn.scopes[0].id;
      state.repoByScope[state.scopeId] = defaultRepoFor(state.scopeId);
      const first = issuesForScope(state.scopeId)[0];
      state.focusId = first && loadedFor(state.scopeId) ? first.id : null;
    }
    if (state.scopeId && !state.repoByScope[state.scopeId])
      state.repoByScope[state.scopeId] = defaultRepoFor(state.scopeId);
    state.tab = "details";
    persistContext();
    render("wk-conn");
  }

  function setScope(id) {
    state.scopeId = id;
    state.repoByScope[id] = defaultRepoFor(id);
    const first = issuesForScope(id)[0];
    state.focusId = first && loadedFor(id) ? first.id : null;
    state.label = "all";
    state.wf = "all";
    state.modelOpen = null;
    state.sourceChanged = null;
    state.tab = "details";
    persistContext();
    render("wk-scope");
  }

  /* Reset popover ------------------------------------------------------- */
  function resetError(text) {
    const pop = $("wk-reset-pop");
    let el = $("wk-reset-error");
    if (!el && document.createElement && pop) {
      el = document.createElement("p");
      el.id = "wk-reset-error";
      el.className = "wk-blocktext";
      el.setAttribute("role", "alert");
      const row = pop.querySelector(".wk-pop-row");
      if (row) pop.insertBefore(el, row);
      else pop.appendChild(el);
    }
    if (el) {
      el.textContent = text || "";
      el.hidden = !text;
    }
  }

  function openReset() {
    state.resetSnapshot = receiptSnapshot();
    state.resetting = false;
    resetError("");
    $("wk-reset-pop").hidden = false;
    $("wk-reset").setAttribute("aria-expanded", "true");
    $("wk-reset-cancel").focus();
  }
  function closeReset(refocus) {
    $("wk-reset-pop").hidden = true;
    $("wk-reset").setAttribute("aria-expanded", "false");
    state.resetSnapshot = null;
    resetError("");
    if (refocus) $("wk-reset").focus();
  }
  async function doReset() {
    if (state.resetting) return;
    state.resetting = true;
    const confirmBtn = $("wk-reset-confirm");
    if (confirmBtn) confirmBtn.disabled = true;
    const result = await withReceiptLock(() => {
      const current = receiptSnapshot();
      if (!current.ok) return { ok: false, error: current.error };
      const snapshot = state.resetSnapshot;
      if (!snapshot || !snapshot.ok) {
        return {
          ok: false,
          error:
            "Reset could not verify the receipt history before clearing. Nothing was reset. Close and open Reset again.",
        };
      }
      if (current.raw !== snapshot.raw)
        return {
          ok: false,
          changed: true,
          snapshot: current.raw,
          error:
            "New receipts were recorded after you opened Reset. Nothing was cleared. Review the new history, then confirm Reset again.",
        };
      const cleared = clearNamespace();
      return cleared.ok ? cleared : { ok: false, error: cleared.error };
    });
    state.resetting = false;
    if (confirmBtn) confirmBtn.disabled = false;
    if (!result.ok) {
      if (result.changed) state.resetSnapshot = { ok: true, raw: result.snapshot };
      resetError(result.error || result.reason || "Reset failed. Nothing was reset.");
      toast(result.error || result.reason || "Reset failed. Nothing was reset.");
      return result;
    }
    state = load();
    closeReset(false);
    render("wk-reset");
    toast("Work demo reset. The theme and other pages were not changed.");
    return { ok: true };
  }

  /* Storage events ------------------------------------------------------ */
  function onStorage(e) {
    if (!state) return;
    if (e.key === null || e.key === KEY.receipts) {
      const read = readReceiptStore();
      if (read.ok) {
        state.receipts = read.value;
        state.receiptsError = null;
        if (state.preview && state.preview.receiptId && !receiptById(state.preview.receiptId)) {
          state.preview.receiptId = null;
        }
      } else state.receiptsError = read.error;
    }
    if (e.key === KEY.plans) state.plans = sanitizePlans(readJson(KEY.plans));
    if (e.key === KEY.fixes) {
      const raw = readJson(KEY.fixes);
      state.fixes = raw && typeof raw === "object" ? raw : {};
      state.fixRev = (state.fixRev || 0) + 1;
    }
    if (e.key === KEY.draft) {
      const raw = readJson(KEY.draft);
      if (raw) {
        state.savedJson = canonical(sanitizeDraft(raw));
        state.savedAt = typeof raw.savedAt === "string" ? raw.savedAt.slice(0, 24) : null;
      }
    }
    render();
  }

  /* Events -------------------------------------------------------------- */
  function onClick(e) {
    const t = e.target;
    if (!t.closest(".wk-reset-anchor") && !$("wk-reset-pop").hidden) closeReset(false);

    const modelOpen = t.closest("[data-model-open]");
    if (modelOpen && !modelOpen.disabled) {
      const ctx = modelOpen.dataset.modelOpen;
      const opening = state.modelOpen !== ctx;
      state.modelOpen = opening ? ctx : null;
      state.modelInstance = state.modelInstance || {};
      state.modelQuery = "";
      return render(opening ? "wk-model-q-" + ctx : "wk-model-trigger-" + ctx);
    }
    const modelInstance = t.closest("[data-model-instance]");
    if (modelInstance && !modelInstance.disabled) {
      const [ctx, id] = modelInstance.dataset.modelInstance.split("|");
      state.modelInstance = state.modelInstance || {};
      state.modelInstance[ctx] = id;
      state.modelQuery = "";
      return render("wk-model-trigger-" + ctx);
    }
    const modelPick = t.closest("[data-model-pick]");
    if (modelPick && !modelPick.disabled) {
      const [ctx, instance, model] = modelPick.dataset.modelPick.split("|");
      return applyModelPick(ctx, instance, model);
    }
    const modelEffort = t.closest("[data-model-effort]");
    if (modelEffort && !modelEffort.disabled) {
      const [ctx, effort] = modelEffort.dataset.modelEffort.split("|");
      const desc = modelRegistry[ctx];
      if (!desc) return;
      const sum = pickSummary(desc.machine, desc.pick || {});
      if (!sum.ok || !sum.instance || !sum.model) {
        toast("Choose an available model before choosing its effort.");
        return;
      }
      return applyModelPick(ctx, sum.instance, sum.model, effort);
    }
    const modelReset = t.closest("[data-model-reset]");
    if (modelReset) return resetModelPick(modelReset.dataset.modelReset);

    const el = t.closest(
      "[data-act],[data-view],[data-inspect],[data-machine],[data-openrun],[data-wf],[data-tab],[data-rtab],[data-rtab-go]",
    );
    if (el) {
      if (el.disabled) return;
      const ds = el.dataset;
      if (ds.rtabGo) {
        state.runTab = ds.rtabGo;
        return render("rtab-" + ds.rtabGo);
      }
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
        state.machineSettings = false;
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
      render("tt-" + hash(row.dataset.row));
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.cb) return toggleSelect(t.dataset.cb, t.checked, t.id);
    if (t.id === "wk-selvis") return selectVisible(t.checked);
    if (t.id === "wk-conn") return setConnection(t.value);
    if (t.id === "wk-scope") return setScope(t.value);
    if (t.id === "wk-repo") {
      state.repoByScope[state.scopeId] = t.value;
      persistContext();
      return render("wk-repo");
    }
    if (t.id === "wk-label") {
      state.label = t.value;
      return render(t.id);
    }
    if (t.dataset.outcome) {
      state.outcome = t.dataset.outcome;
      return render("pv-start");
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
        if (k === "machine") {
          if (t.value && t.value !== d.defaults.machine) o.machine = t.value;
          else delete o.machine;
        } else if (t.value) o[k] = t.value;
        else delete o[k];
        if (Object.keys(o).length) d.overrides[id] = o;
        else delete d.overrides[id];
      });
      return render("ov-m-" + hash(id));
    }
    if (t.dataset.decision) {
      state.decisionEdits[t.dataset.decision] = t.value;
      scheduleRecovery();
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
    if (t.dataset.modelQ != null) {
      state.modelQuery = t.value;
      return render("wk-model-q-" + t.dataset.modelQ);
    }
    if (t.dataset.plan) {
      const id = t.dataset.plan;
      const ctx = t.dataset.ctx;
      state.planEdits[id] = t.value;
      const dirty = t.value !== planOf(id).text;
      if (!dirty) delete state.planEdits[id];
      scheduleRecovery();
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
      if (state.modelOpen) {
        state.modelOpen = null;
        return render();
      }
      if (t.id === "wk-q" && state.q) {
        state.q = "";
        return render("wk-q");
      }
      if (state.view === "work" && state.machineOpen) return closeMachine();
      if (state.view === "work" && state.drawer && narrow()) return ACTIONS["close-drawer"]();
      if (state.view === "runs" && state.runDetailOpen && narrow()) return ACTIONS["close-run"]();
    }
  }

  function onBeforeUnload(e) {
    if (!hasRecoverable()) return;
    e.preventDefault();
    e.returnValue = "";
  }

  /* Init ---------------------------------------------------------------- */
  function load() {
    const s = {
      view: "work",
      q: "",
      wf: "all",
      label: "all",
      connectionId: D.defaults.connection,
      scopeId: D.defaults.scope,
      repoByScope: {},
      loadedByScope: {},
      focusId: SHARED_ID,
      tab: "details",
      machineOpen: null,
      machineSettings: false,
      drawer: false,
      draft: null,
      savedJson: null,
      savedAt: null,
      plans: {},
      planEdits: {},
      decisionEdits: {},
      receipts: [],
      receiptsError: null,
      storageProbe: { ok: true, reason: null },
      storageWriteError: null,
      recoveryError: null,
      recovered: null,
      startError: null,
      starting: false,
      resetSnapshot: null,
      resetting: false,
      fixes: {},
      fixRev: 0,
      outcome: "accepted",
      preview: null,
      sourceChanged: null,
      runSel: null,
      runTab: "summary",
      runDetailOpen: false,
      highlight: null,
      inspKey: "",
      modelOpen: null,
      modelQuery: "",
      modelInstance: {},
    };
    state = s;
    s.draft = emptyDraft();
    s.storageProbe = probeStorage();
    const read = readReceiptStore();
    if (read.ok) s.receipts = read.value;
    else s.receiptsError = read.error;
    s.plans = sanitizePlans(readJson(KEY.plans));
    const fixesRaw = readJson(KEY.fixes);
    if (fixesRaw && typeof fixesRaw === "object") s.fixes = fixesRaw;
    D.connections.forEach((c) =>
      c.scopes.forEach((scope) => {
        s.repoByScope[scope.id] = defaultRepoFor(scope.id);
      }),
    );
    restoreContext(s);
    const raw = readJson(KEY.draft);
    if (raw) {
      const d = sanitizeDraft(raw);
      dropFromDraft(
        d,
        d.selected.filter((id) => activeItem(id)),
      );
      s.draft = d;
      s.savedJson = canonical(d);
      s.savedAt = typeof raw.savedAt === "string" ? raw.savedAt.slice(0, 24) : null;
    }
    const rec = readJson(KEY.edits);
    if (rec && typeof rec === "object") {
      const restoredDraft = sanitizeDraft(rec.draft);
      const restoredJson = canonical(restoredDraft);
      if (restoredJson !== s.savedJson) {
        dropFromDraft(
          restoredDraft,
          restoredDraft.selected.filter((id) => activeItem(id)),
        );
        s.draft = restoredDraft;
      }
      s.planEdits =
        rec.planEdits && typeof rec.planEdits === "object" ? Object.assign({}, rec.planEdits) : {};
      s.decisionEdits =
        rec.decisionEdits && typeof rec.decisionEdits === "object"
          ? Object.assign({}, rec.decisionEdits)
          : {};
      if (typeof rec.at === "string") s.recovered = { at: rec.at };
    }
    return s;
  }

  NK.onReady(() => {
    state = load();

    // Query and hash selection. work.html#runs is the stable request-detail route.
    const params = new URLSearchParams(location.search);
    const qConn = params.get("connection");
    const qScope = params.get("scope");
    const qIssue = params.get("issue");
    const qView = params.get("view");
    const qReceipt = params.get("receipt");
    if (qConn && connectionById(qConn)) {
      state.connectionId = qConn;
      if (qScope && scopeById(qScope)) state.scopeId = qScope;
      else {
        const conn = connectionById(qConn);
        state.scopeId = conn.scopes.length ? conn.scopes[0].id : null;
      }
    } else if (qScope && scopeById(qScope)) {
      state.connectionId = scopeById(qScope).connection.id;
      state.scopeId = qScope;
    }
    if (state.scopeId && !state.repoByScope[state.scopeId])
      state.repoByScope[state.scopeId] = defaultRepoFor(state.scopeId);
    if (qIssue && issueById(qIssue)) state.focusId = qIssue;
    if (qView === "preview" || qView === "runs" || qView === "work") state.view = qView;
    if (qReceipt && receiptById(qReceipt)) {
      const r = receiptById(qReceipt);
      const item =
        (qIssue && r.items.find((x) => x.issueId === qIssue)) ||
        r.items.find((x) => isAdmission(x)) ||
        r.items[0];
      state.view = "runs";
      state.runSel = { receipt: qReceipt, issue: item ? item.issueId : null };
      state.runDetailOpen = true;
    }
    let h = "";
    let focusFromLink = !!qIssue;
    try {
      h = decodeURIComponent(location.hash.slice(1));
    } catch (e) {
      h = "";
    }
    if (h === "preview" || h === "runs" || h === "work") state.view = h;
    else if (h.indexOf("runs/") === 0) {
      const parts = h.split("/");
      const rid = parts[1] || "";
      const iid = parts[2] || "";
      if (receiptById(rid)) {
        const item =
          receiptById(rid).items.find((x) => x.issueId === iid) || receiptById(rid).items[0];
        state.view = "runs";
        state.runSel = { receipt: rid, issue: item ? item.issueId : null };
        state.runDetailOpen = true;
      }
    } else if (h.indexOf("work/") === 0) {
      const id = h.slice(5);
      if (issueById(id)) {
        state.focusId = id;
        focusFromLink = true;
      }
    } else if (issueById(h)) {
      state.focusId = h;
      focusFromLink = true;
    }

    const focused = issueById(state.focusId);
    if (focusFromLink && focused) {
      state.connectionId = focused.connection;
      state.scopeId = focused.scope;
      state.repoByScope[focused.scope] =
        state.repoByScope[focused.scope] || defaultRepoFor(focused.scope);
    } else if (state.scopeId) {
      const scoped = issuesForScope(state.scopeId);
      if (scoped.length && !scoped.some((i) => i.id === state.focusId))
        state.focusId = loadedFor(state.scopeId) ? scoped[0].id : null;
    }

    buildMainShell();
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("storage", onStorage);
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
