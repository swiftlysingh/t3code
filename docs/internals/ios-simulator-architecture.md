# iOS Simulator architecture

> For maintainers. This document describes the first-class iOS Simulator capability in T3 Code,
> its host boundaries, and the contracts between the server, clients, XcodeBuildMCP, and
> `serve-sim`.

## Product boundary

The Simulator is a machine-local execution resource owned by the T3 server environment. A manual
frontend **Start** action reserves an actual CoreSimulator device and supervises a
`serve-sim` process that provides the live view. An agent build follows a separate path: it passes
the exact UDID to `ios_build_run`, and T3 builds and validates the `.app` before leasing the device.
The tool then waits for the lease, installs and launches the app, and returns the ready session for
lease-scoped XcodeBuildMCP actions. The web and desktop clients display the same device and send
typed, authenticated input through T3. The embedded view is the default: acquiring a lease does
not open or focus the shared native
Simulator.app. A user can explicitly open that exact device in Simulator.app from the panel when
they need the native UI.

The client discovers a thread's active lease independently of whether the Simulator viewer is
mounted. A thread-scoped discovery bridge reconciles session events and status, ensures the
Simulator surface exists when a live lease is found, and keeps the surface tied to that exact lease
generation. If another right-panel surface is active, discovery adds a Simulator tab without
changing the active surface; the user can choose **Watch** to view it. If no other surface is
active, the embedded viewer may be opened automatically as soon as the lease is discovered. This is
viewer discovery only: it does not create a second lease, stream, or XcodeBuildMCP client.

The operating system of the machine running the T3 server determines whether the capability is
available. A browser or desktop client does not need to run on macOS: a client on Linux or Windows
can connect to a T3 server on a supported Mac and use that Mac's Simulator. Linux and Windows
cannot run the iOS Simulator locally through T3.

The first release intentionally has conservative host capacity:

- one active Simulator lease by default;
- one live stream by default.

An unsupported host reports `maxActive: 0`; capacity and media expiry values are non-negative
integers on the wire.

The scheduler and locks are host-wide, so another T3 environment or worktree cannot mutate the
same device behind the first environment's back. A request that arrives while capacity is full is
queued or reported as busy; it is never silently moved to another device.

## Runtime topology

```text
 Web / Desktop client
         |
         | authenticated T3 WebSocket RPC
         | signed, short-lived MJPEG URL
         v
 T3 server environment
   SimulatorManager
   - capability and simctl inventory
   - lease and bounded queue
   - host-wide UDID lock and generation fencing
   - authenticated media/input gateway
         |
         +---------------------- loopback only ----------------------+
         |                                                            |
         v                                                            v
 XcodeBuildMCP build validation + lease child              serve-sim child (one per lease)
   build, install / launch                                  MJPEG / config / health
   AX snapshot and semantic UI tools                        native input transport
         |                                                            |
         +---------------------------+--------------------------------+
                                     v
                              CoreSimulator device
                              (exact Simulator UDID)
```

The exact Simulator UDID is the identity shared by every layer. A project and thread resolve to a
worktree. A returned lease binds that thread and worktree to one UDID, one lease-scoped
XcodeBuildMCP child, one `serve-sim` child, and one generation. No component is allowed to infer a
device from a name after the lease has been granted.

| Component          | Responsibility                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| T3 server          | Detect support, enumerate devices, allocate leases, queue requests, authenticate clients, supervise children, and release resources. |
| `simctl` inventory | Report exact UDIDs, names, runtimes, and current boot state. It does not create or download devices.                                 |
| XcodeBuildMCP      | Build, install, launch, inspect, take screenshots, and perform curated semantic UI automation for the exact UDID.                    |
| `serve-sim@0.1.45` | Stream the device and carry low-level native input for one supervised device.                                                        |
| Web client         | Render the session, stream, queue, errors, and typed user controls.                                                                  |
| Desktop client     | Use the same web surface and server contracts inside the desktop shell.                                                              |

Mobile clients are not a surfaced Simulator UI in this release. The contracts are kept remote-ready
so a later mobile route can reuse the server capability without changing host ownership.

## Supported host and client matrix

