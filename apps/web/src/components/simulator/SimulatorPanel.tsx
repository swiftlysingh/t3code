import {
  SimulatorUdid,
  type ScopedThreadRef,
  type SimulatorCapabilities,
  type SimulatorInputEvent,
  type SimulatorSession,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Home,
  Keyboard,
  LoaderCircle,
  MousePointer2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { simulatorEnvironment } from "~/state/simulator";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  clampSimulatorScrollDelta,
  deriveSimulatorPanelViewState,
  enqueueSimulatorInput,
  hidUsageForKeyboardCode,
  mapPointToContainedMedia,
  nextSimulatorOrientation,
  resolveSimulatorStreamUrl,
  simulatorMediaDimensionsForOrientation,
  type ContainedMediaPoint,
  type SimulatorPanelViewState,
} from "./SimulatorPanel.helpers";

const MOVE_INTERVAL_MS = 1000 / 30;
const MAX_STREAM_RETRIES = 3;
const TRANSITION_REFRESH_MS = 1_500;

type StreamState = "waiting" | "connecting" | "live" | "reconnecting" | "unavailable";

interface ActiveTouch {
  readonly pointerId: number;
  readonly session: SimulatorSession;
  x: number;
  y: number;
  lastMoveAt: number;
}

interface QueuedSimulatorInput {
  readonly event: SimulatorInputEvent;
  readonly target: SimulatorSession;
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly threadId: ScopedThreadRef["threadId"];
  readonly resolve: (accepted: boolean) => void;
}

interface OptimisticSimulatorMedia {
  readonly sessionKey: string;
  readonly orientation: NonNullable<SimulatorSession["media"]>["orientation"];
  readonly width: number;
  readonly height: number;
}

function commandErrorMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Simulator request failed.";
}

function hostLabel(capabilities: SimulatorCapabilities | null): string {
  if (!capabilities) return "Host capability unavailable";
  return `${capabilities.host.os}/${capabilities.host.arch}`;
}

function statusLabel(state: SimulatorPanelViewState): string {
  switch (state) {
    case "loading":
      return "Loading";
    case "unsupported":
      return "Unsupported";
    case "idle":
      return "Available";
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "ready":
      return "Ready";
    case "failed":
      return "Needs attention";
  }
}

function stateTone(state: SimulatorPanelViewState): string {
  switch (state) {
    case "failed":
    case "unsupported":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "queued":
    case "starting":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "ready":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    default:
      return "border-border bg-muted/50 text-muted-foreground";
  }
}

function streamLabel(state: StreamState): string {
  switch (state) {
    case "waiting":
      return "Waiting for stream";
    case "connecting":
      return "Connecting stream";
    case "live":
      return "Live";
    case "reconnecting":
      return "Reconnecting stream";
    case "unavailable":
      return "Stream unavailable";
  }
}

function SimulatorStatusBadge({ state }: { readonly state: SimulatorPanelViewState }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        stateTone(state),
      )}
      data-simulator-status={state}
    >
      {statusLabel(state)}
    </span>
  );
}

function DetailRow({
  label,
  value,
  code = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly code?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate text-right text-foreground", code && "font-mono")}>
        {value}
      </dd>
    </div>
  );
}

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function pointForEvent(
  event: Pick<ReactPointerEvent<HTMLDivElement>, "clientX" | "clientY" | "currentTarget">,
  media: { readonly width: number; readonly height: number } | undefined,
): ContainedMediaPoint | null {
  if (!media) return null;
  const bounds = event.currentTarget.getBoundingClientRect();
  return mapPointToContainedMedia({
    clientX: event.clientX,
    clientY: event.clientY,
    bounds,
    media,
  });
}

function defaultSelectedDevice(
  devices: ReadonlyArray<{ readonly udid: string; readonly state: string }>,
): string {
  return devices.find((device) => device.state === "booted")?.udid ?? devices[0]?.udid ?? "";
}

function simulatorSessionKey(session: SimulatorSession | null): string | null {
  return session ? `${session.leaseId}:${session.generation}` : null;
}

function streamAttemptUrl(streamUrl: string | null, attempt: number): string | null {
  if (!streamUrl) return null;
  try {
    const url = new URL(streamUrl);
    url.hash = `simulator-stream-${attempt}`;
    return url.toString();
  } catch {
    return null;
  }
}

