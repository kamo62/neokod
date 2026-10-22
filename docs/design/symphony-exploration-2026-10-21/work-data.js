/* Work intake sample data. Fictional issues, machines and agents.
   Nothing here is detected on this computer or connected to a tracker, server or agent.
   NEO-4821 is read from fixtures.js so the shared issue matches the Runs, Workflow map
   and Plan and decisions pages. Every other issue is a separate demo sample. */
(function () {
  "use strict";

  const FIX = window.NK_FIX || null;
  const shared = FIX ? FIX.runs.find((r) => r.id === "NEO-4821") : null;
  const wfName = (id, fallback) => {
    const w = FIX && FIX.workflows.find((x) => x.id === id);
    return w ? w.name : fallback;
  };

  const STAGES = FIX ? FIX.STAGES : ["intake", "design", "build", "integrate", "review", "pr"];
  const STAGE_NAMES = FIX
    ? FIX.STAGE_NAMES
    : {
        intake: "Intake",
        design: "Design",
        build: "Build",
        integrate: "Integrate",
        review: "Review",
        pr: "PR",
      };

  const tracker = {
    name: "GitHub",
    connection: "Sample GitHub connection",
    repo: "neokod/neokod",
    scope: "Open issues labelled agent-ready",
    fetchedAt: "14:38",
    loaded: 7,
    total: 9,
    unsupported: "Team and iteration filters are not offered by this tracker.",
  };

  // Agent profiles. "via" is the provider route on the target machine.
  const agents = {
    deepseek: { name: "DeepSeek V4.1 Flash", via: "OpenCode (ACP)" },
    sol: { name: "Sol 6.1", via: "Codex" },
    opus: { name: "Opus 5.5", via: "Claude" },
    copilot: { name: "Sample model G", via: "GitHub Copilot" },
  };
  const AGENT_ORDER = ["deepseek", "sol", "opus", "copilot"];

  // Project defaults: one implementer, two reviewers, all on the execution machine.
  const team = { implementer: "deepseek", reviewers: ["sol", "opus"] };

  // Saved machines. Sample facts only: no address resolves and no token exists.
  const machines = [
    {
      id: "mac",
      name: "Sample Mac",
      status: "connected",
      statusText: "Connected",
      checked: "14:36",
      address: "sample-mac.tailnet.example:3773",
      route: "Direct, over Tailscale",
      os: "macOS 26",
      repo: { name: "neokod", path: "/Users/sample/code/neokod", base: "dev at e19c4d0" },
      queue: "Up to 2 runs at once (machine setting)",
      agents: {
        deepseek: { efforts: ["high"] },
        sol: { efforts: ["high"] },
        opus: { efforts: ["high"] },
        copilot: { efforts: [] },
      },
      missing: {},
    },
    {
      id: "work",
      name: "Work PC",
      status: "connected",
      statusText: "Connected",
      checked: "14:35",
      address: "work-pc.office-lan.example:3773",
      route: "Direct, on the office network",
      os: "Windows 11",
      repo: { name: "neokod", path: "C:\\Users\\sample\\src\\neokod", base: "dev at e19c4d0" },
      queue: "1 run at a time (machine setting)",
      agents: {
        sol: { efforts: ["high"] },
        opus: { efforts: ["high"] },
        copilot: { efforts: [] },
      },
      missing: {
        deepseek: "OpenCode is installed on Work PC, but DeepSeek V4.1 Flash is not enabled there.",
      },
    },
    {
      id: "build",
      name: "Build host",
      status: "offline",
      statusText: "Offline, sign-in failed",
      checked: "09:12",
      address: "build-host.office-lan.example:3773",
      route: "Through your own reverse proxy",
      os: "Ubuntu 24.04",
      repo: { name: "neokod", path: "/srv/neokod", base: "Unknown while offline" },
      queue: "Unknown while offline",
      agents: {},
      lastKnown: "OpenCode (ACP) and Codex, as of 09:12",
      problem:
        "It rejected the saved access token at its last check, 09:12, and has not answered since. Update the token in Settings, Connections, Machines.",
      missing: {},
    },
  ];

  const workflows = {
    core: {
      name: wfName("core", "Core reliability"),
      validation: ["vp check", "vp run typecheck", "vp test (affected packages)"],
      approval: "Merge needs you",
    },
    providers: {
      name: wfName("providers", "Provider adapters"),
      validation: ["vp check", "vp run typecheck", "vp test apps/server/src/provider"],
      approval: "Merge needs you",
    },
    settings: {
      name: wfName("settings", "Settings and safety"),
      validation: ["vp check", "vp run typecheck", "vp test apps/web/src/settings"],
      approval: "Plan approval before Build, and merge needs you",
    },
  };

  // What each stage is allowed to do, and who does it. Same for every sample workflow.
  const stagePlan = {
    intake: { role: "implementer", perm: "Reads the issue and the pinned plan" },
    design: { role: "implementer", perm: "Reads the repository; no edits" },
    build: { role: "implementer", perm: "Edits files in a new worktree only" },
    integrate: { role: "host", perm: "Runs the workflow's validation on the target machine" },
    review: { role: "reviewers", perm: "Read-only; can send work back, up to two rounds" },
    pr: { role: "you", perm: "Pushes the branch and opens a PR; merging needs you" },
  };

  const issues = [
    {
      id: "NEO-4821",
      number: 4821,
      nativeId: "I_kwSAMPLE4821",
      shared: true,
      title: shared ? shared.title : "Preserve queued sends across reconnects",
      workflow: "core",
      labels: ["reliability", "web"],
      updated: "13:40",
      description: shared
        ? shared.context.objective
        : "Messages queued while the socket is down are dropped when it reconnects mid-send. Keep them, and never deliver one twice.",
      acceptance: shared
        ? shared.context.acceptance.slice()
        : [
            "A queued send survives a reconnect and a page reload.",
            "A send with a lost acknowledgement is never delivered twice.",
            "The user can see which sends are not yet confirmed.",
          ],
      plan: [
        "Goal: queued sends survive a reconnect and a reload, and are never delivered twice.",
        "",
        "Approach:",
        "- Keep each queued send in a client outbox, keyed by one message ID for its whole life.",
        "- Record server receipts by message ID so a repeated send is ignored.",
        "- Show sends that are not yet confirmed.",
        "",
        "Validation: outbox and reconnect tests, plus an end-to-end check that drops the acknowledgement mid-send.",
      ].join("\n"),
      question: {
        title: "Should the end-to-end check also reload the page mid-send?",
        options: [
          { id: "yes", label: "Yes, reload during the send", suggested: true },
          { id: "no", label: "No, reconnect only" },
        ],
      },
    },
    {
      id: "NEO-4830",
      number: 4830,
      nativeId: "I_kwSAMPLE4830",
      title: "Flag ACP sessions that go silent mid-turn",
      workflow: "providers",
      labels: ["providers", "acp"],
      updated: "12:58",
      description:
        "An OpenCode ACP session can stop sending updates without ending its turn. The thread keeps showing Working and nobody can tell it has stalled.",
      acceptance: [
        "After a set time without an update, the thread shows the session as silent, with the last update time.",
        "Silence alone never marks a turn as finished or failed.",
        "A new update clears the silent state.",
      ],
      plan: [
        "Goal: show when an ACP session has gone silent during a turn.",
        "",
        "Approach:",
        "- Track the time of the last session update for each thread.",
        "- After the threshold, show Silent with the last update time.",
        "- Never close or fail the turn because of silence alone.",
        "",
        "Validation: provider runtime tests with a session that stops sending updates.",
      ].join("\n"),
      question: {
        title: "How long without an update before a session shows as silent?",
        options: [
          { id: "60", label: "60 seconds" },
          { id: "90", label: "90 seconds", suggested: true },
          { id: "180", label: "3 minutes" },
        ],
      },
    },
    {
      id: "NEO-4833",
      number: 4833,
      nativeId: "I_kwSAMPLE4833",
      title: "Keep terminal scrollback when a thread is reopened",
      workflow: "core",
      labels: ["terminal"],
      updated: "11:20",
      description:
        "Reopening a thread shows an empty terminal drawer, even though the process is still running and producing output.",
      acceptance: [
        "Reopening a thread shows the last 2,000 lines of scrollback.",
        "Scrollback from another thread never appears.",
        "Output that arrived while the thread was closed appears in order.",
      ],
      plan: [
        "Goal: reopening a thread restores its terminal scrollback.",
        "",
        "Approach:",
        "- Keep a bounded scrollback buffer per terminal on the server.",
        "- Replay it, in order, when the drawer reattaches.",
        "",
        "Validation: terminal session tests for reattach, ordering and isolation between threads.",
      ].join("\n"),
    },
    {
      id: "NEO-4838",
      number: 4838,
      nativeId: "I_kwSAMPLE4838",
      title: "Warn before removing a worktree with uncommitted changes",
      workflow: "settings",
      labels: ["git", "safety"],
      updated: "10:47",
      existing: {
        machine: "work",
        at: "11:02",
        text: "Already has accepted work on Work PC, recorded at 11:02 (sample record). A second start would duplicate it.",
        short: "Already has accepted work on Work PC",
      },
      description:
        "Removing a worktree from the sidebar deletes uncommitted changes without a warning.",
      acceptance: [
        "Removal lists uncommitted and untracked files and asks before deleting them.",
        "Ignored files are removed only when you agree separately.",
      ],
      plan: [
        "Goal: never remove uncommitted work without asking.",
        "",
        "Approach:",
        "- Inspect the worktree before removal.",
        "- List changed, untracked and ignored files separately.",
        "",
        "Validation: Git safety tests with temporary repositories.",
      ].join("\n"),
    },
    {
      id: "NEO-4842",
      number: 4842,
      nativeId: "I_kwSAMPLE4842",
      title: "Show which machine each thread runs on",
      workflow: "core",
      labels: ["machines", "ui"],
      updated: "10:05",
      description:
        "With more than one saved machine, the sidebar does not say where a thread is running, so it is easy to act on the wrong one.",
      acceptance: [
        "Every thread row shows its machine name.",
        "A thread on an offline machine shows when it was last seen, not a guessed state.",
      ],
      plan: [
        "Goal: every thread says which machine it runs on.",
        "",
        "Approach:",
        "- Add the machine name to thread rows and the thread header.",
        "- For offline machines, show the last seen time.",
        "",
        "Validation: sidebar and thread header tests.",
      ].join("\n"),
    },
    {
      id: "NEO-4846",
      number: 4846,
      nativeId: "I_kwSAMPLE4846",
      title: "Normalise Windows paths in diff headers",
      workflow: "core",
      labels: ["windows", "diff"],
      updated: "09:31",
      prefers: {
        machine: "work",
        text: "The issue asks for a check on Windows. Work PC is the only Windows machine in this sample.",
      },
      description:
        "Diffs made on Windows show backslash paths, so the file tree and comments do not match the same file from macOS.",
      acceptance: [
        "Diff headers use forward slashes on every platform.",
        "Paths with spaces and non-ASCII names come through unchanged.",
      ],
      plan: [
        "Goal: diff headers use one path style on every platform.",
        "",
        "Approach:",
        "- Normalise separators where diff headers are parsed.",
        "- Keep the original path for display in tooltips.",
        "",
        "Validation: diff parser tests with Windows, space and non-ASCII paths.",
      ].join("\n"),
    },
    {
      id: "NEO-4851",
      number: 4851,
      nativeId: "I_kwSAMPLE4851",
      title: "Back off when the tracker rate-limits issue fetches",
      workflow: "providers",
      labels: ["tracker"],
      updated: "Yesterday",
      description:
        "When the tracker answers with too many requests, the issue list shows an empty result instead of saying the fetch was limited.",
      acceptance: [],
      plan: [
        "Goal: a rate-limited fetch is reported as limited, never as empty.",
        "",
        "Approach:",
        "- Respect the tracker's retry time and back off.",
        "- Keep the last good list and mark it as partial.",
        "",
        "Validation: tracker adapter tests with a limited response.",
      ].join("\n"),
    },
  ];

  window.NK_WORK = {
    tracker,
    agents,
    AGENT_ORDER,
    team,
    machines,
    defaults: { machine: "mac" },
    workflows,
    stagePlan,
    STAGES,
    STAGE_NAMES,
    issues,
  };
})();
