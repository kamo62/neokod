# Workspace layout

- `/apps/server`: Node.js WebSocket server. Drives the provider CLI you choose per session (Claude Code, Codex CLI, Copilot CLI, Cursor CLI, Grok CLI, or OpenCode), serves the built web app, and opens the browser on start.
- `/apps/web`: React + Vite UI. Owns local topology, conversation, notification, and provider event rendering. Connects directly to loopback or through the WSL bearer/ticket adapter.
- `/apps/desktop`: Electron shell. Spawns a desktop-scoped `neokod` backend process and loads the shared web app.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, local/WSL transport, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@neokod/shared/git`, `@neokod/shared/DrainableWorker`) — no barrel index.
- `/packages/client-runtime`: Local browser/desktop connection and environment state runtime. Persists caches only; primary and WSL registrations are in memory.