| T3 server host                                                                | Client location                  | Result                                                                              |
| ----------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| Apple Silicon macOS with Xcode, an iOS runtime, and available Simulator tools | macOS web or desktop             | Full viewing, input, and agent workflow.                                            |
| Apple Silicon macOS with Xcode, an iOS runtime, and available Simulator tools | Linux or Windows browser/desktop | Full remote viewing and input over the authenticated T3 connection.                 |
| Linux or Windows                                                              | Local browser/desktop            | T3 remains usable, but Simulator capability reports unsupported.                    |
| Intel macOS or an incomplete Xcode setup                                      | Any client                       | Simulator capability reports unsupported with a remediation reason.                 |
| Any host without a compatible installed iOS runtime                           | Any client                       | Simulator capability reports unavailable; T3 does not download or create a runtime. |

`serve-sim` is an Apple-platform execution dependency. It is never started on a Linux client, and a
Linux client does not make a Linux T3 server into an iOS Simulator host.

## Device inventory and exact identity

The server probes the host before exposing an executable capability. On a supported Mac it uses
the installed Xcode/`simctl` tools to enumerate available iOS devices. Inventory entries include
the device name, runtime, state, and exact UDID. The inventory is advisory until the manager
verifies the device immediately before acquisition.

The allocation rules are:

1. The client chooses an inventory entry and sends its exact UDID.
2. A request waiting behind another lease in the same T3 environment remains tied to that UDID;
   it is not assigned a different device.
3. A device is not considered usable until the host lock is acquired and the device still exists
   with the expected runtime.
4. Cross-process lock contention is reported explicitly as a retryable locked failure; T3 does not
   wait invisibly inside an agent call or steal the other process's device.
5. T3 does not create, erase, clone, download, or delete Simulator devices as part of ordinary
   session management.

The UDID is passed explicitly to every `simctl` and XcodeBuildMCP operation. Device names are for
display only and are not stable identifiers.

## Lease, lock, and queue model

A lease is a live machine resource, not durable thread history. Its important fields are:

```ts
type SimulatorSession = {
  leaseId: string;
  generation: number;
  threadId: string;
  udid: string;
  state: "queued" | "starting" | "ready" | "failed";
  queuePosition?: number;
  media?: {
    streamUrl: string;
    width: number;
    height: number;
    orientation: string;
    /** Non-negative integer epoch milliseconds. */
    expiresAt: number;
  };
  failure?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  createdAt: string;
  updatedAt: string;
};
```

The server keeps the active lease and queue in its runtime manager. The host lock is an atomic
machine-local lock keyed by exact UDID and shared by T3 environments. Lock metadata records the
environment, thread, lease, generation, owner PID, and process start identity. This lets a new
server distinguish its own stale state from another live T3 process.

The lock is fail-closed:

- a lock is released only by its owner or after the owner process identity is positively shown to
  be gone;
- an unknown or unverifiable owner is never killed or reclaimed automatically;
- a PID number by itself is not an owner identity, because macOS may reuse it;
- late release, child-exit, or client messages are ignored unless their lease and generation still
  match the active owner.

The in-memory manager protects one T3 server's state; the host lock protects cross-process and
cross-worktree ownership. Both are required. A per-server mutex alone would allow two T3 servers
to boot, reset, or inject input into the same CoreSimulator device.

The default active lease capacity is one even when several installed devices are available. When
the capacity is full inside one T3 server, the second manual request receives a structured
`queued` state with a queue position. The scheduler wakes on a release event and does not poll in
a tight loop. The agent-facing `ios_build_run` call remains open while its post-build lease is
queued or starting so it can return one ready, installed session. A competing T3 server cannot see
the in-memory queue, so the host-wide capacity lock instead returns a visible, retryable
`simulator-locked` failure.

One thread has at most one active lease. Repeating an acquire/run request from that thread is
idempotent and returns the existing lease. Closing the panel is not a release: a user may close a
viewer while an agent is still building or inspecting the app. Release is explicit, runs when the
thread is deleted, or runs when the server's Simulator layer shuts down.

Closing the Simulator surface is a separate, viewer-only action. The client records that the user
dismissed the surface for the current lease generation, so later status refreshes, reconnects, or
duplicate session events do not reopen it. A new lease generation is eligible for automatic
discovery again. This suppression never changes lease ownership and never stops the agent's build
or automation.

## Session lifecycle

The observable states are deliberately explicit:

```text
unsupported     Host cannot execute iOS Simulator work
available       Host and at least one compatible device are known
queued          Request is waiting for capacity or an exact UDID
starting        Lease exists; the host locks, device, and stream sidecar are being prepared
ready           The exact device is locked and a real stream frame is available
failed          A recoverable setup or child operation failed
```

Manual frontend acquisition is an event-driven sequence:

