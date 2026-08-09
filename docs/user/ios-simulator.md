# Use the iOS Simulator in T3 Code

T3 Code can show and control an iOS Simulator while an agent builds and inspects the app for the
current thread. The agent and the T3 panel use the same running app: the agent can inspect it and
perform semantic actions, while you can watch the screen and take the input turn when you need to
intervene.

## Requirements

The T3 server must run on an Apple Silicon Mac with:

- Xcode installed and usable;
- a compatible iOS Simulator runtime and device already installed;
- enough disk space and memory for the app, build, and Simulator.

You do not need to install or run a separate `serve-sim` server. T3 starts its pinned, local
streaming helper on demand when a session is acquired and a live view is needed. You also do not
need to run a second MCP server: T3 starts the Xcode build and UI-automation connection on the
agent's first build or UI-automation call.

The browser or desktop client may be on another operating system. The Mac running the T3 server is
the machine that runs the Simulator.

## Open a session

1. Open the thread that owns the iOS project.
2. Open the Command Palette and choose **Open Simulator**, or open the **Simulator** panel from
   the right-side panels.
3. Check the host status and device list. T3 shows the device name, runtime, and exact UDID so you
   can tell which Simulator the session uses.
4. Choose one of the available exact devices.
5. Choose **Start session** or ask the agent to use its iOS workflow. T3 reserves and boots the
   device and opens the live view when the first real frame is ready. Starting a session does not
   guess which Xcode project or scheme to build; the agent's build-and-run tool supplies those
   project details afterward.

The agent's first-class iOS tools and the panel refer to the same lease. Repeating the run request
from the same thread reuses that lease rather than opening a second Simulator.

## Watch and interact

When the session is ready, the panel shows the live Simulator screen. Click the screen to focus it
before sending input. The available controls include:

- tap and drag/swipe on the screen;
- wheel or trackpad scrolling;
- bounded keyboard input;
- Home;
- orientation changes;
- reconnecting the viewer or refreshing the session status.

The server validates and serializes panel input against the active lease. Avoid sending input while
the agent is issuing a semantic action to the same device; the agent should take a fresh UI snapshot
after any manual intervention because the screen may have changed.

Closing the panel only closes the viewer. It does not stop a build, release the Simulator, or stop
the agent's work.

## What the agent can do

The agent can use T3's iOS tools to acquire the session, build/install/launch the app, inspect the
accessibility tree through XcodeBuildMCP, tap or type by semantic element, wait for a UI state, and
take a screenshot. You do not need to copy a UDID between
the panel and the agent: T3 passes the exact lease device to the scoped build and UI tools.

This does not replace Xcode or physical-device testing. Hardware-dependent behavior such as
camera input, Bluetooth, push delivery, performance under real hardware, signing, and device-only
OS behavior still needs the appropriate Apple test workflow.

## When the Simulator is busy

By default, each T3 server allows one active Simulator session. This protects the Mac from several
large builds and interactive devices competing for memory, CPU, foreground state, and input.

If another thread in the same T3 server already owns the available capacity, T3 shows **Queued**
with its position. The acquire call returns immediately and the session advances after a release
event. You can continue other work while the session waits.

If another T3 server or worktree process owns the host-wide capacity lock, setup fails with a
retryable locked message. T3 will not silently switch devices, stop the other owner, or hide an
unbounded wait inside the agent call. Release the owning session, then release/retry the failed
request.

To free a session, use **Release** in the Simulator panel or ask the owning agent to close its
session. Release stops only the T3-owned build/stream helpers for that lease and makes the device
available to the next queued request. T3 does not erase the Simulator or delete unrelated Xcode
data during an ordinary release.

## Unsupported hosts and remote use

If the T3 server runs on Linux, Windows, Intel macOS, or a Mac without the required Xcode tools or
runtime, the panel reports **Simulator unavailable** with the reason. T3 continues to provide its
normal coding-agent features; it does not try to emulate iOS Simulator on that host.

You can still use the feature from a Linux or Windows browser when the connected T3 environment is
running on a supported Mac. Pair with that Mac as described in [Remote Access](./remote-access.md),
then open the Simulator panel normally. The video and controls travel through the authenticated T3
connection; the remote client never connects directly to the Mac's Simulator helper.

## Troubleshooting

| What you see             | What to do                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Simulator unavailable    | Check that the T3 server, not just the browser, is running on an Apple Silicon Mac with Xcode and an installed iOS runtime.                                              |
| Queued                   | Wait for the current owner to release the device, or release your own idle session from the panel.                                                                       |
| Simulator locked         | Another T3 process owns host capacity. Release that owner, then release/retry this failed session.                                                                       |
| Starting for a long time | The server may still be booting the device or waiting for its first stream frame. Check the session details; retry after a failure rather than opening a second session. |
| Build or launch failed   | Read the agent's Xcode diagnostic, fix the project/signing/build issue, and retry or release the failed session.                                                         |
| Stream disconnected      | Refresh status to request a new short-lived stream URL. If the sidecar exited, T3 reports a retryable failure.                                                           |
| Input rejected           | Click the Simulator screen to focus it, reconnect the panel, and make sure the session has not been released or reassigned.                                              |

For problems that persist, include the session state, device UDID, and failure stage when reporting
the issue. Do not paste private app content or share a raw Simulator helper URL.

## Limits

The live panel is intended for development and interactive agent work. The initial release does
not provide a mobile-specific Simulator screen, unlimited parallel devices, camera or arbitrary
HID injection, or a way to create/download runtimes. The shipped default remains one active
interactive Simulator per T3 server.