export function SimulatorPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const listQuery = useEnvironmentQuery(
    simulatorEnvironment.list({ environmentId: threadRef.environmentId, input: {} }),
  );
  const statusQuery = useEnvironmentQuery(
    simulatorEnvironment.status({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const eventsQuery = useEnvironmentQuery(
    simulatorEnvironment.events({ environmentId: threadRef.environmentId, input: {} }),
  );
  const acquire = useAtomCommand(simulatorEnvironment.acquire, { reportFailure: false });
  const release = useAtomCommand(simulatorEnvironment.release, { reportFailure: false });
  const sendInput = useAtomCommand(simulatorEnvironment.sendInput, { reportFailure: false });
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);

  const [selectedUdid, setSelectedUdid] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [streamState, setStreamState] = useState<StreamState>("waiting");
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [optimisticMedia, setOptimisticMedia] = useState<OptimisticSimulatorMedia | null>(null);
  const lastEventSequence = useRef<number | null>(null);
  const releasedLeaseKeys = useRef(new Set<string>());
  const streamRetryTimer = useRef<number | null>(null);
  const activeTouch = useRef<ActiveTouch | null>(null);
  const activeKeyboardUsages = useRef(new Map<number, SimulatorSession>());
  const inputQueue = useRef<QueuedSimulatorInput[]>([]);
  const inputDrainPromise = useRef<Promise<void> | null>(null);
  const lastScrollAt = useRef(-Infinity);
  const mounted = useRef(true);

  const capabilities = statusQuery.data?.capabilities ?? listQuery.data?.capabilities ?? null;
  const devices = listQuery.data?.devices ?? [];
  const session = useMemo(
    () =>
      statusQuery.data !== null
        ? statusQuery.data.session
        : (listQuery.data?.sessions.find((entry) => entry.threadId === threadRef.threadId) ?? null),
    [listQuery.data?.sessions, statusQuery.data, threadRef.threadId],
  );
  const sessionMedia = session?.media;
  const sessionKey = simulatorSessionKey(session);
  const displayedSessionMedia = useMemo(() => {
    if (!sessionMedia || !sessionKey || optimisticMedia?.sessionKey !== sessionKey) {
      return sessionMedia;
    }
    return {
      ...sessionMedia,
      orientation: optimisticMedia.orientation,
      width: optimisticMedia.width,
      height: optimisticMedia.height,
    };
  }, [optimisticMedia, sessionKey, sessionMedia]);
  const mediaDimensions =
    displayedSessionMedia && displayedSessionMedia.width > 0 && displayedSessionMedia.height > 0
      ? { width: displayedSessionMedia.width, height: displayedSessionMedia.height }
      : undefined;
  const streamUrl = useMemo(
    () => resolveSimulatorStreamUrl(environmentHttpBaseUrl, sessionMedia?.streamUrl),
    [environmentHttpBaseUrl, sessionMedia?.streamUrl],
  );
  const streamSrc = useMemo(
    () => streamAttemptUrl(streamUrl, streamAttempt),
    [streamAttempt, streamUrl],
  );

  const queryError = statusQuery.error ?? listQuery.error;
  const state = deriveSimulatorPanelViewState({
    queryFailed: queryError !== null,
    platformSupported: capabilities?.platformSupported ?? null,
    executionReady: capabilities?.executionReady ?? null,
    sessionState: session?.state ?? null,
  });
  const selectedDevice = devices.find((device) => device.udid === selectedUdid) ?? null;
  const sessions = listQuery.data?.sessions ?? [];
  const activeCount = sessions.filter(
    (entry) => entry.state === "starting" || entry.state === "ready",
  ).length;
  const queuedCount = sessions.filter((entry) => entry.state === "queued").length;
  const maxActive = capabilities?.maxActive ?? 0;
  const capacityPercent = maxActive > 0 ? Math.min(100, (activeCount / maxActive) * 100) : 0;
  const controlsEnabled = state === "ready" && streamState === "live" && !actionPending;
  const pointerInputEnabled =
    controlsEnabled && streamUrl !== null && mediaDimensions !== undefined;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setOptimisticMedia((current) => {
      if (!current || current.sessionKey !== sessionKey) return null;
      if (
        sessionMedia?.orientation === current.orientation &&
        sessionMedia.width === current.width &&
        sessionMedia.height === current.height
      ) {
        return null;
      }
      return current;
    });
  }, [sessionKey, sessionMedia?.height, sessionMedia?.orientation, sessionMedia?.width]);

  useEffect(() => {
    const next = defaultSelectedDevice(devices);
    if (!next) {
      setSelectedUdid("");
      return;
    }
    setSelectedUdid((current) =>
      devices.some((device) => device.udid === current) ? current : next,
    );
  }, [devices]);

  const eventSequence = eventsQuery.data?.sequence ?? null;
  useEffect(() => {
    if (eventSequence === null || eventSequence === lastEventSequence.current) return;
    lastEventSequence.current = eventSequence;
    statusQuery.refresh();
    listQuery.refresh();
  }, [eventSequence, listQuery.refresh, statusQuery.refresh]);

  useEffect(() => {
    if (state !== "queued" && state !== "starting") return;
    let timer = 0;
    const refresh = () => {
      statusQuery.refresh();
      listQuery.refresh();
      timer = window.setTimeout(refresh, TRANSITION_REFRESH_MS);
    };
    timer = window.setTimeout(refresh, TRANSITION_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [listQuery.refresh, state, statusQuery.refresh]);

  useEffect(() => {
    if (streamRetryTimer.current !== null) {
      window.clearTimeout(streamRetryTimer.current);
      streamRetryTimer.current = null;
    }
    setStreamAttempt(0);
    setStreamState(streamUrl ? "connecting" : "waiting");
    return () => {
      if (streamRetryTimer.current !== null) {
        window.clearTimeout(streamRetryTimer.current);
        streamRetryTimer.current = null;
      }
    };
  }, [streamUrl]);

  const drainInputQueue = useCallback((): Promise<void> => {
    const running = inputDrainPromise.current;
    if (running) return running;

    const drain = (async () => {
      while (inputQueue.current.length > 0) {
        const queued = inputQueue.current.shift();
        if (!queued) continue;
        try {
          const result = await sendInput({
            environmentId: queued.environmentId,
            input: {
              threadId: queued.threadId,
              leaseId: queued.target.leaseId,
              generation: queued.target.generation,
              event: queued.event,
            },
          });
          const accepted = result._tag === "Success";
          queued.resolve(accepted);
          if (!accepted && mounted.current) {
            setActionError(commandErrorMessage(result));
          }
        } catch (error) {
          queued.resolve(false);
          if (mounted.current) {
            setActionError(
              error instanceof Error ? error.message : "The Simulator request failed.",
            );
          }
        }
      }
    })();
    inputDrainPromise.current = drain;
    void drain.finally(() => {
      if (inputDrainPromise.current === drain) inputDrainPromise.current = null;
    });
    return drain;
  }, [sendInput]);

  const sendSimulatorEvent = useCallback(
    (event: SimulatorInputEvent, target: SimulatorSession | null = session): Promise<boolean> => {
      if (!target || target.state !== "ready") return Promise.resolve(false);
      return new Promise((resolve) => {
        const item: QueuedSimulatorInput = {
          event,
          target,
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          resolve,
        };
        enqueueSimulatorInput(inputQueue.current, item, (replaced) => {
          replaced.resolve(false);
        });
        void drainInputQueue();
      });
    },
    [drainInputQueue, session, threadRef.environmentId, threadRef.threadId],
  );
  const sendSimulatorEventRef = useRef(sendSimulatorEvent);
  useEffect(() => {
    sendSimulatorEventRef.current = sendSimulatorEvent;
  }, [sendSimulatorEvent]);

  const endActiveTouch = useCallback((): Promise<boolean> => {
    const touch = activeTouch.current;
    if (!touch) return Promise.resolve(true);
    activeTouch.current = null;
    return sendSimulatorEventRef.current(
      { type: "touch", phase: "end", x: touch.x, y: touch.y },
      touch.session,
    );
  }, []);

  const releasePressedKeys = useCallback((): Promise<ReadonlyArray<boolean>> => {
    const usages = [...activeKeyboardUsages.current.entries()];
    activeKeyboardUsages.current.clear();
    return Promise.all(
      usages.map(([usage, target]) =>
        sendSimulatorEventRef.current({ type: "keyboard", phase: "up", usage }, target),
      ),
    );
  }, []);

  const releaseActiveInput = useCallback(async () => {
    await Promise.all([endActiveTouch(), releasePressedKeys()]);
    await drainInputQueue();
  }, [drainInputQueue, endActiveTouch, releasePressedKeys]);

  useEffect(() => {
    // The SimulatorPanel is keyed by scoped thread, but keep the cleanup
    // explicit so a future parent refactor cannot carry held input across
    // threads.
    return () => {
      void releaseActiveInput();
    };
  }, [releaseActiveInput, threadRef.environmentId, threadRef.threadId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const releaseInput = () => {
      void releaseActiveInput();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") releaseInput();
    };
    window.addEventListener("blur", releaseInput);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", releaseInput);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      releaseInput();
    };
  }, [releaseActiveInput]);

  const releaseLease = useCallback(
    async (lease: SimulatorSession, showError: boolean): Promise<boolean> => {
      const leaseKey = `${lease.leaseId}:${lease.generation}`;
      if (releasedLeaseKeys.current.has(leaseKey)) return true;
      releasedLeaseKeys.current.add(leaseKey);
      const result = await release({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          leaseId: lease.leaseId,
          generation: lease.generation,
        },
      });
      if (result._tag === "Failure") {
        releasedLeaseKeys.current.delete(leaseKey);
        if (showError) setActionError(commandErrorMessage(result));
        return false;
      }
      if (showError) {
        setActionError(null);
        statusQuery.refresh();
        listQuery.refresh();
      }
      return true;
    },
    [listQuery.refresh, release, statusQuery.refresh, threadRef.environmentId, threadRef.threadId],
  );

  const handleAcquire = useCallback(async () => {
    if (!selectedDevice || actionPending || state !== "idle") return;
    setActionError(null);
    setActionPending(true);
    const result = await acquire({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        udid: SimulatorUdid.make(selectedDevice.udid),
      },
    });
    setActionPending(false);
    if (result._tag === "Failure") {
      setActionError(commandErrorMessage(result));
      return;
    }
    statusQuery.refresh();
    listQuery.refresh();
  }, [
    acquire,
    actionPending,
    listQuery.refresh,
    selectedDevice,
    state,
    statusQuery.refresh,
    threadRef.environmentId,
    threadRef.threadId,
  ]);

  const handleRelease = useCallback(async () => {
    if (!session || actionPending) return;
    setActionError(null);
    setActionPending(true);
    await releaseActiveInput();
    await releaseLease(session, true);
    setActionPending(false);
  }, [actionPending, releaseActiveInput, releaseLease, session]);

  const handleStreamError = useCallback(() => {
    if (!streamUrl || streamRetryTimer.current !== null) return;
    if (streamAttempt >= MAX_STREAM_RETRIES) {
      setStreamState("unavailable");
      return;
    }
    setStreamState("reconnecting");
    statusQuery.refresh();
    streamRetryTimer.current = window.setTimeout(
      () => {
        streamRetryTimer.current = null;
        setStreamAttempt((attempt) => attempt + 1);
      },
      500 + streamAttempt * 500,
    );
  }, [statusQuery.refresh, streamAttempt, streamUrl]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (
        event.button !== 0 ||
        activeTouch.current !== null ||
        !pointerInputEnabled ||
        !session ||
        !mediaDimensions
      ) {
        return;
      }
      const point = pointForEvent(event, mediaDimensions);
      if (!point) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      activeTouch.current = {
        pointerId: event.pointerId,
        session,
        x: point.x,
        y: point.y,
        lastMoveAt: -Infinity,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      sendSimulatorEvent({ type: "touch", phase: "begin", x: point.x, y: point.y }, session);
    },
    [mediaDimensions, pointerInputEnabled, sendSimulatorEvent, session],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const touch = activeTouch.current;
      if (!touch || touch.pointerId !== event.pointerId || !mediaDimensions) return;
      event.preventDefault();
      const point = pointForEvent(event, mediaDimensions);
      if (!point) return;
      touch.x = point.x;
      touch.y = point.y;
      const timestamp = nowMs();
      if (timestamp - touch.lastMoveAt < MOVE_INTERVAL_MS) return;
      touch.lastMoveAt = timestamp;
      sendSimulatorEvent({ type: "touch", phase: "move", x: point.x, y: point.y }, touch.session);
    },
    [mediaDimensions, sendSimulatorEvent],
  );

  const finishPointerTouch = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const touch = activeTouch.current;
      if (!touch || touch.pointerId !== event.pointerId) return;
      const point = pointForEvent(event, mediaDimensions);
      if (point) {
        touch.x = point.x;
        touch.y = point.y;
      }
      endActiveTouch();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [endActiveTouch, mediaDimensions],
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (activeTouch.current?.pointerId !== event.pointerId) return;
      endActiveTouch();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [endActiveTouch],
  );

  const handleKeyboardDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        !pointerInputEnabled ||
        event.nativeEvent.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const usage = hidUsageForKeyboardCode(event.code);
      if (usage === null || !session) return;
      event.preventDefault();
      if (activeKeyboardUsages.current.has(usage)) return;
      activeKeyboardUsages.current.set(usage, session);
      sendSimulatorEvent({ type: "keyboard", phase: "down", usage }, session);
    },
    [pointerInputEnabled, sendSimulatorEvent, session],
  );

  const handleKeyboardUp = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const usage = hidUsageForKeyboardCode(event.code);
      if (usage === null) return;
      const target = activeKeyboardUsages.current.get(usage);
      if (!target) return;
      event.preventDefault();
      activeKeyboardUsages.current.delete(usage);
      sendSimulatorEvent({ type: "keyboard", phase: "up", usage }, target);
    },
    [sendSimulatorEvent],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!pointerInputEnabled || !session || !mediaDimensions) return;
      const point = pointForEvent(event, mediaDimensions);
      if (!point) return;
      const dx = clampSimulatorScrollDelta(event.deltaX);
      const dy = clampSimulatorScrollDelta(event.deltaY);
      if (dx === 0 && dy === 0) return;
      event.preventDefault();
      const timestamp = nowMs();
      if (timestamp - lastScrollAt.current < MOVE_INTERVAL_MS) return;
      lastScrollAt.current = timestamp;
      sendSimulatorEvent({ type: "scroll", dx, dy, x: point.x, y: point.y }, session);
    },
    [mediaDimensions, pointerInputEnabled, sendSimulatorEvent, session],
  );

  const sendHome = useCallback(() => {
    sendSimulatorEvent({ type: "home" });
  }, [sendSimulatorEvent]);

  const rotate = useCallback(
    (direction: "clockwise" | "counterclockwise") => {
      if (!session || !sessionKey || !displayedSessionMedia) return;
      const orientation = nextSimulatorOrientation(displayedSessionMedia.orientation, direction);
      const dimensions = simulatorMediaDimensionsForOrientation({
        width: displayedSessionMedia.width,
        height: displayedSessionMedia.height,
        currentOrientation: displayedSessionMedia.orientation,
        nextOrientation: orientation,
      });
      setOptimisticMedia({
        sessionKey,
        orientation,
        ...dimensions,
      });
      void sendSimulatorEvent({ type: "orientation", orientation }).then((accepted) => {
        if (accepted || !mounted.current) return;
        setOptimisticMedia((current) =>
          current?.sessionKey === sessionKey && current.orientation === orientation
            ? null
            : current,
        );
      });
    },
    [displayedSessionMedia, sendSimulatorEvent, sessionKey, session],
  );

  const failureMessage =
    session?.failure?.message ??
    actionError ??
    queryError ??
    (capabilities && !capabilities.executionReady
      ? "This environment cannot start iOS Simulator tooling yet."
      : "The Simulator session could not be started.");

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-simulator-panel>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 sm:gap-4">
          <header className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Smartphone className="size-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">Simulator</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  One device, leased to this thread.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <div aria-live="polite">
                <SimulatorStatusBadge state={state} />
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Refresh Simulator status"
                title="Refresh status"
                disabled={state === "loading" || actionPending}
                onClick={() => {
                  setActionError(null);
                  listQuery.refresh();
                  statusQuery.refresh();
                }}
              >
                <RefreshCw aria-hidden />
              </Button>
            </div>
          </header>

          {state === "loading" ? (
            <section className="flex items-center gap-2 rounded-lg border border-border/80 bg-card p-4 text-sm text-muted-foreground">
              <LoaderCircle className="size-4" aria-hidden />
              Loading Simulator availability…
            </section>
          ) : null}

          {state === "unsupported" && capabilities ? (
            <section
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
              data-simulator-unsupported
            >
              <div className="flex items-start gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-destructive">Unsupported on this host</h3>
                  <p className="mt-1 text-xs leading-relaxed text-destructive/80">
                    iOS Simulator control requires Apple silicon macOS. This environment reports{" "}
                    {hostLabel(capabilities)}.
                  </p>
                </div>
              </div>
              <dl className="mt-4 grid gap-1.5 border-t border-destructive/20 pt-3">
                <DetailRow label="Host" value={hostLabel(capabilities)} code />
                <DetailRow label="Reason" value={capabilities.reason ?? "—"} code />
              </dl>
            </section>
          ) : null}

          {state === "failed" ? (
            <section
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
              data-simulator-failed
              role="alert"
            >
              <div className="flex items-start gap-2">
                <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-destructive">
                    {session ? "Simulator session failed" : "Simulator unavailable"}
                  </h3>
                  <p className="mt-1 break-words text-xs leading-relaxed text-destructive/80">
                    {failureMessage}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="destructive-outline"
                  size="xs"
                  onClick={() => {
                    setActionError(null);
                    listQuery.refresh();
                    statusQuery.refresh();
                  }}
                >
                  Refresh status
                </Button>
                {session ? (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={actionPending}
                    onClick={() => void handleRelease()}
                  >
                    {actionPending ? "Releasing…" : "Release device"}
                  </Button>
                ) : null}
              </div>
            </section>
          ) : null}

          {capabilities && state !== "unsupported" && state !== "failed" ? (
            <>
              <section
                className="rounded-lg border border-border/80 bg-card p-3 sm:p-4"
                data-simulator-capacity
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-foreground">Host capacity</span>
                  <span className="text-muted-foreground">
                    {activeCount} / {maxActive} active
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div
                    className="h-full rounded-full bg-foreground/70 transition-[width] motion-reduce:transition-none"
                    style={{ width: `${capacityPercent}%` }}
                  />
                </div>
                <div className="mt-2 flex justify-between gap-3 text-[11px] text-muted-foreground">
                  <span>{queuedCount > 0 ? `${queuedCount} waiting` : "No queued threads"}</span>
                  <span>
                    {devices.length} device{devices.length === 1 ? "" : "s"} available
                  </span>
                </div>
              </section>

              {state === "idle" ? (
                <section
                  className="rounded-lg border border-border/80 bg-card p-3 sm:p-4"
                  data-simulator-idle
                >
                  <div className="flex items-start gap-2.5">
                    <Smartphone
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <div>
                      <h3 className="text-sm font-medium text-foreground">Choose a Simulator</h3>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Reserving a device starts a private session for this thread. Other threads
                        wait instead of sharing it.
                      </p>
                    </div>
                  </div>
                  {devices.length > 0 ? (
                    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                      <div className="min-w-0 flex-1">
                        <label
                          className="mb-1 block text-[11px] font-medium text-muted-foreground"
                          htmlFor="simulator-device"
                        >
                          Device
                        </label>
                        <select
                          id="simulator-device"
                          value={selectedUdid}
                          onChange={(event) => {
                            setSelectedUdid(event.target.value);
                            setActionError(null);
                          }}
                          className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                          disabled={actionPending}
                        >
                          {devices.map((device) => (
                            <option key={device.udid} value={device.udid}>
                              {device.name} · {device.runtime} · {device.state}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Button
                        className="mt-auto"
                        size="sm"
                        disabled={actionPending || selectedDevice === null}
                        onClick={() => void handleAcquire()}
                      >
                        {actionPending ? "Starting…" : "Start session"}
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                      This environment did not return an available iOS Simulator. Refresh after
                      installing or creating one on the host.
                    </div>
                  )}
                </section>
              ) : null}

              {state === "queued" || state === "starting" ? (
                <section
                  className="rounded-lg border border-border/80 bg-card p-4"
                  data-simulator-pending
                >
                  <div className="flex items-start gap-2.5">
                    <LoaderCircle
                      className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300"
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-foreground">
                        {state === "queued" ? "Waiting for this device" : "Starting Simulator"}
                      </h3>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {state === "queued"
                          ? `Queue position ${session?.queuePosition ?? "—"}. The session will start automatically when the device is free.`
                          : "Booting the device and connecting its live screen. This can take a moment after a cold start."}
                      </p>
                    </div>
                  </div>
                  {session ? (
                    <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                      <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                        {session.udid}
                      </span>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={actionPending}
                        onClick={() => void handleRelease()}
                      >
                        {actionPending ? "Releasing…" : "Release device"}
                      </Button>
                    </div>
                  ) : null}
                </section>
              ) : null}

              {state === "ready" && session ? (
                <section
                  className="overflow-hidden rounded-lg border border-border/80 bg-card"
                  data-simulator-session
                >
                  <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2 sm:px-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <CircleCheck
                        className="size-4 shrink-0 text-emerald-600 dark:text-emerald-300"
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-medium text-foreground">
                          Live Simulator
                        </h3>
                        <p className="truncate text-[11px] text-muted-foreground">{session.udid}</p>
                      </div>
                    </div>
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 text-[11px]",
                        streamState === "live"
                          ? "text-emerald-700 dark:text-emerald-300"
                          : "text-muted-foreground",
                      )}
                      aria-live="polite"
                    >
                      {streamState === "live" ? (
                        <Wifi className="size-3" aria-hidden />
                      ) : (
                        <WifiOff className="size-3" aria-hidden />
                      )}
                      {streamLabel(streamState)}
                    </span>
                  </div>

                  <div className="p-3 sm:p-4">
                    <div
                      className="relative mx-auto w-full overflow-hidden rounded-[1rem] border border-border/70 bg-black shadow-inner"
                      style={
                        mediaDimensions
                          ? { aspectRatio: `${mediaDimensions.width} / ${mediaDimensions.height}` }
                          : { aspectRatio: "9 / 19.5" }
                      }
                    >
                      {streamSrc ? (
                        <img
                          key={streamSrc}
                          src={streamSrc}
                          alt="Live iOS Simulator screen"
                          className="absolute inset-0 size-full select-none object-contain"
                          draggable={false}
                          onLoad={() => setStreamState("live")}
                          onError={handleStreamError}
                        />
                      ) : null}

                      {!streamSrc || streamState !== "live" ? (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/75 p-5 text-center text-xs text-white/70">
                          <span className="flex max-w-52 flex-col items-center gap-2">
                            {streamState === "unavailable" ? (
                              <CircleAlert className="size-4 text-amber-300" aria-hidden />
                            ) : (
                              <LoaderCircle className="size-4" aria-hidden />
                            )}
                            {streamState === "unavailable"
                              ? "The stream could not reconnect. Refresh status to request a new stream capability."
                              : streamLabel(streamState)}
                          </span>
                        </div>
                      ) : null}

                      <div
                        className={cn(
                          "absolute inset-0 touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
                          pointerInputEnabled ? "cursor-crosshair" : "cursor-not-allowed",
                        )}
                        tabIndex={pointerInputEnabled ? 0 : -1}
                        aria-label="Simulator screen. Click to control it; use the keyboard while this screen is focused."
                        aria-disabled={!pointerInputEnabled}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={finishPointerTouch}
                        onPointerCancel={handlePointerCancel}
                        onLostPointerCapture={endActiveTouch}
                        onKeyDown={handleKeyboardDown}
                        onKeyUp={handleKeyboardUp}
                        onWheel={handleWheel}
                      />
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <MousePointer2 className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">
                          Click the screen, then type or use the controls.
                        </span>
                      </p>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="outline"
                          size="icon-xs"
                          aria-label="Rotate Simulator counterclockwise"
                          title="Rotate counterclockwise"
                          disabled={!controlsEnabled}
                          onClick={() => rotate("counterclockwise")}
                        >
                          <RotateCcw aria-hidden />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-xs"
                          aria-label="Go to Simulator Home screen"
                          title="Home"
                          disabled={!controlsEnabled}
                          onClick={sendHome}
                        >
                          <Home aria-hidden />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-xs"
                          aria-label="Rotate Simulator clockwise"
                          title="Rotate clockwise"
                          disabled={!controlsEnabled}
                          onClick={() => rotate("clockwise")}
                        >
                          <RotateCw aria-hidden />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Keyboard className="size-3" aria-hidden />
                      Standard keys, arrows, Return, Delete, and Shift are forwarded while the
                      screen is focused.
                    </div>
                  </div>

                  <dl className="grid gap-1.5 border-t border-border/70 px-3 py-3 sm:px-4">
                    <DetailRow label="Lease" value={session.leaseId} code />
                    <DetailRow label="Generation" value={String(session.generation)} code />
                  </dl>
                  <div className="border-t border-border/70 px-3 py-2 sm:px-4">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={actionPending}
                      onClick={() => void handleRelease()}
                    >
                      {actionPending ? "Releasing…" : "Release device"}
                    </Button>
                  </div>
                </section>
              ) : null}
            </>
          ) : null}

          {actionError && state !== "failed" ? (
            <div
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
              role="alert"
            >
              {actionError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
