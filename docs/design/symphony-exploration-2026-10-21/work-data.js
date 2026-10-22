/* Work intake sample data. Fictional issues, machines and agents.
   Nothing here is detected on this computer or connected to a tracker, server or agent.
   NEO-4821 is read from fixtures.js so the shared issue matches the Runs, Workflow map
   and Plan and decisions pages. Every other issue is a separate demo sample.

   Canonical identities
   --------------------
   connection.id / scope.id / scope.nativeId / issue.nativeId / machine.id / provider.id and
   model.id are opaque and stable. `issue.id` is the Work selection key; `issue.label` is only
   what the tracker shows. A mirror scope deliberately carries the same displayed keys as the
   sample workspace, so selection proves it is scoped by connection and native identity rather
   than by the displayed key alone. */
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

  const SAMPLE_DATE = "22 Oct 2026";

  /* Agent profiles. "via" is the provider route on the target machine. */
  const agents = {
    deepseek: {
      name: "DeepSeek V4.1 Flash",
      via: "OpenCode (ACP)",
      note: "Project default implementer. Exact provider instance, model and effort are pinned in the preview.",
    },
    sol: { name: "Sol 6.1", via: "Codex", note: "Project reviewer default." },
    opus: { name: "Opus 5.5", via: "Claude", note: "Project reviewer default." },
    copilot: { name: "Sample model G", via: "GitHub Copilot", note: "Optional sample model." },
  };
  const AGENT_ORDER = ["deepseek", "sol", "opus", "copilot"];

  /* Project defaults: one implementer, two reviewers, all on the execution machine.
     A profile only resolves to an exact provider instance/model that the machine lists.
     Missing profiles or models block; nothing is substituted. */
  const team = {
    implementer: "deepseek",
    implementerEffort: "high",
    reviewers: [
      { agent: "sol", effort: "high" },
      { agent: "opus", effort: "high" },
    ],
  };

  /* Model catalogue. "enabled" is this provider instance's sample availability. */
  const catalog = {
    deepseek: {
      id: "deepseek/deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      profile: "deepseek",
      efforts: ["high", "medium"],
      defaultEffort: "high",
      enabled: true,
    },
    sol: {
      id: "gpt-6.1-sol",
      name: "Sol 6.1",
      profile: "sol",
      efforts: ["high", "medium"],
      defaultEffort: "high",
      enabled: true,
    },
    opus: {
      id: "claude-opus-5-5",
      name: "Opus 5.5",
      profile: "opus",
      efforts: ["high", "low"],
      defaultEffort: "high",
      enabled: true,
    },
    copilot: {
      id: "sample-model-g",
      name: "Sample model G",
      profile: "copilot",
      efforts: [],
      defaultEffort: null,
      enabled: true,
    },
  };
  const model = (key, extra) => Object.assign({}, catalog[key], extra || {});
  const qwen = {
    id: "qwen/sample-coder",
    name: "Sample Qwen Coder",
    profile: null,
    efforts: ["medium"],
    defaultEffort: "medium",
    enabled: false,
    reason: "This sample account has no access to Sample Qwen Coder.",
  };

  const provider = (id, driver, name, account, models) => ({
    id,
    driver,
    name,
    account,
    models,
  });

  /* Saved machines. Sample facts only: no address resolves and no token exists.
     capabilities are requirements a machine either provides or does not. preferences are not
     capabilities: an issue can prefer Windows without proving any other host incapable. */
  const machines = [
    {
      id: "mac",
      name: "Sample Mac",
      status: "connected",
      statusText: "Connected",
      checked: SAMPLE_DATE + ", 14:36",
      address: "sample-mac.tailnet.example:3773",
      route: "Direct, over Tailscale",
      os: "macOS 26",
      repos: [
        {
          id: "repo_neo_01",
          name: "neokod/neokod",
          path: "/Users/sample/code/neokod",
          base: "dev at e19c4d0",
          state: "found",
        },
        {
          id: "repo_docs_01",
          name: "neokod/neokod-docs",
          path: "/Users/sample/code/neokod-docs",
          base: "main at 7ac20f1",
          state: "found",
        },
        {
          id: "repo_mirror_01",
          name: "neokod-mirror/neokod",
          path: "",
          base: "Unknown",
          state: "missing",
          reason: "Repository neokod-mirror/neokod is not cloned on Sample Mac.",
        },
      ],
      queue: "Up to 2 runs at once (machine setting)",
      capabilities: ["posix-host", "macos"],
      providers: [
        provider("pi_mac_opencode", "opencode", "OpenCode (ACP)", "Sample OpenCode profile", [
          model("deepseek"),
          qwen,
        ]),
        provider("pi_mac_codex", "codex", "Codex", "Sample Codex login", [model("sol")]),
        provider("pi_mac_claude", "claude", "Claude", "Sample Claude login", [model("opus")]),
        provider("pi_mac_copilot", "copilot", "GitHub Copilot", "Sample Copilot seat", [
          model("copilot"),
        ]),
      ],
      missing: {},
    },
    {
      id: "work",
      name: "Work PC",
      status: "connected",
      statusText: "Connected",
      checked: SAMPLE_DATE + ", 14:35",
      address: "work-pc.office-lan.example:3773",
      route: "Direct, on the office network",
      os: "Windows 11",
      repos: [
        {
          id: "repo_neo_01",
          name: "neokod/neokod",
          path: "C:\\Users\\sample\\src\\neokod",
          base: "dev at e19c4d0",
          state: "found",
        },
        {
          id: "repo_docs_01",
          name: "neokod/neokod-docs",
          path: "",
          base: "Unknown",
          state: "missing",
          reason: "Repository neokod/neokod-docs is not cloned on Work PC.",
        },
        {
          id: "repo_mirror_01",
          name: "neokod-mirror/neokod",
          path: "",
          base: "Unknown",
          state: "missing",
          reason: "Repository neokod-mirror/neokod is not cloned on Work PC.",
        },
      ],
      queue: "1 run at a time (machine setting)",
      capabilities: ["windows-host", "posix-host"],
      providers: [
        provider("pi_work_opencode", "opencode", "OpenCode (ACP)", "Work OpenCode profile", [
          model("deepseek", {
            enabled: false,
            reason:
              "OpenCode is installed on Work PC, but DeepSeek V4.1 Flash is not enabled for this provider instance.",
          }),
          qwen,
        ]),
        provider("pi_work_codex", "codex", "Codex", "Work Codex login", [model("sol")]),
        provider("pi_work_claude", "claude", "Claude", "Work Claude login", [model("opus")]),
        provider("pi_work_copilot", "copilot", "GitHub Copilot", "Work Copilot seat", [
          model("copilot"),
        ]),
      ],
      missing: {
        deepseek: "OpenCode is installed on Work PC, but DeepSeek V4.1 Flash is not enabled there.",
      },
    },
    {
      id: "build",
      name: "Build host",
      status: "offline",
      statusText: "Offline, sign-in failed",
      checked: SAMPLE_DATE + ", 09:12",
      address: "build-host.office-lan.example:3773",
      route: "Through your own reverse proxy",
      os: "Ubuntu 24.04",
      repos: [
        {
          id: "repo_neo_01",
          name: "neokod/neokod",
          path: "/srv/neokod",
          base: "Unknown while offline",
          state: "unknown",
        },
        {
          id: "repo_docs_01",
          name: "neokod/neokod-docs",
          path: "/srv/neokod-docs",
          base: "Unknown while offline",
          state: "unknown",
        },
        {
          id: "repo_mirror_01",
          name: "neokod-mirror/neokod",
          path: "/srv/neokod-mirror",
          base: "Unknown while offline",
          state: "unknown",
        },
      ],
      queue: "Unknown while offline",
      capabilities: ["posix-host"],
      providers: [],
      lastKnown: "OpenCode (ACP) and Codex, as of 22 Oct 2026, 09:12 (sample record).",
      problem:
        "It rejected the saved access token at its last check, 22 Oct 2026, 09:12, and has not answered since. No token is stored or entered in this prototype.",
      missing: {},
    },
  ];

  /* Connections, projects and scopes. These are fixture records: no request is made.
     state: ready | partial | empty | error | loading. */
  const connections = [
    {
      id: "conn_gh_main",
      name: "GitHub — sample workspace",
      adapter: "GitHub Issues",
      account: "sample-org",
      state: "ready",
      note: "Read-only sample connection. No network request is made.",
      scopes: [
        {
          id: "scope_neo_open",
          name: "Open issues labelled agent-ready",
          nativeId: "scope_gh_main_neo_open",
          project: { id: "proj_neo", key: "NEO", name: "Neokod" },
          state: "partial",
          fetchedAt: SAMPLE_DATE + ", 14:38",
          loaded: 7,
          total: 9,
          revision: 3,
          filters: ["label"],
          unsupported: ["team", "iteration"],
          repositories: [
            { id: "repo_neo_01", name: "neokod/neokod", default: true },
            { id: "repo_docs_01", name: "neokod/neokod-docs" },
          ],
        },
        {
          id: "scope_docs_open",
          name: "Documentation follow-ups",
          nativeId: "scope_gh_main_docs_open",
          project: { id: "proj_docs", key: "DOC", name: "Neokod docs" },
          state: "ready",
          fetchedAt: SAMPLE_DATE + ", 14:31",
          loaded: 2,
          total: 2,
          revision: 1,
          filters: ["label"],
          unsupported: ["team", "iteration"],
          repositories: [{ id: "repo_docs_01", name: "neokod/neokod-docs", default: true }],
        },
        {
          id: "scope_neo_empty",
          name: "Issues awaiting triage (none)",
          nativeId: "scope_gh_main_neo_empty",
          project: { id: "proj_neo", key: "NEO", name: "Neokod" },
          state: "empty",
          fetchedAt: SAMPLE_DATE + ", 14:22",
          loaded: 0,
          total: 0,
          revision: 1,
          filters: ["label"],
          unsupported: ["team", "iteration"],
          repositories: [{ id: "repo_neo_01", name: "neokod/neokod", default: true }],
        },
      ],
    },
    {
      id: "conn_gh_mirror",
      name: "GitHub mirror — sample org",
      adapter: "GitHub Issues",
      account: "sample-mirror",
      state: "ready",
      note: "A second sample connection whose issue keys look like the first. Native IDs and scope identity keep them apart.",
      scopes: [
        {
          id: "scope_mirror_open",
          name: "Open issues labelled agent-ready",
          nativeId: "scope_gh_mirror_open",
          project: { id: "proj_mirror", key: "NEO", name: "Neokod mirror" },
          state: "ready",
          fetchedAt: SAMPLE_DATE + ", 14:27",
          loaded: 2,
          total: 2,
          revision: 2,
          filters: ["label"],
          unsupported: ["team", "iteration"],
          repositories: [{ id: "repo_mirror_01", name: "neokod-mirror/neokod", default: true }],
        },
      ],
    },
    {
      id: "conn_linear_legacy",
      name: "Linear — sample engineering",
      adapter: "Linear",
      account: "sample-linear",
      state: "error",
      error:
        "Sample load failure: the saved token was rejected at 22 Oct 2026, 09:12. No issues were loaded. Repair this sample connection below; no real token is requested or stored here.",
      note: "Fixture error state. Nothing is fetched.",
      scopes: [
        {
          id: "scope_linear_open",
          name: "Open issues (sample)",
          nativeId: "scope_linear_open",
          project: { id: "proj_linear", key: "LIN", name: "Linear sample" },
          state: "error",
          fetchedAt: SAMPLE_DATE + ", 09:12",
          loaded: 0,
          total: 1,
          revision: 1,
          filters: ["label"],
          unsupported: ["team", "iteration", "state"],
          repositories: [{ id: "repo_neo_01", name: "neokod/neokod", default: true }],
        },
      ],
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

  /* What each stage is allowed to do, and who does it. Same for every sample workflow. */
  const stagePlan = {
    intake: { role: "implementer", perm: "Reads the issue and the pinned plan" },
    design: { role: "implementer", perm: "Reads the repository; no edits" },
    build: { role: "implementer", perm: "Edits files in a new worktree only" },
    integrate: { role: "host", perm: "Runs the workflow's validation on the target machine" },
    review: { role: "reviewers", perm: "Read-only; can send work back, up to two rounds" },
    pr: {
      role: "system",
      perm: "The system pushes the branch and opens the pull request after validation. A person reviews and merges; no agent merges.",
    },
  };

  const issues = [
    {
      id: "NEO-4821",
      label: "NEO-4821",
      number: 4821,
      nativeId: "I_kwSAMPLE4821",
      scope: "scope_neo_open",
      connection: "conn_gh_main",
      shared: true,
      title: shared ? shared.title : "Preserve queued sends across reconnects",
      workflow: "core",
      labels: ["reliability", "web"],
      updated: SAMPLE_DATE + ", 13:40",
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
        kind: "advisory",
        holdsStage: null,
        note: "Advisory only. It does not hold a named stage, and saving an answer does not approve execution.",
        options: [
          { id: "yes", label: "Yes, reload during the send", suggested: true },
          { id: "no", label: "No, reconnect only" },
        ],
      },
    },
    {
      id: "NEO-4830",
      label: "NEO-4830",
      number: 4830,
      nativeId: "I_kwSAMPLE4830",
      scope: "scope_neo_open",
      connection: "conn_gh_main",
      title: "Flag ACP sessions that go silent mid-turn",
      workflow: "providers",
      labels: ["providers", "acp"],
      updated: SAMPLE_DATE + ", 12:58",
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
        kind: "blocking",
        holdsStage: "build",
        note: "Blocking question: Intake can be admitted, but Build is held until an answer is saved. Saving an answer is not execution approval.",
        options: [
          { id: "60", label: "60 seconds" },
          { id: "90", label: "90 seconds", suggested: true },
          { id: "180", label: "3 minutes" },
        ],
      },
    },
    {
      id: "NEO-4833",
      label: "NEO-4833",
      number: 4833,
      nativeId: "I_kwSAMPLE4833",
      scope: "scope_neo_open",
      connection: "conn_gh_main",
      title: "Keep terminal scrollback when a thread is reopened",
      workflow: "core",
      labels: ["terminal"],
      updated: SAMPLE_DATE + ", 11:20",
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
      label: "NEO-4838",
      number: 4838,
      nativeId: "I_kwSAMPLE4838",
      scope: "scope_neo_open",
      connection: "conn_gh_main",
      title: "Warn before removing a worktree with uncommitted changes",
      workflow: "settings",
      labels: ["git", "safety"],
      updated: SAMPLE_DATE + ", 10:47",
      existing: {
        machine: "work",
        item: "NEO-4838",
        record: "A-2",
        anchor: "NEO-4838",
        at: SAMPLE_DATE + ", 11:02",
        text: "Already has accepted work on Work PC, accepted record A-2, recorded at 22 Oct 2026, 11:02 (sample record). A second start would duplicate it.",
        short: "Already has accepted work on Work PC (accepted record A-2)",
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
      label: "NEO-4842",
      number: 4842,
      nativeId: "I_kwSAMPLE4842",
      scope: "scope_neo_open",
      connection: "conn_gh_main",
      title: "Show which machine each thread runs on",
      workflow: "core",
      labels: ["machines", "ui"],
      updated: SAMPLE_DATE + ", 10:05",
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
      label: "NEO-4846",
      number: 4846,
      nativeId: "I_kwSAMPLE4846",
      scope: "scope_neo_open",
      connection: "conn_gh_main",
      title: "Normalise Windows paths in diff headers",
      workflow: "core",
      labels: ["windows", "diff"],
      updated: SAMPLE_DATE + ", 09:31",
      prefers: {
        machine: "work",
        text: "This issue prefers Work PC because it asks for a check on Windows. That is a preference, not proof that another machine cannot run the path tests.",
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
      label: "NEO-4851",
      number: 4851,
      nativeId: "I_kwSAMPLE4851",
      scope: "scope_neo_open",
      connection: "conn_gh_main",
      title: "Back off when the tracker rate-limits issue fetches",
      workflow: "providers",
      labels: ["tracker"],
      updated: SAMPLE_DATE + ", 08:55",
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
    {
      id: "NEO-4857",
      label: "NEO-4857",
      number: 4857,
      nativeId: "I_kwSAMPLE4857",
      scope: "scope_neo_open",
      connection: "conn_gh_main",
      title: "Check the Windows installer shortcut after an in-place upgrade",
      workflow: "settings",
      labels: ["windows", "installer"],
      updated: SAMPLE_DATE + ", 14:12",
      requires: {
        capabilities: ["windows-host"],
        text: "This issue requires a Windows host to exercise the installer shortcut. Sample Mac does not provide windows-host, so it cannot be admitted there.",
      },
      description:
        "After an in-place upgrade, the Start menu shortcut can still point at the previous installation directory. The check needs a real Windows host.",
      acceptance: [
        "An in-place upgrade leaves the shortcut pointing at the installed directory.",
        "A missing shortcut is reported, not silently recreated.",
      ],
      plan: [
        "Goal: prove the installer shortcut after an in-place upgrade on Windows.",
        "",
        "Approach:",
        "- Install the previous sample build, then upgrade in place.",
        "- Resolve the shortcut target and compare it with the install directory.",
        "",
        "Validation: a Windows host run of the installer check script.",
      ].join("\n"),
    },
    {
      id: "NEO-4861",
      label: "NEO-4861",
      number: 4861,
      nativeId: "I_kwSAMPLE4861",
      scope: "scope_neo_open",
      connection: "conn_gh_main",
      title: "Show when the issue list was last fetched",
      workflow: "providers",
      labels: ["tracker", "ui"],
      updated: SAMPLE_DATE + ", 14:05",
      description:
        "The issue list never says how old it is, so a stale list can be mistaken for the tracker's current state.",
      acceptance: [
        "The list shows its last successful fetch time and coverage.",
        "A partial fetch is labelled as partial, with the number loaded.",
      ],
      plan: [
        "Goal: make the age and coverage of the loaded issue list explicit.",
        "",
        "Approach:",
        "- Record the last successful fetch time and the loaded/total counts.",
        "- Show them beside the list, with partial and error states.",
        "",
        "Validation: intake state rendering tests for ready, partial and error.",
      ].join("\n"),
    },
    {
      id: "mirror:NEO-4821",
      label: "NEO-4821",
      number: 4821,
      nativeId: "I_kwMIRROR4821",
      scope: "scope_mirror_open",
      connection: "conn_gh_mirror",
      title: "Preserve queued sends across reconnects (mirror copy)",
      workflow: "core",
      labels: ["reliability"],
      updated: SAMPLE_DATE + ", 13:12",
      description:
        "Mirror sample with the same displayed key as the sample workspace issue. Its native ID and scope are different.",
      acceptance: ["The mirror issue stays separate from the sample workspace issue."],
      plan: "Goal: prove two connections keep similar-looking keys apart.",
    },
    {
      id: "mirror:NEO-4830",
      label: "NEO-4830",
      number: 4830,
      nativeId: "I_kwMIRROR4830",
      scope: "scope_mirror_open",
      connection: "conn_gh_mirror",
      title: "Flag silent ACP sessions (mirror copy)",
      workflow: "providers",
      labels: ["providers"],
      updated: SAMPLE_DATE + ", 12:44",
      description:
        "Mirror sample with the same displayed key as the sample workspace issue and a different native ID.",
      acceptance: ["Selecting this mirror issue never selects the sample workspace issue."],
      plan: "Goal: prove selection is scoped by connection and native identity.",
    },
    {
      id: "docs:DOC-12",
      label: "DOC-12",
      number: 12,
      nativeId: "DOC_kwSAMPLE12",
      scope: "scope_docs_open",
      connection: "conn_gh_main",
      title: "Document the local access token location",
      workflow: "settings",
      labels: ["docs"],
      updated: SAMPLE_DATE + ", 11:46",
      description:
        "The self-hosting guide explains the token but not where the CLI keeps it. Add the path and the file mode.",
      acceptance: ["The guide names the default token file and its mode."],
      plan: "Goal: document the token file path and permissions without printing a token.",
    },
    {
      id: "docs:DOC-18",
      label: "DOC-18",
      number: 18,
      nativeId: "DOC_kwSAMPLE18",
      scope: "scope_docs_open",
      connection: "conn_gh_main",
      title: "Add a recovery example for a lost acknowledgement",
      workflow: "core",
      labels: ["docs", "reliability"],
      updated: SAMPLE_DATE + ", 10:18",
      description:
        "The run recovery notes describe unknown acknowledgement but show no example of reconciling it.",
      acceptance: ["A short example shows unknown staying unknown until authoritative evidence."],
      plan: "Goal: add one worked example of unknown acknowledgement reconciliation.",
    },
    {
      id: "lin:LIN-42",
      label: "LIN-42",
      number: 42,
      nativeId: "LIN_kwSAMPLE42",
      scope: "scope_linear_open",
      connection: "conn_linear_legacy",
      title: "Sample Linear issue: show the last successful fetch",
      workflow: "providers",
      labels: ["tracker"],
      updated: SAMPLE_DATE + ", 09:10",
      description:
        "A fixture issue behind the sample error connection. It appears only after the fixture connection is repaired.",
      acceptance: ["The list shows the last successful fetch time."],
      plan: "Goal: show the last successful tracker fetch after a repaired connection.",
    },
  ];

  const primaryScope = connections[0].scopes[0];

  /* Compatibility facts used by older copy in the page. The scope is the live source. */
  const tracker = {
    name: "GitHub",
    connection: connections[0].name,
    connectionId: connections[0].id,
    repo: primaryScope.repositories[0].name,
    scope: primaryScope.name,
    scopeId: primaryScope.id,
    nativeId: primaryScope.nativeId,
    fetchedAt: primaryScope.fetchedAt,
    loaded: primaryScope.loaded,
    total: primaryScope.total,
    unsupported: "Team and iteration filters are not offered by this connection.",
  };

  window.NK_WORK = {
    tracker,
    connections,
    agents,
    AGENT_ORDER,
    team,
    machines,
    defaults: {
      machine: "mac",
      connection: "conn_gh_main",
      scope: "scope_neo_open",
      repo: "repo_neo_01",
    },
    workflows,
    stagePlan,
    STAGES,
    STAGE_NAMES,
    SAMPLE_DATE,
    issues,
  };
})();
