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
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  Home,
  InfoIcon,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  RotateCw,
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
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
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
  const openNative = useAtomCommand(simulatorEnvironment.open, { reportFailure: false });
  const release = useAtomCommand(simulatorEnvironment.release, { reportFailure: false });
  const sendInput = useAtomCommand(simulatorEnvironment.sendInput, { reportFailure: false });
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);

  const [selectedUdid, setSelectedUdid] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [streamState, setStreamState] = useState<StreamState>("waiting");
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [optimisticMedia, setOptimisticMedia] = useState<OptimisticSimulatorMedia | null>(null);
  const [sessionDetailsOpen, setSessionDetailsOpen] = useState(false);
  const { copyToClipboard, isCopied: hasCopiedDeviceId } = useCopyToClipboard({
    target: "device ID",
    onError: (error) => setActionError(error.message),
  });
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
  const sessionDevice = session ? devices.find((device) => device.udid === session.udid) : null;
  const sessionDeviceLabel = sessionDevice
    ? `${sessionDevice.name} · ${sessionDevice.runtime}`
    : "iOS Simulator";
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
    setSessionDetailsOpen(false);
  }, [sessionKey]);

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

  const refreshSimulatorStatus = useCallback(() => {
    setActionError(null);
    listQuery.refresh();
    statusQuery.refresh();
  }, [listQuery.refresh, statusQuery.refresh]);

  const acquireDevice = useCallback(
    async (udid: string): Promise<boolean> => {
      const result = await acquire({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          udid: SimulatorUdid.make(udid),
        },
      });
      if (result._tag === "Failure") {
        setActionError(commandErrorMessage(result));
        return false;
      }
      statusQuery.refresh();
      listQuery.refresh();
      return true;
    },
    [acquire, listQuery.refresh, statusQuery.refresh, threadRef.environmentId, threadRef.threadId],
  );

  const handleAcquire = useCallback(async () => {
    if (!selectedDevice || actionPending || state !== "idle") return;
    setActionError(null);
    setActionPending(true);
    await acquireDevice(selectedDevice.udid);
    setActionPending(false);
  }, [acquireDevice, actionPending, selectedDevice, state]);

  const handleRelease = useCallback(async () => {
    if (!session || actionPending) return;
    setActionError(null);
    setActionPending(true);
    await releaseActiveInput();
    await releaseLease(session, true);
    setActionPending(false);
  }, [actionPending, releaseActiveInput, releaseLease, session]);

  const handleOpenNative = useCallback(async () => {
    if (!session || session.state !== "ready" || actionPending) return;
    setActionError(null);
    setActionPending(true);
    const result = await openNative({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        leaseId: session.leaseId,
        generation: session.generation,
      },
    });
    setActionPending(false);
    if (result._tag === "Failure") setActionError(commandErrorMessage(result));
  }, [actionPending, openNative, session, threadRef.environmentId, threadRef.threadId]);

  const handleRetry = useCallback(async () => {
    if (actionPending) return;
    if (!session) {
      refreshSimulatorStatus();
      return;
    }
    setActionError(null);
    setActionPending(true);
    await releaseActiveInput();
    const released = await releaseLease(session, true);
    if (released) await acquireDevice(session.udid);
    setActionPending(false);
  }, [
    acquireDevice,
    actionPending,
    refreshSimulatorStatus,
    releaseActiveInput,
    releaseLease,
    session,
  ]);

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

  const handleReconnectStream = useCallback(() => {
    if (!streamUrl) {
      setActionError("This Simulator session does not have a live stream yet.");
      return;
    }
    if (streamRetryTimer.current !== null) {
      window.clearTimeout(streamRetryTimer.current);
      streamRetryTimer.current = null;
    }
    setActionError(null);
    setStreamState("connecting");
    setStreamAttempt((attempt) => attempt + 1);
    statusQuery.refresh();
  }, [statusQuery.refresh, streamUrl]);

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
      <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
          {state === "loading" ? (
            <section className="flex items-center gap-2 rounded-lg border border-border/80 bg-card p-3 text-sm text-muted-foreground">
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
              <Button
                className="mt-3"
                variant="destructive-outline"
                size="xs"
                onClick={refreshSimulatorStatus}
              >
                Retry
              </Button>
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
                    {session ? `Couldn’t start ${sessionDeviceLabel}` : "Simulator unavailable"}
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
                  disabled={actionPending}
                  onClick={() => void handleRetry()}
                >
                  {actionPending ? "Retrying…" : "Retry"}
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
              {state === "idle" ? (
                <section
                  className="rounded-lg border border-border/80 bg-card p-3"
                  data-simulator-idle
                >
                  {devices.length > 0 ? (
                    <>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <select
                          id="simulator-device"
                          aria-label="Simulator device"
                          value={selectedUdid}
                          onChange={(event) => {
                            setSelectedUdid(event.target.value);
                            setActionError(null);
                          }}
                          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                          disabled={actionPending}
                        >
                          {devices.map((device) => (
                            <option key={device.udid} value={device.udid}>
                              {device.name} · {device.runtime}
                            </option>
                          ))}
                        </select>
                        <Button
                          size="sm"
                          disabled={actionPending || selectedDevice === null}
                          onClick={() => void handleAcquire()}
                        >
                          {actionPending ? "Starting…" : "Start"}
                        </Button>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Start a private device for this thread; other threads wait while it is in
                        use.
                      </p>
                    </>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        No iOS Simulators are available on this host.
                      </p>
                      <Button variant="outline" size="xs" onClick={refreshSimulatorStatus}>
                        Retry
                      </Button>
                    </div>
                  )}
                </section>
              ) : null}

              {state === "queued" || state === "starting" ? (
                <section
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/80 bg-card p-3"
                  data-simulator-pending
                >
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium text-foreground">
                      {state === "queued"
                        ? "Waiting for Simulator"
                        : `Starting ${sessionDeviceLabel}…`}
                    </h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {state === "queued"
                        ? `Queue position ${session?.queuePosition ?? "—"}. This device starts when the current session releases it.`
                        : "Booting the device and connecting its screen."}
                    </p>
                  </div>
                  {session ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={actionPending}
                      onClick={() => void handleRelease()}
                    >
                      {actionPending ? "Canceling…" : "Cancel"}
                    </Button>
                  ) : null}
                </section>
              ) : null}

              {state === "ready" && session ? (
                <section
                  className="overflow-hidden rounded-lg border border-border/80 bg-card"
                  data-simulator-session
                >
                  <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2">
                    <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
                      {sessionDeviceLabel}
                    </h3>
                    <div className="flex shrink-0 items-center gap-1">
                      <span
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
                        aria-live="polite"
                      >
                        <CircleCheck className="size-3.5" aria-hidden />
                        Ready
                      </span>
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Simulator actions"
                              title="Simulator actions"
                            />
                          }
                        >
                          <EllipsisIcon aria-hidden className="size-4" />
                        </MenuTrigger>
                        <MenuPopup align="end" className="w-52">
                          <MenuItem
                            disabled={!streamUrl || actionPending}
                            onClick={handleReconnectStream}
                          >
                            <RefreshCw aria-hidden />
                            Reconnect stream
                          </MenuItem>
                          <MenuItem
                            disabled={actionPending}
                            onClick={() => void handleOpenNative()}
                          >
                            <ExternalLinkIcon aria-hidden />
                            Open in Simulator.app
                          </MenuItem>
                          <MenuItem onClick={() => setSessionDetailsOpen((open) => !open)}>
                            <InfoIcon aria-hidden />
                            {sessionDetailsOpen ? "Hide session details" : "Session details"}
                          </MenuItem>
                          <MenuItem onClick={() => copyToClipboard(session.udid)}>
                            <CopyIcon aria-hidden />
                            {hasCopiedDeviceId ? "Device ID copied" : "Copy device ID"}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            variant="destructive"
                            disabled={actionPending}
                            onClick={() => void handleRelease()}
                          >
                            <CircleX aria-hidden />
                            {actionPending ? "Releasing device…" : "Release device"}
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </div>
                  </div>

                  <div className="p-2 sm:p-3">
                    <div
                      className="relative mx-auto w-full overflow-hidden rounded-xl border border-border/70 bg-black shadow-inner"
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
                              ? "Stream unavailable"
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

                    <div className="mt-2 flex items-center justify-center gap-1 rounded-md bg-muted/50 p-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Rotate Simulator counterclockwise"
                        title="Rotate counterclockwise"
                        disabled={!controlsEnabled}
                        onClick={() => rotate("counterclockwise")}
                      >
                        <RotateCcw aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Go to Simulator Home screen"
                        title="Home"
                        disabled={!controlsEnabled}
                        onClick={sendHome}
                      >
                        <Home aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Rotate Simulator clockwise"
                        title="Rotate clockwise"
                        disabled={!controlsEnabled}
                        onClick={() => rotate("clockwise")}
                      >
                        <RotateCw aria-hidden />
                      </Button>
                    </div>

                    <Collapsible open={sessionDetailsOpen} onOpenChange={setSessionDetailsOpen}>
                      <CollapsiblePanel>
                        <dl className="mt-2 grid gap-1.5 border-t border-border/70 pt-2">
                          <DetailRow label="Device ID" value={session.udid} code />
                          <DetailRow label="Lease" value={session.leaseId} code />
                          <DetailRow label="Generation" value={String(session.generation)} code />
                        </dl>
                      </CollapsiblePanel>
                    </Collapsible>
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
