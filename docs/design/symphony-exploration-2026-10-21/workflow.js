/* Concept B: workflow map. Local demo state only; the map never advances on its own. */
(function () {
  "use strict";
  const F = window.NK_FIX;
  const M = window.NK_MAP;
  const NK = window.NK;
  const { esc, icon, glyph, pill } = NK;
  const $ = (id) => document.getElementById(id);

  const TITLES = {
    critic: "Design critic",
    implA: "Implementer, package A",
    testA: "Unit tests, package A",
    criticA: "Critic, package A",
    implB: "Implementer, package B",
    testB: "Tester subagent",
    criticB: "Critic, package B",
    review1: "Review round 1",
    review2: "Review round 2",
    build: "Build, 2 packages",
  };
  const PACKAGE_NODES = ["implA", "testA", "criticA", "implB", "testB", "criticB"];

  let state;
  function initialState() {
    return {
      runId: "NEO-4821",
      sel: "decision",
      folded: false,
      zoom: 1,
      decision: { draft: null, note: "", saved: null },
      resume: null,
      clock: 30,
    };
  }
  function demoTime() {
    state.clock += 1;
    return "14:" + String(state.clock).padStart(2, "0");
  }
  const run = () => F.runs.find((r) => r.id === state.runId);
  const isDetailed = () => state.runId === "NEO-4821";
  function setHash(id) {
    try {
      history.replaceState(null, "", "#" + id);
    } catch (e) {
      /* some file:// contexts reject history changes; the hash is only a convenience */
    }
  }

  /* Layout and projection -------------------------------------------- */
  function genericLayout(r) {
    const nodes = M.BANDS.map((b) => ({
      id: "g-" + b.k,
      stage: b.k,
      x: b.x + (b.w - 150) / 2,
      y: 286,
      w: 150,
      h: 56,
      title: F.STAGE_NAMES[b.k],
      sub: (NK.STATUS[r.stages[b.k]] || NK.STATUS.unknown).label,
      kind: b.k === "intake" || b.k === "integrate" ? "host" : b.k === "pr" ? "human" : "agent",
      generic: true,
    }));
    const quiet = ["notrun", "skipped", "queued"];
    const edges = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({
        from: nodes[i].id,
        to: nodes[i + 1].id,
        s: quiet.includes(r.stages[nodes[i + 1].stage]) ? "pending" : "done",
      });
    }
    return { groups: [], nodes, edges };
  }
  function layout() {
    if (!isDetailed()) return genericLayout(run());
    return state.folded ? M.folded : M.expanded;
  }
  const nodeById = (id) => layout().nodes.find((n) => n.id === id);

  function statusOf(n) {
    if (n.generic) return run().stages[n.stage];
    let s = M.STATUS[n.id];
    if (state.decision.saved) {
      if (n.id === "decision") s = "saved";
      if (n.id === "implB" || n.id === "build") s = "paused";
    }
    return s;
  }
  function subOf(n) {
    if (isDetailed() && state.decision.saved) {
      if (n.id === "decision") return "Saved " + state.decision.saved.at;
      if (n.id === "implB") return state.resume ? "Resume requested" : "Paused";
    }
    return n.sub;
  }
  function tiersOf(n) {
    if (n.id === "build" && state.decision.saved)
      return [
        ["done", "Package A"],
        ["paused", "Package B"],
      ];
    return n.tiers;
  }
  function edgeOf(e) {
    if (e.s === "blocked" && state.decision.saved)
      return Object.assign({}, e, {
        s: "done",
        label: "Answered " + state.decision.saved.at,
        attn: false,
      });
    return e;
  }
  function stageStatus(k) {
    const r = run();
    if (isDetailed() && k === "build" && state.decision.saved) return "paused";
    return r.stages[k];
  }
  function bandSub(k) {
    if (isDetailed()) {
      if (k === "build" && state.decision.saved) return ["2 packages, B paused", ""];
      return M.BAND_SUB[k];
    }
    const s = run().stages[k];
    return [
      (NK.STATUS[s] || NK.STATUS.unknown).label,
      s === "needs" ? "attn" : s === "failed" ? "danger" : "",
    ];
  }

  /* SVG rendering ----------------------------------------------------- */
  function pathFor(e, L) {
    if (e.d) return e.d;
    const a = L.nodes.find((n) => n.id === e.from);
    const b = L.nodes.find((n) => n.id === e.to);
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    if (y1 === y2) return `M${x1} ${y1} H${x2}`;
    const dx = Math.max(30, (x2 - x1) / 2);
    return `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  function nodeSvg(n) {
    const s = statusOf(n);
    const st = NK.STATUS[s] || NK.STATUS.unknown;
    const sel = n.id === state.sel;
    const rx = n.kind === "host" || n.kind === "gate" ? 3 : 10;
    const sub = subOf(n);
    const iconName = n.kind === "decision" && s === "needs" ? "question" : st.icon;
    let inner =
      `<rect class="ring" x="-4" y="-4" width="${n.w + 8}" height="${n.h + 8}" rx="${rx + 4}"/>` +
      `<rect class="box" width="${n.w}" height="${n.h}" rx="${rx}"${n.kind === "gate" ? ' stroke-dasharray="5 3"' : ""}/>`;
    if (n.kind === "human")
      inner += `<rect class="box2" x="3" y="3" width="${n.w - 6}" height="${n.h - 6}" rx="${rx - 2}"/>`;
    inner += `<svg x="10" y="13" width="14" height="14" viewBox="0 0 16 16" class="st ${s}">${NK.iconBody(iconName)}</svg>`;
    inner += `<text class="t" x="30" y="24">${esc(n.title)}</text><text class="s" x="30" y="42">${esc(sub)}</text>`;
    const tiers = tiersOf(n);
    if (tiers) {
      tiers.forEach(([ts, label], i) => {
        const y = 62 + i * 15;
        inner += `<svg x="30" y="${y - 10}" width="12" height="12" viewBox="0 0 16 16" class="st ${ts}">${NK.iconBody((NK.STATUS[ts] || NK.STATUS.unknown).icon)}</svg>`;
        inner += `<text class="tier" x="46" y="${y}">${esc(label)} <tspan opacity=".8">${esc((NK.STATUS[ts] || NK.STATUS.unknown).label.toLowerCase())}</tspan></text>`;
      });
    }
    if (n.actor) {
      const bw = 10 + n.actor.length * 7;
      inner += `<g class="badge${n.observed ? " observed" : ""}" transform="translate(${n.w - bw - 8} 10)"><rect width="${bw}" height="16" rx="4"/><text x="${bw / 2}" y="12" text-anchor="middle">${n.actor}</text></g>`;
    }
    const aria = `${TITLES[n.id] || n.title}. ${sub}. ${st.label}.${n.actor ? ` Agent ${n.actor}${n.observed ? ", observed native" : ""}.` : ""} ${F.STAGE_NAMES[n.stage]} stage.`;
    return `<g class="node k-${n.kind} s-${s}${sel ? " selected" : ""}" id="n-${n.id}" data-node="${n.id}" role="button" tabindex="${sel ? 0 : -1}" aria-pressed="${sel}" aria-label="${esc(aria)}" transform="translate(${n.x} ${n.y})">${inner}</g>`;
  }

  function renderMap() {
    const L = layout();
    const svg = $("map");
    const r = run();
    svg.setAttribute("viewBox", `0 0 ${M.W} ${M.H}`);
    svg.setAttribute("width", Math.round(M.W * state.zoom));
    svg.setAttribute("height", Math.round(M.H * state.zoom));
    let h = "<defs>";
    ["done", "pending", "returned", "blocked"].forEach((k) => {
      h += `<marker id="ar-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9 z" class="m-${k}"/></marker>`;
    });
    h += "</defs>";
    M.BANDS.forEach((b, i) => {
      const [sub, tone] = bandSub(b.k);
      h += `<rect class="band${i % 2 ? " alt" : ""}${b.k === r.stage && !r.history ? " current" : ""}" x="${b.x}" y="0" width="${b.w}" height="${M.H}"/>`;
      if (i) h += `<line class="band-line" x1="${b.x}" y1="0" x2="${b.x}" y2="${M.H}"/>`;
      h += `<text class="band-name" x="${b.x + 16}" y="26">${i + 1}  ${F.STAGE_NAMES[b.k]}</text>`;
      h += `<text class="band-sub ${tone}" x="${b.x + 16}" y="44">${esc(sub)}</text>`;
    });
    L.groups.forEach((g) => {
      h += `<rect class="group-box" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="10"/>`;
      h += `<text class="group-name" x="${g.x + g.w - 14}" y="${g.y + 20}" text-anchor="end">${esc(g.label)}</text>`;
    });
    const labels = [];
    L.edges.map(edgeOf).forEach((e) => {
      const hot = e.from === state.sel || e.to === state.sel;
      h += `<path class="edge e-${e.s}${hot ? " hot" : ""}" d="${pathFor(e, L)}" marker-end="url(#ar-${e.s})"/>`;
      if (e.label)
        labels.push(
          `<text class="elabel${e.attn ? " attn" : ""}" x="${e.lx}" y="${e.ly}" text-anchor="${e.anchor || "middle"}">${esc(e.label)}</text>`,
        );
    });
    h += labels.join("");
    h += L.nodes.map(nodeSvg).join("");
    svg.innerHTML = h;
  }

  /* Inspector --------------------------------------------------------- */
  function agentFor(id) {
    return run().agents.find((a) => a.id === id);
  }
  function lineage(a) {
    if (a.managed === "root") return "Root run";
    if (a.managed === "observed")
      return `Observed native subagent of ${a.parent}. Neokod does not manage it.`;
    return "Managed child of R";
  }

  function decisionPanel() {
    const d = F.decision;
    const s = state.decision;
    if (!s.saved) {
      return `<section class="i-sec i-act">
        <p style="font-weight:600" id="wdq">${esc(d.title)}</p>
        <p class="muted" style="margin:6px 0 10px">${esc(d.context)}</p>
        <div role="radiogroup" aria-labelledby="wdq">${d.options
          .map(
            (
              o,
            ) => `<label class="choice"><input type="radio" name="wd3" value="${o.id}" ${s.draft === o.id ? "checked" : ""}/>
            <span class="c-label">${esc(o.label)}${o.suggested ? ` <span class="suggested">Suggested by C2</span>` : ""}</span>
            <span class="c-detail">${esc(o.detail)}</span></label>`,
          )
          .join("")}</div>
        <label class="label" for="wd3-note" style="display:block;margin-top:10px">Note for the record (optional)</label>
        <textarea id="wd3-note" class="field" rows="2" style="margin-top:4px">${esc(s.note)}</textarea>
        <div class="row"><button type="button" class="btn primary" data-act="save-decision" aria-disabled="${!s.draft}" aria-describedby="wd3-hint">Save decision</button>
        <span class="faint" id="wd3-req">${s.draft ? "" : "Choose an option first."}</span></div>
        <p class="i-note" id="wd3-hint">Saving records your answer. Package B stays paused and the map will not move on its own.</p>
      </section>`;
    }
    const opt = d.options.find((o) => o.id === s.saved.option);
    return `<section class="i-sec i-act">
      <div class="saved" id="act-focus" tabindex="-1">${icon("check")}<div><strong>Saved at ${s.saved.at}</strong> by you<br/>${esc(opt.label)}${s.saved.note ? `<br/><span class="muted">Note: ${esc(s.saved.note)}</span>` : ""}</div></div>
      ${
        state.resume
          ? `<p class="i-note">Resume requested at ${state.resume} (demo). Package B stays paused until the server reports it running. This prototype has no server, so the map will not change.</p>
             <div class="row"><button type="button" class="btn" data-act="withdraw-resume">Withdraw resume request</button><button type="button" class="btn ghost" data-act="reopen">Reopen decision</button></div>`
          : `<div class="row"><button type="button" class="btn primary" data-act="resume">${icon("play")}Request resume of package B</button><button type="button" class="btn ghost" data-act="reopen">Reopen decision</button></div>
             <p class="i-note">Saving did not start work. The map changes only when the server reports new events.</p>`
      }
    </section>`;
  }

  function linkButton(rel, id) {
    if (state.folded && PACKAGE_NODES.includes(id)) id = "build";
    const n = nodeById(id);
    if (!n) return "";
    return `<button type="button" data-goto="${id}"><span class="rel">${esc(rel)}</span>${glyph(statusOf(n))}<span>${esc(TITLES[id] || n.title)}</span></button>`;
  }

  function renderInspector() {
    const el = $("inspector");
    const r = run();
    const n = nodeById(state.sel);
    if (!n) {
      el.innerHTML = `<div class="i-body"><p class="muted" style="padding-top:16px">Select a step on the map.</p></div>`;
      return;
    }
    const s = statusOf(n);
    const title = TITLES[n.id] || n.title;
    if (n.generic) {
      const i = F.STAGES.indexOf(n.stage);
      el.innerHTML = `<div class="i-head"><div class="i-kind">Stage ${i + 1} of 6</div><h2>${esc(title)}</h2>${pill(s)}</div>
        <div class="i-body">
          <section class="i-sec"><p>${esc(r.id)} ${esc(r.title)}. ${esc(r.statusText)}.</p>
          ${r.blocker ? `<p class="muted">${esc(r.blocker)}</p>` : ""}</section>
          <section class="i-sec"><h3>Linked stages</h3><div class="i-links">
            ${i > 0 ? linkButton("Previous", "g-" + F.STAGES[i - 1]) : ""}${i < 5 ? linkButton("Next", "g-" + F.STAGES[i + 1]) : ""}</div></section>
          <section class="i-sec"><p class="i-note">This sample has a detailed step map for NEO-4821 only. For other runs the map shows the stage outline from their recorded stage status.</p>
          <p style="margin-top:8px"><a href="runs.html#${r.id}">Open ${r.id} in the runs view</a></p></section>
        </div>`;
      return;
    }
    const info = M.INFO[n.id];
    let body = "";
    if (n.id === "decision") body += decisionPanel();
    if (info.summary) body += `<section class="i-sec"><p>${esc(info.summary)}</p></section>`;
    if (info.evidence.length)
      body += `<section class="i-sec"><h3>Evidence</h3><ul class="i-ev">${info.evidence
        .map(
          (e) =>
            `<li class="${e.s}">${glyph(e.s)}<span><span>${esc(e.t)}</span>${e.n ? `<span class="n">${esc(e.n)}</span>` : ""}</span></li>`,
        )
        .join("")}</ul></section>`;
    if (n.actor) {
      const a = agentFor(n.actor);
      const also = layout().nodes.filter((x) => x.actor === n.actor && x.id !== n.id);
      body += `<section class="i-sec"><h3>Agent</h3><dl class="i-agent">
        <dt>Agent</dt><dd>${a.id} ${esc(a.role)}</dd>
        <dt>Lineage</dt><dd>${esc(lineage(a))}</dd>
        <dt>Model</dt><dd>${esc(a.model)}${a.model.startsWith("Sample") ? " (sample label)" : ""}</dd>
        <dt>State</dt><dd>${pill(a.status, a.statusText)}</dd>
        <dt>Elapsed</dt><dd class="${a.status === "orphaned" ? "tone-orphan" : ""}">${esc(a.elapsed)}</dd>
        <dt>Cost</dt><dd>${NK.costText(a.cost)}</dd></dl>
        ${also.length ? `<p class="label" style="margin-top:10px">Also on these steps</p><div class="i-links">${also.map((x) => linkButton("Step", x.id)).join("")}</div>` : ""}
      </section>`;
    }
    body += `<section class="i-sec"><h3>Linked steps</h3><div class="i-links">${info.links.map(([rel, id]) => linkButton(rel, id)).join("")}</div>
      ${n.id === "build" ? `<div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-act="unfold">${icon("chevronDown")}Show packages</button></div>` : ""}</section>`;
    body += `<section class="i-sec"><h3>Agents in this run</h3><ul class="i-tree">${r.agents
      .map((a) => {
        const target = M.AGENT_NODE[a.id];
        const go = state.folded && PACKAGE_NODES.includes(target) ? "build" : target;
        return `<li><button type="button" data-goto="${go}" style="--d:${a.depth}" aria-current="${n.actor === a.id}">${glyph(a.status)}
          <span>${a.id} ${esc(a.role)}${a.managed === "observed" ? ` <span class="tag observed">Observed</span>` : ""}</span>
          <span class="meta${a.status === "orphaned" ? " orphaned" : ""}">${esc(a.statusText)}</span></button></li>`;
      })
      .join("")}</ul>
      <p class="i-note">6 stages and ${layout().nodes.length} steps, run by ${r.agents.length} agents. A stage or step is not an agent: C3 appears on ${layout().nodes.filter((x) => x.actor === "C3").length} steps.</p></section>`;

    el.innerHTML = `<div class="i-head"><div class="i-kind">${esc(info.kind)}<span>${F.STAGE_NAMES[n.stage]} stage</span></div>
      <h2 id="i-title" tabindex="-1">${esc(title)}</h2>${pill(s, s === "saved" ? "Decision saved" : undefined)}</div><div class="i-body">${body}</div>`;
  }

  /* Chrome: subbar, popovers, stepper -------------------------------- */
  function attentionRuns() {
    return F.runs.filter((r) => r.attention && !(r.id === "NEO-4821" && state.decision.saved));
  }
  function renderChrome() {
    const r = run();
    $("run-switch-label").innerHTML = `<span class="rid">${r.id}</span>${esc(r.title)}`;
    const agentCount = r.agents.length;
    $("run-facts").innerHTML = `
      <span>Attempt <strong>${r.attempt || "none"}</strong>${r.attempt ? ` of ${r.maxAttempts}` : ""}</span>
      <span>Head <strong class="mono">${esc(r.head)}</strong></span>
      <span class="hide-mid">${glyph(isDetailed() && state.decision.saved ? "paused" : r.status)}${esc(isDetailed() && state.decision.saved ? "Paused, decision saved" : r.statusText)}</span>
      <span class="hide-mid" title="Stages are workflow steps, not agents">6 stages, ${agentCount} ${agentCount === 1 ? "agent" : "agents"}</span>`;
    const ar = attentionRuns();
    const ab = $("attn-btn");
    ab.dataset.count = ar.length;
    ab.innerHTML = `${icon("alert")}Needs you ${ar.length}`;
    $("attn-pop-list").innerHTML = ar.length
      ? ar
          .map(
            (
              x,
            ) => `<button type="button" class="w-pop-item" data-run="${x.id}" data-focus="${x.id === "NEO-4821" ? "decision" : ""}" aria-current="${x.id === state.runId}">
            ${glyph(x.attention.kind === "orphaned" ? "orphaned" : x.attention.kind === "repeat" ? "failed" : "needs")}
            <span class="id">${x.id}</span><span class="t">${esc(x.attention.label)}<small>${esc(x.attention.summary)}</small></span></button>`,
          )
          .join("")
      : `<p class="muted" style="padding:6px">Nothing is waiting on you.</p>`;
    $("run-pop-list").innerHTML = F.runs
      .filter((x) => !x.history)
      .map(
        (
          x,
        ) => `<button type="button" class="w-pop-item" data-run="${x.id}" aria-current="${x.id === state.runId}">
          ${glyph(x.status)}<span class="id">${x.id}</span><span class="t">${esc(x.title)}<small>${esc(x.statusText)}</small></span></button>`,
      )
      .join("");
    const fb = $("fold-btn");
    fb.hidden = !isDetailed();
    fb.setAttribute("aria-pressed", String(state.folded));
    fb.innerHTML = state.folded
      ? `${icon("chevronDown")}Show packages`
      : `${icon("chevronRight")}Fold packages`;
    $("zoom-val").textContent = Math.round(state.zoom * 100) + "%";

    const selNode = nodeById(state.sel);
    const cur = selNode ? selNode.stage : null;
    $("stepper").innerHTML = F.STAGES.map(
      (k, i) =>
        `<button type="button" data-stage="${k}" aria-current="${cur === k ? "step" : "false"}">${glyph(stageStatus(k))}<span class="num">${i + 1}</span>${F.STAGE_NAMES[k]}<span class="sr-only">, ${(NK.STATUS[stageStatus(k)] || NK.STATUS.unknown).label}</span></button>`,
    ).join('<span class="sep" aria-hidden="true"></span>');
  }

  function render() {
    renderChrome();
    renderMap();
    renderInspector();
  }

  /* Selection, zoom and pan ------------------------------------------ */
  function ensureVisible(id) {
    const n = nodeById(id);
    if (!n) return;
    const z = state.zoom;
    const sc = $("map-scroll");
    const pad = 48;
    if (n.x * z < sc.scrollLeft + pad || (n.x + n.w) * z > sc.scrollLeft + sc.clientWidth - pad)
      sc.scrollLeft = (n.x + n.w / 2) * z - sc.clientWidth / 2;
    if (n.y * z < sc.scrollTop + pad || (n.y + n.h) * z > sc.scrollTop + sc.clientHeight - pad)
      sc.scrollTop = (n.y + n.h / 2) * z - sc.clientHeight / 2;
  }
  function select(id, opts) {
    opts = opts || {};
    if (!nodeById(id)) return;
    state.sel = id;
    render();
    ensureVisible(id);
    if (opts.focusNode) $("n-" + id).focus({ preventScroll: true });
    if (opts.focusInspector) {
      const t = $("i-title") || $("inspector");
      t.focus();
    }
  }
  function setZoom(z) {
    const sc = $("map-scroll");
    const old = state.zoom;
    const cx = (sc.scrollLeft + sc.clientWidth / 2) / old;
    const cy = (sc.scrollTop + sc.clientHeight / 2) / old;
    state.zoom = Math.min(1.6, Math.max(0.3, Math.round(z * 100) / 100));
    renderChrome();
    renderMap();
    sc.scrollLeft = cx * state.zoom - sc.clientWidth / 2;
    sc.scrollTop = cy * state.zoom - sc.clientHeight / 2;
  }
  function fit() {
    const sc = $("map-scroll");
    setZoom(Math.min(sc.clientWidth / M.W, sc.clientHeight / M.H));
    sc.scrollLeft = 0;
    sc.scrollTop = 0;
  }
  function neighbor(id, dir) {
    const nodes = layout().nodes;
    const a = nodeById(id);
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h / 2;
    let best = null;
    let bestScore = Infinity;
    nodes.forEach((n) => {
      if (n.id === id) return;
      const dx = n.x + n.w / 2 - ax;
      const dy = n.y + n.h / 2 - ay;
      const primary = dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
      const secondary = dir === "right" || dir === "left" ? Math.abs(dy) : Math.abs(dx);
      if (primary <= 5) return;
      const score = primary + secondary * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = n.id;
      }
    });
    return best;
  }
  function switchRun(id, focusNode) {
    state.runId = id;
    const r = run();
    state.sel = focusNode || (isDetailed() ? M.PRIMARY[r.stage] : "g-" + r.stage);
    if (isDetailed() && state.folded && PACKAGE_NODES.includes(state.sel)) state.sel = "build";
    setHash(id);
    render();
    ensureVisible(state.sel);
  }
  function toggleFold() {
    state.folded = !state.folded;
    if (state.folded && PACKAGE_NODES.includes(state.sel)) state.sel = "build";
    if (!state.folded && state.sel === "build") state.sel = "implB";
    render();
    ensureVisible(state.sel);
    NK.toast(state.folded ? "Packages folded into one Build step." : "Packages shown.");
  }

  /* Popovers ----------------------------------------------------------- */
  const POPS = { "run-switch": "run-pop", "attn-btn": "attn-pop" };
  function closePops(except) {
    Object.keys(POPS).forEach((b) => {
      if (b === except) return;
      $(POPS[b]).hidden = true;
      $(b).setAttribute("aria-expanded", "false");
    });
  }
  function togglePop(btnId) {
    const pop = $(POPS[btnId]);
    const open = pop.hidden;
    closePops(btnId);
    pop.hidden = !open;
    $(btnId).setAttribute("aria-expanded", String(open));
    if (open) {
      const first = pop.querySelector("button");
      if (first) first.focus();
    }
  }

  /* Actions ------------------------------------------------------------ */
  const ACTIONS = {
    "save-decision"() {
      const s = state.decision;
      if (!s.draft) {
        NK.toast("Choose an option before saving.");
        const f = document.querySelector('input[name="wd3"]');
        if (f) f.focus();
        return false;
      }
      s.saved = { option: s.draft, note: s.note.trim(), at: demoTime() };
      NK.toast("Decision saved. Package B is still paused.");
    },
    reopen() {
      const prev = state.decision.saved;
      state.decision = { draft: prev.option, note: prev.note, saved: null };
      state.resume = null;
      NK.toast("Decision reopened. Your previous answer is kept as a draft.");
    },
    resume() {
      state.resume = demoTime();
      NK.toast("Resume requested (demo). Nothing advances without server events.");
    },
    "withdraw-resume"() {
      state.resume = null;
      NK.toast("Resume request withdrawn.");
    },
    unfold() {
      toggleFold();
      return false;
    },
  };

  NK.onReady(() => {
    state = initialState();
    const sc = $("map-scroll");
    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash && F.runs.some((r) => r.id === fromHash && !r.history)) {
      state.runId = fromHash;
      const r = run();
      state.sel = isDetailed() ? "decision" : "g-" + r.stage;
    }
    // Start legible: never below 80% by default; Fit is one press away.
    state.zoom = Math.min(1, Math.max(0.8, Math.round((sc.clientWidth / M.W) * 100) / 100));
    render();
    ensureVisible(state.sel);

    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-act],[data-goto],[data-run],[data-stage],[data-node]");
      if (!e.target.closest(".w-pop-anchor")) closePops();
      if (!t) return;
      if (t.dataset.act) {
        if (t.getAttribute("aria-disabled") === "true") return ACTIONS[t.dataset.act]();
        if (ACTIONS[t.dataset.act]() !== false) {
          render();
          const f = $("act-focus") || document.querySelector("#inspector .i-act button");
          if (f) f.focus();
        }
        return;
      }
      if (t.dataset.goto) return select(t.dataset.goto, { focusInspector: true });
      if (t.dataset.run) {
        closePops();
        switchRun(t.dataset.run, t.dataset.focus || null);
        $("run-switch").focus();
        return;
      }
      if (t.dataset.stage) {
        const id = isDetailed()
          ? state.folded && t.dataset.stage === "build"
            ? "build"
            : M.PRIMARY[t.dataset.stage]
          : "g-" + t.dataset.stage;
        select(id);
        const sb = document.querySelector(`#stepper [data-stage="${t.dataset.stage}"]`);
        if (sb) sb.focus();
        return;
      }
      if (t.dataset.node) return select(t.dataset.node, { focusNode: true });
    });

    $("run-switch").addEventListener("click", () => togglePop("run-switch"));
    $("attn-btn").addEventListener("click", () => togglePop("attn-btn"));
    $("fold-btn").addEventListener("click", toggleFold);
    $("zoom-in").addEventListener("click", () => setZoom(state.zoom + 0.1));
    $("zoom-out").addEventListener("click", () => setZoom(state.zoom - 0.1));
    $("zoom-reset").addEventListener("click", () => {
      setZoom(1);
      ensureVisible(state.sel);
    });
    $("zoom-fit").addEventListener("click", fit);
    $("reset-demo").addEventListener("click", () => {
      const z = state.zoom;
      state = initialState();
      state.zoom = z;
      setHash("NEO-4821");
      render();
      ensureVisible(state.sel);
      NK.toast("Demo state reset.");
    });

    $("inspector").addEventListener("change", (e) => {
      if (e.target.name === "wd3") {
        state.decision.draft = e.target.value;
        const b = document.querySelector('[data-act="save-decision"]');
        if (b) b.setAttribute("aria-disabled", "false");
        const req = $("wd3-req");
        if (req) req.textContent = "";
      }
    });
    $("inspector").addEventListener("input", (e) => {
      if (e.target.id === "wd3-note") state.decision.note = e.target.value;
    });

    $("map").addEventListener("keydown", (e) => {
      const g = e.target.closest(".node");
      if (!g) return;
      const dirs = { ArrowRight: "right", ArrowLeft: "left", ArrowDown: "down", ArrowUp: "up" };
      if (dirs[e.key]) {
        e.preventDefault();
        const nb = neighbor(g.dataset.node, dirs[e.key]);
        if (nb) select(nb, { focusNode: true });
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const ns = layout()
          .nodes.slice()
          .sort((a, b) => a.x - b.x);
        select((e.key === "Home" ? ns[0] : ns[ns.length - 1]).id, { focusNode: true });
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select(g.dataset.node, { focusInspector: true });
      }
    });

    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (e.key === "Escape") {
        const open = Object.keys(POPS).find((b) => !$(POPS[b]).hidden);
        if (open) {
          closePops();
          $(open).focus();
        }
        return;
      }
      if (tag === "input" || tag === "textarea" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") setZoom(state.zoom + 0.1);
      else if (e.key === "-" || e.key === "_") setZoom(state.zoom - 0.1);
      else if (e.key === "0") {
        setZoom(1);
        ensureVisible(state.sel);
      } else if (e.key === "f" || e.key === "F") fit();
    });

    // Drag the background to pan
    let pan = null;
    sc.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".node")) return;
      pan = { x: e.clientX, y: e.clientY, l: sc.scrollLeft, t: sc.scrollTop };
      sc.setPointerCapture(e.pointerId);
      sc.classList.add("panning");
    });
    sc.addEventListener("pointermove", (e) => {
      if (!pan) return;
      sc.scrollLeft = pan.l - (e.clientX - pan.x);
      sc.scrollTop = pan.t - (e.clientY - pan.y);
    });
    const endPan = () => {
      pan = null;
      sc.classList.remove("panning");
    };
    sc.addEventListener("pointerup", endPan);
    sc.addEventListener("pointercancel", endPan);
  });
})();
