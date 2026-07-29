# Self-hosting `neokod serve`

Runs the web UI on a server behind your own authentication, so agents execute
on that machine and pick up the CLIs installed there. A desktop build cannot do
this: it drives the agent CLIs on the laptop it runs on.

The desktop app remains the primary distribution. This is the deployment for a
machine you already administer.

## Read this before you expose it

The server has **no application authentication**. Loopback is the security
boundary, and the auth/session control plane was removed in the 2.0.0
local-first carve-out. `config.ts` enforces this: a non-loopback bind is
rejected at startup unless the private desktop WSL bootstrap supplies a bearer.

```ts
if (config.host === "127.0.0.1") return config.transport === "loopback";
return config.transport === "wsl-bearer" && Boolean(config.wslBearerToken?.trim());
```

There is deliberately no `--host` flag; a test pins that absence. So the only
supported deployment is **bind loopback, authenticate in a reverse proxy**.

This matters more than for a typical web app. Agents spawn real shells with your
provider credentials, so an unauthenticated route is remote code execution as the
server user, not an information leak. Anyone who reaches the port has your box.

## Install

Requires Node `^22.16 || ^23.11 || >=24.10`.

```bash
npm config set prefix ~/.local   # avoids sudo-installing into /usr
npm install -g neokod
```

`node-pty` is a native module. Registry prebuilds cover common platforms; if
none matches, the install compiles it and needs `python3`, `make` and a C++
compiler (`build-essential` on Debian/Ubuntu).

The install is large. `@github/copilot-sdk` ships platform binaries of roughly
109MB each, so expect a slow first install and set a generous timeout on a
constrained link.

### Agent CLIs

`neokod` drives whatever is on the server's `PATH`. Install the CLIs you intend
to use there: it will not see the ones on your laptop. Check with
`codex --version` and `claude --version` as the same user that runs the service.

## Run

```bash
neokod serve --mode web --port 3000
```

Binds `127.0.0.1:3000` and serves the bundled web client from `dist/client`.
Confirm locally before wiring the proxy:

```bash
curl -sI http://127.0.0.1:3000/ | head -1
```

## Reverse proxy with Authelia and Traefik

This assumes Traefik and Authelia run with `network_mode: host`, which is what
lets them reach a loopback-bound service directly. On a bridge network they
cannot, and the section below on bridge networking applies instead.

Add a router and service to Traefik's dynamic configuration, reusing the
existing `authelia` forward-auth middleware:

```yaml
http:
  routers:
    neokod:
      rule: Host(`neokod.example.com`)
      entryPoints: [web]
      middlewares: [authelia]
      service: neokod

  services:
    neokod:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:3000
```

### The WebSocket route is the part that goes wrong

The UI carries its orchestration traffic over `/ws`. Two failure modes, and
neither is loud:

**An auth rule that misses `/ws`.** If your Authelia policy authenticates by
path rather than by host, a rule covering `/` but not `/ws` leaves the socket
open. The proxy then looks like it is protecting the app while the channel that
actually drives agents is unauthenticated. Prefer a host-level `one_factor`
policy so every path is covered by default:

```yaml
access_control:
  default_policy: deny
  rules:
    - domain: neokod.example.com
      policy: one_factor
```

`default_policy: deny` matters. An allowlist that forgets a path fails open.

**Upgrade headers.** Traefik forwards `Connection` and `Upgrade` by default, so
no extra configuration is normally needed. If you put nginx in front instead,
set them explicitly or the UI loads and then sits with no live updates:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
```

The long read timeout prevents the proxy dropping idle sockets during a long
agent turn.

### Verifying the auth actually holds

Check from a machine that has no session, not from a logged-in browser:

```bash
curl -sI https://neokod.example.com/ | head -1          # expect a redirect to Authelia
curl -sI https://neokod.example.com/ws | head -1        # expect the same, NOT 101
```

A `101 Switching Protocols` on the second command means the socket bypasses
authentication. Stop and fix the policy before using the deployment.

## Running as a service

```ini
[Unit]
Description=Neokod
After=network.target

[Service]
Type=simple
User=youruser
ExecStart=%h/.local/bin/neokod serve --mode web --port 3000
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Install as a user service (`~/.config/systemd/user/neokod.service`, then
`systemctl --user enable --now neokod`) so agents run as your user with your
existing CLI credentials, rather than as root.

State lives in `~/.neokod/userdata` (SQLite plus logs), so back that path up and
keep it on the same filesystem as the projects you work on.

## Bridge-networked proxies

If the proxy runs on a Docker bridge network it cannot reach a host loopback
service. A container reaching the host arrives on the bridge gateway address,
which a process bound to `127.0.0.1` does not accept.

Options, best first:

1. **Give the proxy host networking.** Simplest, and what the configuration
   above assumes.
2. **Run `neokod` in a container with `network_mode: host`**, mounting the
   projects and the agent CLIs. Keeps the proxy unchanged.
3. **Relay** from the bridge address to loopback with `socat` or a systemd
   socket unit. Adds a hop and another thing to keep running.

Do not work around this by trying to bind a non-loopback address. The startup
guard rejects it, and the guard is the reason the deployment is safe.

## Troubleshooting

| Symptom                                         | Cause                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Startup dies with "Refusing to bind the server" | A non-loopback host was configured. Bind loopback and proxy instead.               |
| UI loads, nothing updates, no agent output      | `/ws` is not reaching the server. Check upgrade headers and the proxy path rules.  |
| A provider is missing from the picker           | Its CLI is not on the server's `PATH` for the service user.                        |
| `node-pty` fails to install                     | No matching prebuild; install `python3`, `make` and a C++ compiler.                |
| Terminals fail to open but the rest works       | `node-pty` built against a different Node version. Reinstall after a Node upgrade. |
