import type { SimulatorInputEvent, SimulatorOrientation } from "@t3tools/contracts";

export type SimulatorPanelViewState =
  | "loading"
  | "unsupported"
  | "idle"
  | "queued"
  | "starting"
  | "ready"
  | "failed";

export interface ContainedMediaPoint {
  readonly x: number;
  readonly y: number;
}

export interface ContainedMediaPointInput {
  readonly clientX: number;
  readonly clientY: number;
  readonly bounds: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly media: {
    readonly width: number;
    readonly height: number;
  };
}

export interface SimulatorDisplayBounds {
  readonly availableWidth: number;
  readonly availableHeight: number;
  readonly media: {
    readonly width: number;
    readonly height: number;
  };
}

export const SIMULATOR_SCROLL_DELTA_LIMIT = 120;
export type SimulatorDisplayScale = 0.75 | 1 | 1.25 | 1.5 | "fit";

export function fitSimulatorDisplayWidth(input: SimulatorDisplayBounds): number | null {
  const { availableWidth, availableHeight, media } = input;
  if (
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(availableHeight) ||
    !Number.isFinite(media.width) ||
    !Number.isFinite(media.height) ||
    availableWidth <= 0 ||
    availableHeight <= 0 ||
    media.width <= 0 ||
    media.height <= 0
  ) {
    return null;
  }

  return Math.min(availableWidth, availableHeight * (media.width / media.height));
}

export function stepSimulatorDisplayScale(
  current: SimulatorDisplayScale,
  direction: "in" | "out",
  fittedScale = 1,
): SimulatorDisplayScale {
  if (current === "fit") {
    if (direction === "out") {
      if (fittedScale > 1.5) return 1.5;
      if (fittedScale > 1.25) return 1.25;
      if (fittedScale > 1) return 1;
      if (fittedScale > 0.75) return 0.75;
      return "fit";
    }
    if (fittedScale < 0.75) return 0.75;
    if (fittedScale < 1) return 1;
    if (fittedScale < 1.25) return 1.25;
    if (fittedScale < 1.5) return 1.5;
    return "fit";
  }

  if (direction === "in") {
    switch (current) {
      case 0.75:
        return 1;
      case 1:
        return 1.25;
      case 1.25:
        return 1.5;
      case 1.5:
        return 1.5;
    }
  }

  switch (current) {
    case 1.5:
      return 1.25;
    case 1.25:
      return 1;
    case 1:
      return 0.75;
    case 0.75:
      return 0.75;
  }
}

export function deriveSimulatorPanelViewState(input: {
  readonly queryFailed: boolean;
  readonly platformSupported: boolean | null;
  readonly executionReady: boolean | null;
  readonly sessionState: "queued" | "starting" | "ready" | "failed" | null;
}): SimulatorPanelViewState {
  if (input.queryFailed) return "failed";
  if (input.platformSupported === null) return "loading";
  if (!input.platformSupported) return "unsupported";
  if (!input.executionReady) return "failed";
  return input.sessionState ?? "idle";
}

/**
 * Resolves only a server-issued relative stream capability against the active
 * environment. The browser does not attach bearer or DPoP credentials to an
 * image request, so the signed stream path is the complete authorization.
 */
