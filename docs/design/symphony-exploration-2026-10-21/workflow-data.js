/* Concept B map data for NEO-4821 (detailed sample) plus a generic stage outline for other runs. */
(function () {
  "use strict";

  const W = 2050;
  const H = 620;
  const BANDS = [
    { k: "intake", x: 0, w: 190 },
    { k: "design", x: 190, w: 350 },
    { k: "build", x: 540, w: 560 },
    { k: "integrate", x: 1100, w: 210 },
    { k: "review", x: 1310, w: 370 },
    { k: "pr", x: 1680, w: 370 },
  ];

  // Shared spine nodes (identical in expanded and folded layouts)
  const spine = [
    {
      id: "intake",
      stage: "intake",
      x: 20,
      y: 286,
      w: 150,
      h: 56,
      title: "Issue imported",
      sub: "GitHub #4821",
      kind: "host",
    },
    {
      id: "arch",
      stage: "design",
      x: 210,
      y: 286,
      w: 150,
      h: 56,
      title: "Architect",
      sub: "Design v2",
      kind: "agent",
      actor: "R",
    },
    {
      id: "critic",
      stage: "design",
      x: 380,
      y: 286,
      w: 150,
      h: 56,
      title: "Design critic",
      sub: "Approved, round 2",
      kind: "agent",
      actor: "C3",
    },
    {
      id: "integrate",
      stage: "integrate",
      x: 1125,
      y: 264,
      w: 160,
      h: 100,
      title: "Integrate",
      sub: "At 7f3a9c2",
      kind: "host",
      tiers: [
        ["passed", "Unit"],
        ["failed", "Integration"],
        ["notrun", "End to end"],
      ],
    },
    {
      id: "review1",
      stage: "review",
      x: 1330,
      y: 286,
      w: 150,
      h: 56,
      title: "Round 1",
      sub: "Sent back",
      kind: "agent",
      actor: "C3",
    },
    {
      id: "review2",
      stage: "review",
      x: 1512,
      y: 286,
      w: 150,
      h: 56,
      title: "Round 2",
      sub: "Not started",
      kind: "agent",
    },
    {
      id: "escalate",
      stage: "review",
      x: 1512,
      y: 420,
      w: 150,
      h: 56,
      title: "Escalate to you",
      sub: "If round 2 fails",
      kind: "gate",
    },
    {
      id: "pr",
      stage: "pr",
      x: 1700,
      y: 286,
      w: 150,
      h: 56,
      title: "Open PR",
      sub: "Not opened",
      kind: "host",
    },
    {
      id: "merge",
      stage: "pr",
      x: 1880,
      y: 286,
      w: 150,
      h: 56,
      title: "Human merge",
      sub: "Locked",
      kind: "human",
    },
  ];

  const expanded = {
    groups: [
      { id: "A", x: 552, y: 100, w: 536, h: 112, label: "Package A: client outbox" },
      { id: "B", x: 552, y: 416, w: 536, h: 112, label: "Package B: server receipts" },
    ],
    nodes: spine.concat([
      {
        id: "implA",
        stage: "build",
        x: 566,
        y: 136,
        w: 150,
        h: 56,
        title: "Implementer",
        sub: "Completed 14:07",
        kind: "agent",
        actor: "C1",
      },
      {
        id: "testA",
        stage: "build",
        x: 744,
        y: 136,
        w: 150,
        h: 56,
        title: "Unit tests",
        sub: "At an earlier head",
        kind: "host",
      },
      {
        id: "criticA",
        stage: "build",
        x: 922,
        y: 136,
        w: 150,
        h: 56,
        title: "Critic",
        sub: "Accepted",
        kind: "agent",
        actor: "C3",
      },
      {
        id: "implB",
        stage: "build",
        x: 566,
        y: 452,
        w: 150,
        h: 56,
        title: "Implementer",
        sub: "Waiting for you",
        kind: "agent",
        actor: "C2",
      },
      {
        id: "testB",
        stage: "build",
        x: 744,
        y: 452,
        w: 150,
        h: 56,
        title: "Tester",
        sub: "Last seen 14:21",
        kind: "agent",
        actor: "N1",
        observed: true,
      },
      {
        id: "criticB",
        stage: "build",
        x: 922,
        y: 452,
        w: 150,
        h: 56,
        title: "Critic",
        sub: "Not run",
        kind: "agent",
      },
      {
        id: "decision",
        stage: "build",
        x: 566,
        y: 552,
        w: 150,
        h: 52,
        title: "Decision D-3",
        sub: "Unknown ack",
        kind: "decision",
      },
    ]),
    edges: [
      { from: "intake", to: "arch", s: "done" },
      { from: "arch", to: "critic", s: "done" },
      {
        from: "critic",
        to: "arch",
        s: "returned",
        d: "M455 286 C455 222, 285 222, 285 286",
        label: "Sent back in round 1",
        lx: 370,
        ly: 228,
      },
      { from: "critic", to: "implA", s: "done" },
      { from: "critic", to: "implB", s: "done" },
      { from: "implA", to: "testA", s: "done" },
      { from: "testA", to: "criticA", s: "done" },
      { from: "implB", to: "testB", s: "done" },
      { from: "testB", to: "criticB", s: "pending" },
      { from: "criticA", to: "integrate", s: "done" },
      { from: "criticB", to: "integrate", s: "pending" },
      {
        from: "implB",
        to: "decision",
        s: "blocked",
        d: "M641 508 V552",
        label: "Asked 14:26",
        lx: 652,
        ly: 545,
        anchor: "start",
        attn: true,
      },
      { from: "integrate", to: "review1", s: "done" },
      {
        from: "review1",
        to: "implB",
        s: "returned",
        d: "M1405 342 V368 Q1405 380 1393 380 H672 Q660 380 660 392 V452",
        label: "Repair round 1 of 2",
        lx: 880,
        ly: 373,
      },
      { from: "review1", to: "review2", s: "pending", label: "After repair", lx: 1496, ly: 276 },
      { from: "review2", to: "escalate", s: "pending", d: "M1587 342 V420" },
      { from: "review2", to: "pr", s: "pending" },
      { from: "pr", to: "merge", s: "pending" },
    ],
  };

  const folded = {
    groups: [],
    nodes: spine.concat([
      {
        id: "build",
        stage: "build",
        x: 690,
        y: 264,
        w: 200,
        h: 100,
        title: "Build",
        sub: "2 packages",
        kind: "agent",
        tiers: [
          ["done", "Package A"],
          ["needs", "Package B"],
        ],
      },
      {
        id: "decision",
        stage: "build",
        x: 715,
        y: 420,
        w: 150,
        h: 52,
        title: "Decision D-3",
        sub: "Unknown ack",
        kind: "decision",
      },
    ]),
    edges: [
      { from: "intake", to: "arch", s: "done" },
      { from: "arch", to: "critic", s: "done" },
      {
        from: "critic",
        to: "arch",
        s: "returned",
        d: "M455 286 C455 222, 285 222, 285 286",
        label: "Sent back in round 1",
        lx: 370,
        ly: 228,
      },
      { from: "critic", to: "build", s: "done" },
      { from: "build", to: "integrate", s: "pending" },
      {
        from: "build",
        to: "decision",
        s: "blocked",
        d: "M790 364 V420",
        label: "Asked 14:26",
        lx: 800,
        ly: 398,
        anchor: "start",
        attn: true,
      },
      { from: "integrate", to: "review1", s: "done" },
      {
        from: "review1",
        to: "build",
        s: "returned",
        d: "M1405 342 V378 Q1405 390 1393 390 H872 Q860 390 860 378 V364",
        label: "Repair round 1 of 2",
        lx: 1100,
        ly: 383,
      },
      { from: "review1", to: "review2", s: "pending", label: "After repair", lx: 1496, ly: 276 },
      { from: "review2", to: "escalate", s: "pending", d: "M1587 342 V420" },
      { from: "review2", to: "pr", s: "pending" },
      { from: "pr", to: "merge", s: "pending" },
    ],
  };

  // Base statuses; workflow.js applies demo overrides (decision saved, resume requested).
  const STATUS = {
    intake: "done",
    arch: "done",
    critic: "done",
    implA: "done",
    testA: "superseded",
    criticA: "done",
    implB: "needs",
    testB: "orphaned",
    criticB: "notrun",
    decision: "needs",
    build: "needs",
    integrate: "failed",
    review1: "returned",
    review2: "notrun",
    escalate: "notrun",
    pr: "notrun",
    merge: "locked",
  };

  const PRIMARY = {
    intake: "intake",
    design: "critic",
    build: "implB",
    integrate: "integrate",
    review: "review1",
    pr: "merge",
  };

  const AGENT_NODE = { R: "arch", C1: "implA", C2: "implB", N1: "testB", C3: "review1" };

  const INFO = {
    intake: {
      kind: "Host step",
      summary:
        "GitHub issue #4821 imported at 13:40 and accepted by the Core reliability workflow. Attempt 3 snapshotted the base and workflow at dispatch.",
      evidence: [
        { s: "done", t: "Base e19c4d0 recorded at dispatch" },
        {
          s: "done",
          t: "WORKFLOW.md digest 9d21 recorded",
          n: "A later workflow change would not refresh this attempt",
        },
      ],
      links: [["Next", "arch"]],
    },
    arch: {
      kind: "Agent step",
      summary:
        "The root run wrote the design. Version 1 was sent back by the critic; version 2 was approved in round 2.",
      evidence: [
        { s: "superseded", t: "Design v1", n: "Sent back: the outbox had no size limit" },
        { s: "done", t: "Design v2", n: "Approved in round 2 at 13:47" },
      ],
      links: [
        ["Previous", "intake"],
        ["Next", "critic"],
      ],
    },
    critic: {
      kind: "Agent step",
      summary:
        "C3 graded the design. The same agent later critiques both packages and runs code review, so it appears on several steps.",
      evidence: [
        { s: "returned", t: "Round 1: sent back", n: "Outbox needs a size limit" },
        { s: "done", t: "Round 2: approved v2" },
      ],
      links: [
        ["Previous", "arch"],
        ["Child", "implA"],
        ["Child", "implB"],
      ],
    },
    implA: {
      kind: "Agent step, package A",
      summary:
        "Client outbox in IndexedDB, keyed by message ID. Finished at 14:07 and committed in 3b18e40.",
      evidence: [
        { s: "done", t: "Commit 3b18e40" },
        {
          s: "unknown",
          t: "Agent says its tests pass",
          n: "Agent report. Only host checks count.",
        },
      ],
      links: [
        ["Parent", "critic"],
        ["Next", "testA"],
      ],
    },
    testA: {
      kind: "Host check, package A",
      summary:
        "This unit run passed at 3b18e40. The head has since moved to 7f3a9c2, so it no longer counts. The current result is part of Integrate.",
      evidence: [
        { s: "superseded", t: "vp test apps/web/src/outbox", n: "Host, at 3b18e40" },
        {
          s: "passed",
          t: "vp test apps/web/src/outbox",
          n: "Host, at 7f3a9c2, clean tree (see Integrate)",
        },
      ],
      links: [
        ["Previous", "implA"],
        ["Next", "criticA"],
        ["Current result", "integrate"],
      ],
    },
    criticA: {
      kind: "Agent step, package A",
      summary: "C3 accepted package A at 3b18e40.",
      evidence: [{ s: "done", t: "Accepted with no findings" }],
      links: [
        ["Previous", "testA"],
        ["Next", "integrate"],
      ],
    },
    implB: {
      kind: "Agent step, package B",
      summary:
        "Server send receipts. Repairing review round 1 findings. Paused since 14:26 because it asked decision D-3.",
      evidence: [
        { s: "done", t: "Commit 7f3a9c2", n: "Partial repair: outbox now cleared on sign-out" },
        { s: "needs", t: "Repair round 1 of 2", n: "Waiting on D-3" },
      ],
      links: [
        ["Parent", "critic"],
        ["Asked", "decision"],
        ["Child", "testB"],
        ["Sent back by", "review1"],
      ],
    },
    testB: {
      kind: "Agent step, observed native",
      summary:
        "C2 started this tester through the provider's own subagent feature. Neokod observed it but does not manage it. Tracking was lost when C2's turn settled at 14:21, so it may still be running.",
      evidence: [
        {
          s: "unknown",
          t: "Reported: duplicate after ack loss reproduced",
          n: "Agent report, last observed 14:21:07",
        },
      ],
      links: [
        ["Parent", "implB"],
        ["Next", "criticB"],
      ],
    },
    criticB: {
      kind: "Agent step, package B",
      summary: "Not run. It waits for the package B repair to finish.",
      evidence: [],
      links: [
        ["Previous", "testB"],
        ["Next", "integrate"],
      ],
    },
    decision: { kind: "Decision", summary: "", evidence: [], links: [["Asked by", "implB"]] },
    build: {
      kind: "Stage, folded",
      summary:
        "Two bounded packages ran in parallel, each with an implementer, a test step and a critic. Package A is done. Package B is waiting for decision D-3.",
      evidence: [
        { s: "done", t: "Package A: client outbox", n: "C1, accepted at 3b18e40" },
        { s: "needs", t: "Package B: server receipts", n: "C2, paused on D-3" },
      ],
      links: [
        ["Previous", "critic"],
        ["Asked", "decision"],
        ["Next", "integrate"],
      ],
    },
    integrate: {
      kind: "Host step",
      summary:
        "Host validation of both packages together at 7f3a9c2 with a clean tree. Integration failed, so review round 2 cannot start.",
      evidence: [
        { s: "passed", t: "vp test apps/web/src/outbox", n: "Unit, 38 tests, at 7f3a9c2" },
        {
          s: "failed",
          t: "vp test apps/server/src/reconnect",
          n: "Integration, 1 of 12 failed: duplicate after ack loss",
        },
        { s: "notrun", t: "e2e: reconnect-mid-send", n: "Waits for package B" },
        { s: "superseded", t: "All tiers at 3b18e40", n: "Earlier head" },
      ],
      links: [
        ["From", "criticA"],
        ["From", "criticB"],
        ["Next", "review1"],
      ],
    },
    review1: {
      kind: "Agent step, bounded review",
      summary:
        "C3 reviewed 3b18e40 and requested changes. Package B went back for repair round 1 of 2.",
      evidence: [
        { s: "failed", t: "Blocking: a lost acknowledgement can deliver twice", n: "Open" },
        {
          s: "done",
          t: "Blocking: outbox not cleared on sign-out",
          n: "Fixed at 7f3a9c2, not re-reviewed",
        },
      ],
      links: [
        ["Previous", "integrate"],
        ["Sent back to", "implB"],
        ["Next", "review2"],
      ],
    },
    review2: {
      kind: "Agent step, bounded review",
      summary:
        "Starts after the repair lands and Integrate passes at the new head. This is the last round: if it fails, the run escalates to you instead of trying a third time.",
      evidence: [],
      links: [
        ["Previous", "review1"],
        ["On failure", "escalate"],
        ["Next", "pr"],
      ],
    },
    escalate: {
      kind: "Gate",
      summary:
        "Escalates to you, with evidence, when round 2 fails, the repair budget runs out, the same failure repeats or evidence is unknown. D-3 is an early escalation of the last kind.",
      evidence: [],
      links: [
        ["From", "review2"],
        ["Example", "decision"],
      ],
    },
    pr: {
      kind: "Host step",
      summary: "The workflow opens a pull request after review passes. Not opened.",
      evidence: [],
      links: [
        ["Previous", "review2"],
        ["Next", "merge"],
      ],
    },
    merge: {
      kind: "Human gate",
      summary:
        "Merging is yours under the workflow's merge policy. It stays locked until every check below holds at the same head. There is no merge action in this prototype.",
      evidence: [
        { s: "notrun", t: "Pull request opened" },
        { s: "unknown", t: "CI at PR head", n: "No PR yet" },
        { s: "notrun", t: "Review round 2 approved" },
        { s: "failed", t: "Validation passed at PR head", n: "Integration failed at 7f3a9c2" },
      ],
      links: [["Previous", "pr"]],
    },
  };

  const BAND_SUB = {
    intake: ["Done", ""],
    design: ["Done, 2 rounds", ""],
    build: ["2 packages, B waiting", "attn"],
    integrate: ["Failed at 7f3a9c2", "danger"],
    review: ["Round 1 of 2 sent back", ""],
    pr: ["Merge locked", ""],
  };

  window.NK_MAP = { W, H, BANDS, expanded, folded, STATUS, PRIMARY, AGENT_NODE, INFO, BAND_SUB };
})();
