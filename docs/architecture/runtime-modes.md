# Runtime modes

Network access is independent from a thread's provider sandbox mode. Native
desktop and standalone server runtimes bind only `127.0.0.1` and connect
directly without an application auth session. The desktop-managed WSL runtime
is the sole `0.0.0.0` exception and requires its desktop-generated bearer for
sensitive HTTP plus a fresh single-use WebSocket ticket.

T3 Code has a global runtime mode switch in the chat toolbar:

- **Full access** (default): starts sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- **Supervised**: starts sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, then prompts in-app for command/file approvals.