export function resolveSimulatorStreamUrl(
  httpBaseUrl: string | null,
  streamUrl: string | undefined,
): string | null {
  if (!httpBaseUrl || !streamUrl || !streamUrl.startsWith("/") || streamUrl.startsWith("//")) {
    return null;
  }

  try {
    const base = new URL(httpBaseUrl);
    const resolved = new URL(streamUrl, base);
    return resolved.origin === base.origin ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Maps a pointer position to an object-fit: contain frame. Letterboxed areas
 * deliberately return null so a tap in chrome never reaches the device.
 */
export function mapPointToContainedMedia(
  input: ContainedMediaPointInput,
): ContainedMediaPoint | null {
  const { bounds, media } = input;
  if (
    !Number.isFinite(input.clientX) ||
    !Number.isFinite(input.clientY) ||
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    !Number.isFinite(media.width) ||
    !Number.isFinite(media.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    media.width <= 0 ||
    media.height <= 0
  ) {
    return null;
  }

  const scale = Math.min(bounds.width / media.width, bounds.height / media.height);
  const renderedWidth = media.width * scale;
  const renderedHeight = media.height * scale;
  const left = bounds.left + (bounds.width - renderedWidth) / 2;
  const top = bounds.top + (bounds.height - renderedHeight) / 2;
  const x = input.clientX - left;
  const y = input.clientY - top;

  if (x < 0 || y < 0 || x > renderedWidth || y > renderedHeight) return null;

  return {
    x: Math.min(1, Math.max(0, x / renderedWidth)),
    y: Math.min(1, Math.max(0, y / renderedHeight)),
  };
}

const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = {
  KeyA: 0x04,
  KeyB: 0x05,
  KeyC: 0x06,
  KeyD: 0x07,
  KeyE: 0x08,
  KeyF: 0x09,
  KeyG: 0x0a,
  KeyH: 0x0b,
  KeyI: 0x0c,
  KeyJ: 0x0d,
  KeyK: 0x0e,
  KeyL: 0x0f,
  KeyM: 0x10,
  KeyN: 0x11,
  KeyO: 0x12,
  KeyP: 0x13,
  KeyQ: 0x14,
  KeyR: 0x15,
  KeyS: 0x16,
  KeyT: 0x17,
  KeyU: 0x18,
  KeyV: 0x19,
  KeyW: 0x1a,
  KeyX: 0x1b,
  KeyY: 0x1c,
  KeyZ: 0x1d,
  Digit1: 0x1e,
  Digit2: 0x1f,
  Digit3: 0x20,
  Digit4: 0x21,
  Digit5: 0x22,
  Digit6: 0x23,
  Digit7: 0x24,
  Digit8: 0x25,
  Digit9: 0x26,
  Digit0: 0x27,
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  F1: 0x3a,
  F2: 0x3b,
  F3: 0x3c,
  F4: 0x3d,
  F5: 0x3e,
  F6: 0x3f,
  F7: 0x40,
  F8: 0x41,
  F9: 0x42,
  F10: 0x43,
  F11: 0x44,
  F12: 0x45,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ShiftLeft: 0xe1,
  ShiftRight: 0xe5,
};

/** Only known USB HID usages are forwarded from the focused device surface. */
export function hidUsageForKeyboardCode(code: string): number | null {
  return HID_USAGE_BY_CODE[code] ?? null;
}

/** Keeps wheel input finite and small enough to be safe to forward over WS. */
export function clampSimulatorScrollDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(SIMULATOR_SCROLL_DELTA_LIMIT, Math.max(-SIMULATOR_SCROLL_DELTA_LIMIT, value));
}

function isContinuousSimulatorInput(event: SimulatorInputEvent): boolean {
  return (event.type === "touch" && event.phase === "move") || event.type === "scroll";
}

function isSameContinuousSimulatorInput(
  left: SimulatorInputEvent,
  right: SimulatorInputEvent,
): boolean {
  if (left.type === "scroll" && right.type === "scroll") return true;
  return (
    left.type === "touch" &&
    left.phase === "move" &&
    right.type === "touch" &&
    right.phase === "move"
  );
}

/**
 * Keeps the ordered input queue bounded while preserving all discrete input
 * boundaries. Continuous moves are replaceable only within the current run;
 * they never cross a begin/end/key/home/orientation event.
 */
export function enqueueSimulatorInput<T extends { readonly event: SimulatorInputEvent }>(
  queue: T[],
  item: T,
  onReplaced?: (item: T) => void,
): void {
  if (isContinuousSimulatorInput(item.event)) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const existing = queue[index];
      if (existing === undefined) continue;
      if (!isContinuousSimulatorInput(existing.event)) break;
      if (isSameContinuousSimulatorInput(existing.event, item.event)) {
        queue[index] = item;
        onReplaced?.(existing);
        return;
      }
    }
  }
  queue.push(item);
}

function isLandscapeSimulatorOrientation(orientation: SimulatorOrientation): boolean {
  return orientation === "landscape_left" || orientation === "landscape_right";
}

/** Returns the dimensions a rotated Simulator framebuffer will occupy. */
export function simulatorMediaDimensionsForOrientation(input: {
  readonly width: number;
  readonly height: number;
  readonly currentOrientation: SimulatorOrientation;
  readonly nextOrientation: SimulatorOrientation;
}): { readonly width: number; readonly height: number } {
  const currentLandscape = isLandscapeSimulatorOrientation(input.currentOrientation);
  const nextLandscape = isLandscapeSimulatorOrientation(input.nextOrientation);
  if (currentLandscape === nextLandscape) {
    return { width: input.width, height: input.height };
  }
  return { width: input.height, height: input.width };
}

export function nextSimulatorOrientation(
  orientation: SimulatorOrientation,
  direction: "clockwise" | "counterclockwise",
): SimulatorOrientation {
  const order = ["portrait", "landscape_right", "portrait_upside_down", "landscape_left"] as const;
  const index = order.indexOf(orientation);
  const offset = direction === "clockwise" ? 1 : -1;
  return order[(index + offset + order.length) % order.length] ?? "portrait";
}
