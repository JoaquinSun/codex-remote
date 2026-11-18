# Codex Remote

Pick up the Codex session running on your desktop from your phone: read the history, send instructions, approve commands, inspect diffs and output.

**English** | [简体中文](README.zh-CN.md)

> Both language versions are maintained by hand — please update both when you change a feature.

This is [JoaquinSun's fork](https://github.com/JoaquinSun/codex-remote) of
[KotChiu/codex-remote](https://github.com/KotChiu/codex-remote). The original bridge and its Git history are
preserved. This fork adds a native macOS companion, per-session model selection, folded execution history,
Codex / CC Switch usage at a glance, and an updated browser UI. It is a community project, unaffiliated with OpenAI.

## Download the macOS app

Get **Codex Remote Server** from [Releases](https://github.com/JoaquinSun/codex-remote/releases/latest).

- Requires **macOS 14 or later on Apple Silicon** (M-series), the ChatGPT desktop app installed and signed in with Codex available,
  and Node.js 18 or later (or the Node runtime included with Codex).
- Extract the ZIP, move `Codex Remote Server.app` to Applications, and launch it. The bridge code is included;
  Node.js is detected on the Mac rather than bundled into the download.
- Start or stop the bridge in the main window, then copy an access URL into your phone's browser. The phone
  and Mac need to be on the same LAN or Tailscale network.
- The gear button expands settings **inside the main window**; `⌘,` and the menu-bar Settings item open the same
  section. No QR-code setup is required.
- If a bridge is already running under launchd, the app attaches to it and displays it as externally managed.
  Update or stop that service through its existing deployment before switching to the app-managed bridge.
- The downloadable app uses an ad-hoc signature and is **not Apple-notarized**. macOS may require you to review
  it in System Settings → Privacy & Security before its first launch.
- `SHA256SUMS.txt` is provided alongside the ZIP so you can verify the downloaded archive with `shasum -a 256`.

The app and source releases exclude local tokens, logs, conversation captures, screenshots of real sessions,
and developer build caches. Example data uses documentation-only addresses and a nonfunctional token.

Build it locally with `bash scripts/build-macos.sh`; outputs go into `macos/build/`.

## How it works

For persistent conversations, **sending, steering, interruption, and approvals run inside Codex in the ChatGPT desktop app**.
The bridge discovers the owning desktop window through `~/.codex/ipc/ipc.sock` and uses its follower protocol.
The desktop keeps the writer lock. When a conversation has no desktop owner, the bridge opens it in ChatGPT through a system link.
An already open chat is used immediately; other chats use a short ownership probe before opening,
so delivery does not wait for the desktop router's full missing-owner timeout. Concurrent requests for the same chat share this readiness check.

```
phone browser ──HTTP/SSE──▶ bridge ──desktop IPC──▶ Codex in ChatGPT
                             └──app-server data API──▶ projects, history, models, quota, new-chat metadata
```

- When ChatGPT is connected and the default data socket is missing or refuses connections, the bridge uses ChatGPT's bundled Codex to run `app-server daemon start`. This restores the shared local data service; persistent chat execution stays in the desktop app.
- The default data socket is `$CODEX_HOME/app-server-control/app-server-control.sock`, with `CODEX_HOME` defaulting to `~/.codex`. An explicit `--socket` disables automatic daemon startup; `--no-auto-start-daemon` also disables it.
  Its server can be a different process from ChatGPT's embedded backend. Persistent new conversations use paginated metadata,
  save their name (defaulting to “新对话” when left blank), then unsubscribe before the desktop runs the first turn.
  Saving the name indexes an empty chat without starting a model turn, so it survives this handoff and server restarts;
  their history stays empty until the first user message. A failed or unconfirmed handoff remains tracked, and uncertain sends are never resubmitted.
- Desktop IPC is an internal protocol verified with ChatGPT 26.1111.21308 (state protocol 13), while retaining state protocol 11 support. Unverified protocol versions fail explicitly.
  Temporary conversations have no persisted record for the desktop to resume and continue using the data service's in-memory sessions.
- The bridge has zero dependencies (Node built-in modules only); the WebSocket-over-Unix-socket client is hand-written.

## Installation

Prerequisites:

- macOS with the **ChatGPT desktop app** installed and signed in, Codex available, and an existing conversation data service.
- Node.js: `node` from `PATH` is preferred; otherwise the runtime bundled with Codex is used, or point
  `CODEX_REMOTE_NODE=/path/to/node` at one. **Zero dependencies, no `npm install`.**

### 1. Get the code

```bash
git clone https://github.com/JoaquinSun/codex-remote.git ~/codex-remote
cd ~/codex-remote
```

If git is unusable (for example broken Xcode command line tools, `/usr/bin/git` failing with `xcrun`), download the zip instead:

```bash
mkdir -p ~/codex-remote && cd ~/codex-remote
curl -L -o main.zip https://github.com/JoaquinSun/codex-remote/archive/refs/heads/main.zip
unzip -q main.zip && mv codex-remote-main/* .
```

### 2. Run in the foreground (optional sanity check)

```bash
./bin/codex-remote --port 8787
```

It prints an address your phone can open directly (with a one-time token):

```
http://192.168.x.x:8787/?token=<TOKEN>
```

### 3. Install as a background service (recommended)

```bash
bash scripts/install-launchd.sh
```

What it does: deploys `bin src public` to `~/.codex-remote/app` → writes
`~/Library/LaunchAgents/com.codex.remote.plist` → restarts the LaunchAgent (**about 10 seconds of downtime**).
After that it starts at login and is restarted if it crashes. Uninstall with `bash scripts/uninstall-launchd.sh`.

This is a per-user LaunchAgent (`gui/<uid>`), so **the user has to stay logged in**; logging out stops the service.

### 4. Open it on your phone

1. Phone and Mac on the same LAN.
2. Open `http://<Mac LAN IP>:8787/?token=<TOKEN>`. The token is only needed once — it sets a cookie.
   The address is printed at the top of `~/.codex-remote/bridge.log`; the token also lives in
   `~/.codex-remote/token` (mode 600).
3. Open `http://<Mac IP>:8787/` again without the token; on iOS you can "Add to Home Screen" as a permanent entry point.

The macOS firewall asks once whether `codex-remote` may accept incoming connections — choose Allow.

## Running

```bash
./bin/codex-remote --port 8787
```

It prints an address your phone can open directly (with a one-time token):

```
http://192.168.x.x:8787/?token=<TOKEN>
```

The first visit sets a cookie and redirects; afterwards `http://192.168.x.x:8787/` works as-is.
The token is stored in `~/.codex-remote/token` (mode 600).

## The phone UI

1. Phone and Mac on the same LAN.
2. Open the tokenized address in a browser.
3. On iOS you can "Add to Home Screen"; it opens full screen like an app.

The UI uses a Codex-inspired light/dark palette, SVG controls, and a searchable session sidebar (`⌘K` / `Ctrl+K`).
On wide screens the session sidebar is always visible; on phones (≤767px) it collapses into a drawer —
tap ☰ at the top left to slide it out, and it closes once you pick a session.

What you can do:

- **Session list** in the sidebar: name, preview, running state (running / waiting for approval), relative time;
  the current session is highlighted.
- **Session view**: your messages, agent replies, progress updates, reasoning text, and plans stay visible in the
  main conversation, in their original order. Consecutive commands, tool calls, and file changes are grouped into
  a collapsed **Execution history** summary showing the current activity, execution / file / tool counts, and
  any failed steps. Running tools also stay collapsed until you expand them to inspect commands, exit codes,
  output, and diffs. Details are rendered on demand, and expanded sections stay open during live updates.
  All agent text stays visible even when an older provider omits the message `phase`.
- **Drag images into the web client**: open a chat and drop one or more image files anywhere on the page.
  The composer shows a drop hint, then attachment previews with removal buttons. A message accepts up to six
  images across consecutive drops and file-picker selections. Switching chats cancels images still being read.
- **Per-session model switching**: the model button above the composer opens a model and reasoning-effort picker.
  Choices come from the connected Codex daemon's `model/list` catalog. The bridge validates supported efforts and
  saves each session's choice in `~/.codex-remote/models.json`; refreshes and other browsers on the same bridge keep it.
  It applies to the next turn started by the bridge. Queued input uses the desktop session's existing settings;
  the saved selection is kept for the next bridge-started turn. Steering keeps the active turn's model.
  **Follow desktop** removes the bridge's override, and the panel separately shows the
  model currently in effect. New chats can pick a model before creation; ephemeral chat choices stay in memory.
  The catalog describes selectable models; the provider still determines inference access when a turn runs.
- **Working projects**: the sidebar's **Working now** section shows project names, active chat counts, and pending
  approvals. Click a project to open one of its working chats. Started, completed, and interrupted turns update the
  section automatically. Collapsed project groups keep an active count. Project groups and working-project
  shortcuts retain the project catalog's order as chats update; both sidebar lists preserve their scroll position.
  Chats match an explicit project ID or the most specific project root; unregistered workspaces use their folder name.
  Older active chats are added from list pagination so the overview is not limited to the latest 40 chats.
- **Codex and CC Switch usage overview**: tap the gauge in the browser title bar to see every Usage limit window
  returned by Codex (used / remaining percentage, reset time, plan, and any available reset credits). The bridge reads
  the official app-server `account/rateLimits/read` method, refreshes after `account/rateLimits/updated`, and otherwise
  keeps a 30-second cache; the open panel refreshes every 30 seconds. The same panel shows **CC Switch · Today**:
  real tokens, request count, recorded estimated
  cost, and an app breakdown. This is calculated read-only from `~/.cc-switch/cc-switch.db` with the system `sqlite3`,
  using CC Switch's current fresh-input normalization and session/proxy deduplication rules. The native macOS dashboard
  has compact cards for both summaries. Only aggregate figures cross the authenticated bridge: API keys, provider or
  account details, database paths, and request/response bodies are never returned. An older Codex app-server, a missing
  CC Switch database, or a missing `sqlite3` simply produces an unavailable state instead of breaking the page.
- Keep going with the composer at the bottom; press **Interrupt** while a turn is running.
- **Unread dot**: when a session finishes a turn while you are not looking at it (or the page is in the background),
  a small blue dot appears in front of its name in the list; opening that session clears it. The state lives in the
  browser's `localStorage` (`codex.unread`), so it survives a refresh.
- **Running timer**: like the desktop app, the timer lives in the conversation, not next to the composer — beneath the
  running turn you see `● Running 1:23` (pulsing dot + ticking clock). The baseline is the server's `turn.startedAt`
  (falling back to the moment the bridge first saw the turn start); formats are `0:12` / `1:23` / `1:02:03`.
  It ticks once a second, updates only that text node, and stops while the page is in the background.
- **Connect to a desktop turn**: desktop IPC supplies the conversation's state and approval requests.
  Interrupt and Steer run in the owning ChatGPT window; the bridge does not take over the turn in an independent backend.
  The phone still re-reads the latest turn every 2 seconds for output and tool updates.
- **Sending during a running turn attaches the message instead of interrupting** (matches the desktop app): pressing
  Send while a turn is running does not interrupt it — the message floats above the composer (`Pending` + text +
  `Steer` / `✕`) and is sent as a new turn when the current one finishes. Switching sessions, or even closing and
  reopening the page (the pending list is kept in `localStorage`), keeps it waiting. To inject it into the running turn
  immediately, press **Steer** on that row — ChatGPT handles it in the current turn.
  Attaching and steering **show no floating toasts** (the row above the composer, and the message inserted back into the
  conversation, are the acknowledgement); only when the daemon really queues input does the message get
  a line underneath: "Queued · waiting for the desktop to receive it". There are only ever two buttons next to the
  composer: Send, and Interrupt while running. The daemon does not always emit `turn/completed` for an interrupted
  turn, so the bridge and the page reconcile against the server's turn state on every read — a phantom "running"
  state cannot block pending messages.
- **Delivering to desktop conversations**: messages and images use the owning window's follower API. Explicit model
  and permission settings are confirmed by ChatGPT before a new turn starts; steering keeps the current turn's settings.
  An unconfirmed response asks you to refresh before retrying and is never submitted through a second path.
  Unsupported data-queue methods report an update requirement without executing a command-line tool.
- **Approval cards**: when Codex asks to run a command or edit files, the phone shows Allow / Allow for this session /
  Deny / Deny and interrupt.
- **New chat / rename / pin**: ＋ in the title bar creates a chat (default location `~/Documents/Codex/chat`; new chats are
  not pinned unless you tick "pin"); ✎ renames; ☆/★ pins. Pinned sessions sit at the top with a ★, handy for a "fixed window"
  (a daily-notes chat, say). Pins and new chats are stored in the browser's `localStorage` (`codex.pinned` /
  `codex.shelved`) and only apply to that browser. The `codex.shelved` list (sessions created but not yet indexed by
  the daemon) is verified periodically: 10 minutes after creation it does a lightweight `?limit=1` read, and only
  **twice in a row** returning "thread not loaded" removes it from the list (a failed manual open counts once). The
  reason for being this conservative: `thread/list` does not include sessions that were just created and never used,
  so a wrong removal loses them for good.
- **Project groups / ephemeral chats** (mirrors the desktop sidebar):
  - The `Projects` group comes from Codex's own project records (`project/list`). A session belongs to a project when
    **its working directory is inside the project root** (a thread's `projectId` in the daemon is usually empty;
    `cwd` is the real link). So "only one session in the project" usually just means that project has one session so
    far — the rest live in the auto-generated `~/Documents/Codex/chat`, `~/Documents/Codex/<date>/…` and land in
    `Other chats`. Put a session in a project by setting its working folder to the project directory when creating it.
  - Group headers are clickable; collapsed state is stored in `localStorage` (`codex.collapsedGroups`).
  - **New chat inside a project**: the `＋` next to the project name — the dialog already has the project root filled
    into "working folder", so the new session lands under that project (instead of `Other chats`). The row is shown
    even when the project has no sessions (with "no chats yet, tap ＋ above"), otherwise the first session would have
    no entry point.
  - The **New chat** dialog also has a project dropdown: picking a project fills its root into the working folder;
    editing the path by hand resets the dropdown to "not selected (enter a path)", so you can never end up with
    "picked project A but created in directory B".
  - The ＋ next to `Projects` creates a project (name + absolute path, `~` allowed) via `project/create`.
  - `✦ Ephemeral chat` in the sidebar uses the daemon's **ephemeral sessions**: nothing is written to disk or
    history, the title bar gains an `End` button, closing it removes it from the list, and it is gone after a bridge
    restart.
  - Because ephemeral sessions are not persisted, the daemon's `thread/read` cannot read them back
    (`thread/turns/list` does not support them either), so the bridge caches their events in order (up to 4000) and
    replays them when the page reopens — a refresh still shows the whole conversation, including your own messages
    (the daemon's `turn/completed` only carries a summary, so the replay trusts `item/*` events).
  - Ephemeral sessions cannot use the persistent input queue; sending while one is running tells you
    to wait.
- **Per-session permission profile**: the small dot at the top left of the composer opens four choices; you can also
  pick one when creating a chat. The profile follows the session (stored in `~/.codex-remote/permissions.json` on the
  bridge), so opening the same session on the desktop shows the same permissions — loosening it on the phone will not
  silently downgrade it back on the desktop.

  | Profile | Meaning | Codex equivalent |
  | --- | --- | --- |
  | Follow desktop | Sends no override; uses whatever the session is set to on the desktop | default |
  | Decide for itself | Runs freely inside the workspace, asks with a card when crossing the boundary / needing network | `workspaceWrite` + `on-request` |
  | Decide for me | Out-of-bounds requests go to Codex's review sub-agent, no interruption | `approvalsReviewer: auto_review` |
  | Full access | No prompts, no sandbox, every command runs | `dangerFullAccess` + `never` |

  It applies to the next turn: persistent conversations first confirm their model and permission settings in ChatGPT,
  then start in the owning desktop window. Steering keeps the active turn's settings.
  Temporary conversations apply the profile through the data service's `turn/start` API.
  The top right of the panel shows the setting **actually in effect on the computer** from the desktop subscription
  or the data service; `—` right after a change, before sending anything, is normal.
- **Light / dark theme**: follows the phone's system by default; the `🌓` button at the top of the sidebar cycles
  `Follow system → ☀️ Light → 🌙 Dark`, stored in `localStorage` under `codex.theme`. (It lives in the sidebar because
  the title bar is reserved for the session title and status.) Both palettes are in `public/style.css`
  (`--bg` / `--text` / `--accent-soft` and friends), selected by `<html data-theme="light|dark">`; an inline script in
  `index.html` sets the attribute before the stylesheet loads, so there is no flash. Switching the theme also updates
  `meta[name=theme-color]` (address bar / status bar) and iOS's `apple-mobile-web-app-status-bar-style` (status bar
  text colour when added to the home screen).
- **One-tap copy**: code blocks and command output have a copy button in the top right; links (including bare URLs —
  previously plain text, now linkified automatically) and **long inline code** (≥20 chars: tokens, paths, commands;
  short identifiers get no button, to avoid a wall of icons) get one too. Tap it and the value lands on the clipboard,
  the button turns into a check mark, and a "Copied: …" toast appears. The icon is a 12×12 inline SVG (inherits the
  text colour), not an emoji — emoji use the system font and turn into a giant blob on phones.
  Links **open on a single tap**: the anchor is already `target="_blank"`, but in-app browsers on phones (and some
  shells that block `target=_blank`) often swallow it, so the page takes the click over — only `http/https`, opened
  explicitly in a new tab; if that is blocked too, it leaves the default behaviour alone and hands it back to the
  browser. Copying goes through `copyValueFor()`: code uses the whole `<pre>`/`<code>` text, links use the real `href`
  (not the truncated text on screen). The phone talks to `http://192.168.x.x`, which is not a secure context, so
  `navigator.clipboard` does not exist there; the fallback is an off-screen `readonly` textarea plus
  `execCommand('copy')` (`readonly` stops iOS from popping the keyboard, off-screen stops the page from scrolling).
- **Long sessions don't choke the phone**: a single `thread/read` has been measured at 11MB — 4.7MB of that MCP tool
  results (65KB in one item), 2963 items in a 31-minute session. Parsing that takes hundreds of milliseconds on a
  phone, and the 6-second background poll pays it over and over — which feels like "typing in the composer is laggy
  while Codex is replying". The bridge now does two things:
  - **Windowed reads instead of whole-thread reads**: the first screen loads the last 20 turns / 300 items
    (`GET /api/threads/:id?limit=&turns=`) through `thread/turns/list` rather than `thread/read includeTurns` —
    an 84MB session went from 4–9s to about 0.14s. Scrolling to the top auto-loads earlier turns (plus a
    "⇡ show earlier messages" button), anchored by distance-from-bottom so the view does not jump.
    When idle the phone only polls the lightweight `?live=1` metadata endpoint and refetches when a new turn appears.
  - **Middle-truncation of very long text** (tool results 6KB, command output 8KB, reasoning 8KB, diffs 20KB, other
    strings 40KB), keeping the head and tail and noting how many characters were omitted.
  Measured on that session: payload 11.5MB → 1.24MB (gzip 341KB), front-end DOM 10.3MB → 1.1MB, items 2963 → 499.
- **Streaming does not re-render everything**: previously every chunk of agent text re-rendered its Markdown and every
  chunk of reasoning rebuilt the whole chat stream (`renderThread` in `public/app.js`). Now dirty items are recorded
  and only the matching element is refreshed, at most every 120ms (`scheduleDeltaFlush` / `flushItemDelta`); a full
  re-render only happens on real structural changes such as `item/started` and `item/completed`.
- **The desktop nudges you to refresh**: this page can stay open on a phone for days while the bridge on the computer
  gets redeployed. The latency probe every 2–5 seconds carries the bridge version (`/api/ping`'s `version`); when it differs
  from the version the page loaded with, you get "The computer is now running vX — tap to refresh" (that toast does
  not auto-dismiss; tap it to reload), so you do not have to guess why a new feature is missing.
- **Page name**: the top of the sidebar shows this machine (hostname by default); tap it to rename — handy with
  several computers.
- **Latency button**: the dot at the top left of the composer, right next to "Follow desktop", is the current
  phone ↔ computer round trip. Green <80ms / yellow <250ms / red (or "no Codex") means the link or Codex has a
  problem. Tap it for details: `phone ↔ computer`, `computer ↔ Codex` (via `/api/ping`, using the side-effect-free
  `thread/loaded/list` three times and taking the minimum), **ingress path**, live-push state, check time, bridge
  version. It measures on page load, every 2 seconds while the panel is open (every 5 seconds when it is closed), and
  when returning from the background; nothing is sent while the page is hidden. A probe that takes longer than
  3 seconds is treated as offline, so the chip never sits on a stale number. While Codex is busy the probe waits at
  most 350ms; if it cannot get a fresh sample it reuses the last successful value and marks it “(last)”, so Codex
  queueing is never reported as link latency. The ingress path is derived server-side from the client's source address (local / LAN /
  Tailscale / remote). On a Tailscale path the bridge reads the peer's `CurAddr` from `tailscale status --json`
  (the GUI CLI is auto-detected, or set `TAILSCALE_CLI`) and shows **Tailscale direct**,
  **Tailscale Peer Relay**, or **⚠ Tailscale relay · XXX**. A DERP path means hole punching failed (measured
  `relay "tok"`: 105ms round trip),
  so the panel suggests checking UDP 41641 / UPnP and, for hard NATs, configuring a Peer Relay on a low-latency VPS
  with Tailscale 1.86+. It also offers a tokenized LAN URL; tap it while the phone and computer share a Wi-Fi network
  and latency drops to single-digit milliseconds.
  When disconnected, colour is not the only signal (colour-blind users, bright sunlight): the dot becomes a red **⚠**
  and the affected rows read `⚠ unreachable` / `⚠ disconnected` / `⚠ interrupted, reconnecting`.

- **Three things at the transport layer**: `keepAliveTimeout` is raised to 65 seconds (Node closes idle connections
  after 5s by default while the probe runs every 15s, i.e. a fresh TCP connection — and a wasted RTT — every time);
  JSON responses over 1KB are gzipped (a full session read: 1.6MB → 424KB); the addresses printed at startup list the
  LAN one first.
- **Lands on the newest message after opening / refreshing**: images load asynchronously and keep the view pinned to
  the bottom, so there is no manual scrolling; scrolling up to read history is not yanked back. The browser's own
  scroll restoration is disabled (`history.scrollRestoration = 'manual'`), and returning from the background (bfcache
  restore) re-anchors to the last message, so a refresh never leaves you halfway up.
- Page height uses `100dvh`, so the composer and the newest message are not hidden while iOS Safari collapses or
  expands its toolbars.
- The composer font size is fixed at 16px, so focusing it on iOS no longer zooms the page.
- Everything is pushed live over SSE; output appears as it is produced.

## Background service

```bash
./scripts/install-launchd.sh     # install the LaunchAgent: start at login, restart on crash
./scripts/uninstall-launchd.sh   # uninstall
```

Logs: `~/.codex-remote/bridge.log`

## Requirements

- ChatGPT is open, and both its desktop IPC and the configured app-server data socket are reachable.
  The bridge restores the default local data service when needed and waits for it before loading history, projects, or the model catalog. An explicit `--socket` connects to the operator's existing data service.
- Node.js: `node` from `PATH` first, otherwise the runtime bundled with Codex.
  You can also set `CODEX_REMOTE_NODE=/path/to/node`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--port` | `8787` | Port to listen on |
| `--host` | `0.0.0.0` | Bind address; use `127.0.0.1` for local-only |
| `--socket` | `~/.codex/app-server-control/app-server-control.sock` | app-server control socket |
| `--no-auto-start-daemon` | off | Disable recovery of the default shared data service |
| `--token-file` | `~/.codex-remote/token` | Token file; delete it to regenerate |
| `--name` | hostname | Name shown in the page/tab, to tell computers apart |
| `--name-file` | `~/.codex-remote/name` | Persisted name; `CODEX_REMOTE_NAME` also works |
| `--model-file` | `~/.codex-remote/models.json` | Persisted per-session model and reasoning-effort choices |

## Security

- Every endpoint requires the token (cookie / `Authorization: Bearer` / one-time `?token=`).
- It is **plain HTTP**: anyone on the same LAN can sniff the traffic. Use it only on a network you trust.
- Do **not** expose the port to the internet. For remote access, put it behind a TLS reverse proxy (Caddy/nginx) or a
  VPN/Tailscale, and set `--host` to `127.0.0.1` so only the proxy can reach it.
- app-server is powerful: it can run commands and edit files. The token is equivalent to those permissions — do not
  share it.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| The page says "disconnected" | Open ChatGPT; the default data service is restored automatically. For an explicit `--socket`, check that custom service. `CODEX_REMOTE_CODEX` can select the Codex executable used for recovery. |
| ChatGPT is unavailable or its protocol is incompatible | Open Codex in the desktop app; an app update may require an updated desktop IPC adapter |
| The phone cannot connect | Different subnet, macOS firewall, or `--host` set to `127.0.0.1` |
| 401 unauthorized | Reopen the full address that includes `?token=` |
| Rotate the token | Delete `~/.codex-remote/token` and restart the service |
| Sending says "queued" | The desktop still owns session delivery; the message is waiting for it to receive the input |
| A message lands below the answer / the answer appears above the message | The bridge used to append the echo of a message the daemon had not recorded yet to the end of the stream, so it looked like the answer came first. Echoes are now inserted back into their own turn: when you steer into a running turn (the daemon only records it on the next model turn, measured at tens of seconds), the message stays where you sent it and later output follows below. |
| Tapping a link in a reply does nothing | The page handles link clicks itself (opens a new tab); if an embedded browser blocks new tabs too, long-press the link and copy the address into a browser |
| "no rollout found" | The session id does not exist (usually a stale list); refresh the list |
| Tailscale says relay | Run `tailscale netcheck` and check `UDP`, `MappingVariesByDestIP`, and `PortMapping`; run `tailscale ping <peer-ip>` and look for `via <ip>:port` (direct) vs `via DERP(...)`. Allow UDP 41641 on both ends and enable UPnP/NAT-PMP; when a hard NAT prevents hole punching, use Tailscale 1.86+ and configure a low-latency VPS as a Peer Relay |

### Tailscale speed-up

- Check the result first: `tailscale ping <peer Tailscale IP>`. `via <ip>:port` is direct; `via DERP(tok)` is relayed.
- In `tailscale netcheck`, look for `UDP: true`, `MappingVariesByDestIP: false`, and a non-empty `PortMapping`. Allow UDP 41641 on both ends; enable UPnP/NAT-PMP on the router or give one end a static port mapping.
- If both sides are behind hard NATs, upgrade both to Tailscale 1.86+, run `tailscale set --relay-server-port=40000` on a low-latency VPS, and grant it `tailscale.com/cap/relay` in the tailnet policy. DERP still handles negotiation, but relayed traffic prefers the Peer Relay.
- When the phone and computer share a Wi-Fi network, always use the LAN address; even a direct Tailscale path cannot beat it.
| Latency stays above 200ms | The phone is probably on a Tailscale relay, not the LAN: open the latency panel, check "ingress path", and use the LAN link it offers |
| A permission profile is set on the phone but approvals still appear | A bridge-started turn applies the selected profile. Queued input inherits the desktop session's settings; the phone keeps the selected profile for the next bridge-started turn |

## Files

```
bin/codex-remote            launcher script
src/ws-unix.js              WebSocket-over-Unix-socket client (zero dependencies)
src/appserver.js            app-server JSON-RPC 2.0 client
src/desktop.js              ChatGPT desktop IPC, conversation control, state and approval subscriptions
src/permissions.js          per-session permission profiles, persisted to disk
src/models.js               model catalog validation, per-session choices, RPC parameters
src/server.js               HTTP + SSE bridge, auth, approval forwarding
public/chat-view.js          conversation / execution grouping and activity summaries
public/                     phone UI
launchd/                    background service template
scripts/probe.js            connectivity probe, lists sessions directly
scripts/probe-desktop.js    read-only desktop IPC, ownership, and approval-subscription probe
scripts/install-launchd.sh  install the background service
```

## Verifying

Run the regression checks without installing dependencies:

```bash
node --test
```

They cover model selection and persistence, next-turn RPC parameters, queue delivery, steering, ephemeral chats,
and conversation grouping for current and older message formats.

Run the macOS client's restart, listener, and access URL regression tests with:

```bash
swift test --package-path macos
```

These use simulated processes, HTTP responses, and isolated settings without starting or stopping the user's
bridge or modifying existing sessions.

```bash
# talk to the daemon directly and list sessions
./bin/codex-remote --port 8787 &     # or already started by launchd
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" \
  http://127.0.0.1:8787/api/threads?limit=5

# measure both hops (this is what the phone button uses; daemon.ms is computer ↔ Codex)
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" \
  http://127.0.0.1:8787/api/ping

# read / change a session's permission profile (default / ask / auto / full)
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" \
  http://127.0.0.1:8787/api/permissions
curl -s -H "Authorization: Bearer $(cat ~/.codex-remote/token)" -H 'content-type: application/json' \
  -d '{"mode":"ask"}' http://127.0.0.1:8787/api/threads/<thread-id>/permissions
```

## Multiple computers

Run one bridge per machine and tell them apart by page name (hostname by default):

- Tap the name at the top of the sidebar to rename it; stored in `~/.codex-remote/name`
- Or `bin/codex-remote --name "My Mac"`, or the `CODEX_REMOTE_NAME` environment variable
- `GET /api/meta` returns `{name, hostname, listenHost, version, startedAt}` — the machine name and actual listener

### Updating and redeploying

Whichever way you got the code, the last step is always `install-launchd.sh`: it copies `bin src public` over
`~/.codex-remote/app`, rewrites the plist and restarts the LaunchAgent (about 10 seconds of downtime).

```bash
git clone https://github.com/JoaquinSun/codex-remote.git ~/codex-remote   # first time
cd ~/codex-remote && git pull && bash scripts/install-launchd.sh      # afterwards
```

On a machine where git is unusable (`/usr/bin/git`'s CommandLineTools are broken), download the zip and deploy that:

```bash
mkdir -p ~/codex-remote && cd ~/codex-remote
curl -L -o main.zip https://github.com/JoaquinSun/codex-remote/archive/refs/heads/main.zip
unzip -q -o main.zip && bash codex-remote-main/scripts/install-launchd.sh
```

To fix git properly (`git pull` works again): run `xcode-select --install`; once it finishes `git --version` should
print a version.

When you edit the code yourself, just run `bash scripts/install-launchd.sh` in the source directory.

### Post-deploy checks

```bash
launchctl print gui/$(id -u)/com.codex.remote | grep -E 'state|pid'   # should be running
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/      # 401 = good (token required)
grep -c newChatCwd ~/.codex-remote/app/public/app.js                # is the deployed copy current?
tail -20 ~/.codex-remote/bridge.log                                  # check bridge.err.log on errors
```

Refresh the page once on the phone to get the new version (`public/` is served with `Cache-Control: no-store`).

After changing the front end, bump `BRIDGE_VERSION` in `src/server.js` if you want phones that already have the page
open to be told to refresh (the page compares it with the `version` returned by `/api/ping`). Not bumping also works —
you just have to pull-to-refresh manually.

### Do not leave test sessions behind

You will inevitably send a few real messages while working on this; do not leave those sessions in the list:

- **Prefer ephemeral chats** (nothing written to disk, not in history, gone when the bridge restarts):

  ```bash
  TOKEN=$(cat ~/.codex-remote/token)
  # create: take thread.id from the response
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"ephemeral":true,"cwd":"'"$PWD"'"}' http://127.0.0.1:8787/api/new-thread
  # close when done
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"threadId":"<id>"}' http://127.0.0.1:8787/api/ephemeral/close
  ```
- Some paths can only be tested with a real session (ephemeral ones cannot be read back) — then **delete it right
  away**: `node scripts/delete-thread.js <threadId>` (goes through the daemon's `thread/delete`; the rollout file goes
  with it).
- A session created but never used is invisible in the list, yet leaves a rollout stub in `~/.codex/sessions`
  containing a single `session_meta` line; clean those up with `node scripts/delete-thread.js --stubs`.

## Repository

Code lives on GitHub: <https://github.com/JoaquinSun/codex-remote>

```bash
git clone https://github.com/JoaquinSun/codex-remote.git
git remote add origin https://github.com/JoaquinSun/codex-remote.git   # in an existing checkout
```

For an app release: run `node --test` and `swift test --package-path macos`, build with
`bash scripts/build-macos.sh`, commit the source, tag that commit, and attach the ZIP plus `SHA256SUMS.txt`
to a GitHub Release. Local build output, credentials, and captured sessions are excluded from Git.

For a launchd deployment, use `bash scripts/install-launchd.sh` and refresh the phone page.

Before you publish changes, make sure git works on macOS: `git --version` failing with `xcrun: ... missing xcrun`
means the Xcode command line tools are missing (`/usr/bin/git` is just a shim) — run `xcode-select --install` once.
If you would rather not install Xcode, the git bundled with the Codex runtime works too:

```bash
~/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git --version
```