1. Check host capability and verify the exact requested UDID against current inventory.
2. Create a generation-fenced starting lease, or return a queued lease when local capacity is full.
3. Acquire the host-wide capacity and exact-UDID locks.
4. Start the per-lease `serve-sim` child, which boots the exact device when needed, binds to
   loopback, and waits for health plus a real frame. Its private environment suppresses only
   `serve-sim`'s automatic `open -ga Simulator` invocation, so this step does not focus
   Simulator.app.
5. Publish a ready session and a short-lived media capability to the client.
6. The user can watch the ready device without building an app. A manual frontend session remains
   independent of the agent build path.

The agent build path starts before this sequence: `ios_build_run` resolves the authenticated
thread's worktree, builds and validates the `.app` for the exact UDID, and only then asks the
manager to lease the device. The returned session supplies the `leaseId` and `generation`; the
agent checks `ios_session_status` before lease-scoped automation and calls `ios_session_close` when
finished.

If any step fails, the manager reports the failing stage and preserves enough diagnostics to retry
or close. It does not silently switch worktrees or UDIDs after the app has started.

The client-side discovery bridge can observe the starting and ready events before the viewer is
mounted, then reconcile the authoritative status on reconnect. It adds the thread's Simulator
surface at most once for the lease generation. A currently active Diff, Files, Terminal, Agents,
or browser surface remains active; the Simulator tab carries an activity dot and the composer's
**Watch** control activates the viewer on demand.

Release first closes the lease-scoped XcodeBuildMCP session and its running app, then removes the
manager lease, stops only the exact `serve-sim` child captured for the lease, releases the verified
host locks, invalidates the media and input generation, removes the live viewer state, and signals
the local queue. Thread deletion follows the same owner-scoped cleanup order. Server shutdown
closes the managed children and locks. Unknown processes are left alone.

## XcodeBuildMCP integration

T3 uses XcodeBuildMCP as the agent's first-class build and semantic automation engine. It does not
ask an agent to manually configure an unrelated MCP server and does not expose every upstream
method as an unreviewed pass-through.

The agent-facing `ios_build_run` operation is the build-first exception to the lease-scoped
automation path: it carries the exact project/workspace, scheme, configuration, DerivedData
location, and Simulator UDID, then builds and validates the `.app` before asking the manager for a
lease. After a session is returned, the server starts at most one lazy `XcodeBuildMCP@2.6.2` child
per Simulator lease using the official MCP stdio client. That child is scoped to the authenticated
thread's worktree and serialized per lease for install, launch, and semantic UI work. The
`serve-sim` child starts on demand for a manual or returned ready lease. Both children are
configured for the embedded viewer rather than automatically opening Simulator.app. Neither
process needs to be managed separately by the user, and both are stopped during lease/server
cleanup. Session defaults are not shared between threads.

The curated T3 agent surface covers the operations needed for the common loop:

- discover capability and devices;
- build and validate the exact-UDID `.app`, then inspect status and close the returned session;
- install and launch the thread's app;
- take an accessibility snapshot and use semantic tap, text, gesture, and wait actions;
- capture a screenshot.

XcodeBuildMCP results are checked for tool errors, failed summaries, missing artifacts, and
Simulator-ID mismatches before T3 reports success. The child is closed when the lease ends. Its
stderr and lifecycle are captured for diagnostics without leaking arbitrary command output to a
client.

The T3 Simulator panel is therefore a complementary surface: it lets a developer see and
intervene in the same app while the agent uses semantic XcodeBuildMCP operations. `serve-sim`'s
accessibility endpoint is not a second T3 semantic contract.

## `serve-sim` supervision and network boundary

The repository pins `serve-sim@0.1.45`. T3 starts it only on a supported Mac, only on demand, and
only as a supervised child for a lease. The child binds to `127.0.0.1` on an allocated port and is
owned through its captured `ChildProcess` handle and PID; the surrounding host lock separately
records the T3 owner process-start identity. T3 never uses a broad name/path kill, the upstream
global `--kill` behavior, or a stale state file to terminate an unknown process.

`serve-sim@0.1.45` automatically invokes `open -ga Simulator` during startup. T3 prepends a
lease-private `open` shim to that child process's `PATH`; it no-ops exactly that argv and delegates
every other `open` call to `/usr/bin/open`. The shim directory is removed when the child exits or
is stopped. It does not change the T3 server's environment or suppress the panel's explicit
`Open in Simulator.app` action, which launches Simulator.app with the leased UDID.

