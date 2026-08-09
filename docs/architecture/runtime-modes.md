# Runtime modes

This page covers Code mode's per-thread runtime mode: the sandbox and approval policy applied to an
interactive session you're driving. Symphony, Neokod's autonomous tracker-driven mode, uses a
different, per-workflow policy model instead (`autonomy` plus `approvals.*` in `WORKFLOW.md`); see
[Autonomy levels](./symphony.md#autonomy-levels) and [Policy controls](./symphony.md#policy-controls)
in the Symphony architecture doc.

Network access is independent from a thread's provider sandbox mode. Native
desktop and standalone server runtimes bind only `127.0.0.1` and connect
directly without an application auth session. The desktop-managed WSL runtime
is the sole `0.0.0.0` exception and requires its desktop-generated bearer for
sensitive HTTP plus a fresh single-use WebSocket ticket.

Neokod has a global runtime mode switch in the chat toolbar:

- **Full access** (default): starts sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- **Supervised**: starts sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, then prompts in-app for command/file approvals.

Neither Code-mode toggle applies to Symphony workflows: a Symphony run's effective sandbox and
approval policy is derived per workflow from its `autonomy` level (`execute` by default), not from
this thread-level switch.