The sidecar helpers used by the supervisor are intentionally narrow:

- `/stream.mjpeg` for the browser-compatible multipart video stream;
- `/config` and `/health` for dimensions and readiness.

After an authenticated status request, T3 exposes the MJPEG stream through a short-lived signed
capability bound to the environment, thread, lease, UDID, generation, and expiry. The public gateway
proxies only that device-scoped stream route to the loopback child. Health and config remain
server-internal, and T3 never exposes the sidecar port directly.

The browser sends human actions through an authenticated T3 input RPC. The server validates the
lease generation, action type, normalized coordinates, scroll bounds, HID usage, and encoded
message size before translating the bounded action to the sidecar's native protocol. The panel
also throttles continuous pointer and wheel traffic. The raw sidecar WebSocket is an implementation
detail and is not reachable from a client.

In particular, T3 never proxies `serve-sim`'s raw `/exec`, `/exec-ws`, devtools, shell, arbitrary
WebSocket, or other privileged routes. `/ax` may be useful for debugging the sidecar, but the
agent-facing semantic tree and actions remain XcodeBuildMCP's responsibility.

## User control and input arbitration

The panel is a human viewer with an authenticated input surface. A user clicks the Simulator screen
to focus it, then sends bounded pointer, keyboard, Home, or orientation actions through T3. The
server validates every action against the active lease before forwarding it to the same exact UDID.
The panel does not own or release the lease merely because it is mounted.

Agent semantic actions use the same lease and should refresh their accessibility snapshot after a
manual intervention, because the foreground screen may have changed. Build/launch and semantic UI
actions remain separate operations. The first release does not promise a separate user-versus-agent
takeover protocol; ownership of the session remains with the thread and its generation.

Specialized simulator injections such as camera data, CoreAnimation debugging, memory warnings,
Digital Crown, and arbitrary HID messages remain outside the public T3 contract.

## Worktree and build isolation

The lease owner is a thread, and the thread's worktree is the source of truth for that session. Two
threads that need independent versions should use separate worktrees; separate Simulator devices
do not prevent two threads from editing one checkout at the same time.

Each managed session has a T3-owned, thread-scoped DerivedData location and a private XcodeBuildMCP
child that receives explicit arguments for every operation. A build for one thread cannot accidentally install artifacts from another thread's
checkout. T3-owned DerivedData remains isolated from user-created DerivedData; Xcode runtimes and
unrelated Simulator data are not deleted by ordinary release.

The policy is intentionally conservative on disk:

- retain installed runtimes and devices;
- keep build output under T3-owned per-session paths;
- reclaim only stale host locks whose recorded process identity is proven dead;
- report capacity and cleanup failures instead of deleting broad developer directories.

## Client behavior

The shared web surface is the product UI, and desktop receives it through the desktop shell. The
panel shows:

- host capability and an explicit unsupported reason;
- automatic discovery of the current thread's live lease, even when the Simulator viewer was not
  already mounted;
- a Simulator tab with an activity indicator when another right-panel surface is active, plus a
  **Watch** control that activates the embedded viewer without creating another session;
- a compact ready rail with device name/runtime, stream reconnect, explicit native open, session
  details, device-ID copy, and release actions;
- queued, starting, ready, and failed states;
- live MJPEG video with reconnect handling as the primary panel content;
- bounded pointer, wheel, keyboard, Home, and orientation controls;
- device and lease details on demand rather than beside the live screen.

The panel is same-origin with the T3 server's authenticated connection. It does not embed a direct
`serve-sim` URL, depend on an Electron-only bridge, or require a client-side macOS API. A remote
browser therefore sees the same session as a local desktop client, subject to its authenticated T3
permissions and network path.

Closing or navigating away from the panel only detaches the viewer. It does not release a lease or
stop an agent's build. Closing the Simulator surface records a one-shot dismissal for the current
lease generation, so ordinary reconciliation does not reopen it. The user uses the explicit
release action, or the owner thread is deleted or the Simulator server layer shuts down, to return
the device to the queue. Release also removes the live viewer state and fences late input for that
lease.

## Failure and recovery

Failures are surfaced with a stable category and a next action where possible:

| Failure                                  | T3 behavior                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Unsupported host or missing runtime      | Keep T3 usable and report the host requirement; do not attempt to run `simctl`.                                          |
| Device already owned in this server      | Queue for the exact UDID; never steal or silently migrate.                                                               |
| Host capacity owned by another T3 server | Mark setup failed with a retryable lock message; release/retry after the owner is done.                                  |
| Capacity full                            | Return a bounded `queued` result and wake the request after a release event.                                             |
| Build validation failure                 | Return the typed XcodeBuildMCP diagnostic before leasing; no Simulator capacity is consumed.                             |
| Install/launch failure                   | Return the typed diagnostic and release a lease created by this call; preserve a pre-existing manual/thread lease.       |
| Sidecar health or first-frame timeout    | Mark the stream failed, stop the owned child, and allow retry without touching unknown processes.                        |
| Sidecar exit                             | Mark the lease failed, fence the generation, and release the owned sidecar and locks.                                    |
| XcodeBuildMCP child/tool failure         | Return a typed automation error; close and recreate the lease-scoped client after release.                               |
| Expired media token or stale input       | Reject the request; the client refreshes status/media credentials.                                                       |
| Thread deletion or T3 server shutdown    | Run owner-scoped cleanup, remove the live viewer state, and release the host lock only after child identity is verified. |

Recovery must be explicit and repeatable. A client can reconnect to a live lease and refresh its
signed media URL; reconnecting does not create a second lease. A failed setup is released before a
new acquisition revalidates the exact device and creates a new lease.

## Security and privacy

The stream may contain private source code, credentials displayed in an app, personal data, and
test accounts. T3 therefore treats it like any other authenticated environment resource:

- status and input require an authenticated T3 session;
- the signed media URL is itself a short-lived, lease/generation-scoped capability;
- input is authorized against the owning environment/thread and validated before forwarding;
- busy-device UI shows ownership state without exposing another thread's source or conversation;
- sidecar ports bind to loopback and are never advertised as public endpoints;
- privileged raw routes, shell execution, and arbitrary sidecar messages are not proxied;
- cleanup is owner-scoped and fail-closed;
- screenshot and log paths are returned only to the authenticated agent invocation that requested
  them.

Remote use still requires a trusted, authenticated T3 connection. The Simulator host remains the
Mac; the client does not receive direct filesystem, Xcode, or CoreSimulator access.

## Testing and acceptance evidence

Focused automated coverage is split across the independently failing boundaries:

- contracts validate capability, inventory, lease, queue, status, media, event, and input shapes;
- inventory, manager, host-lock, sidecar, and stream-token tests cover exact UDIDs, local queueing,
  generation fencing, fail-closed ownership, readiness, signed claims, and cleanup;
- XcodeBuildMCP and automation tests cover the curated tool set, exact UDID/worktree propagation,
  isolated DerivedData, client reuse, serialization, typed errors, and close behavior;
- MCP toolkit and HTTP-session tests cover authenticated thread scoping, semantic element refs,
  stale-generation rejection, tool annotations, and lease cleanup;
- web helper and store tests cover view-state derivation, same-origin stream capabilities,
  letterboxed coordinate mapping, HID allowlisting, bounded wheel input, orientation, and the
  Simulator right-panel state, including non-disruptive tab insertion and idempotent discovery.

The supported-host acceptance pass was completed on Apple Silicon macOS with real `simctl`, the
pinned `serve-sim`, and a private pinned XcodeBuildMCP child. It built and validated an app from the
owning worktree, acquired the exact device, received a real first frame through the T3 signed
stream route, forwarded a validated panel action, launched the app, captured a semantic runtime
snapshot and screenshot, and explicitly released the lease. Captured visual evidence is available in
[`simulator-panel-ready.png`](../assets/ios-simulator/simulator-panel-ready.png) and
[`simulator-panel-live.mp4`](../assets/ios-simulator/simulator-panel-live.mp4). Platform fallback
outside Apple Silicon macOS remains expressed through the capability and inventory unit
boundaries; it is not claimed as a Linux or Windows end-to-end run.

## Non-goals

The first release does not:

- run iOS Simulator natively on Linux or Windows;
- replace physical-device testing for hardware, signing, performance, camera, Bluetooth, push, or
  OS-specific behavior;
- expose a second accessibility/semantic automation protocol;
- expose raw `serve-sim` shell, WebKit devtools, or arbitrary command routes;
- create, erase, or download Simulator devices and runtimes automatically;
- guarantee more than the configured host capacity or run one unrestricted Simulator per thread;
- surface a dedicated mobile Simulator UI before the web/desktop workflow is proven;
- silently migrate an exact-UDID request or steal another thread's lease.
