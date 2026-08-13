// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { useStickyHeaderHeight } from "@/hooks/use-sticky-header-height";

/**
 * Regression: rotating an iOS/Android device must leave the pinned nav
 * geometry consistent. The header publishes --app-header-h; every sticky
 * sub-nav offsets off it. Two failure modes are locked down here:
 *
 *  1. A rotate that changes the safe-area inset (portrait notch padding drops
 *     in landscape) must republish the new height, or every sub-nav sits in
 *     the wrong place until the next resize.
 *  2. iOS routinely drops the trailing `touchend` when the device rotates
 *     mid-gesture. The scroll-jump guard defers writes while `touching`, so a
 *     dropped touchend would pin the stale portrait height permanently.
 */

let observed: (() => void)[] = [];

class FakeResizeObserver {
  constructor(private cb: () => void) {
    observed.push(cb);
  }
  observe() {}
  disconnect() {
    observed = observed.filter((c) => c !== this.cb);
  }
}

function flushResize() {
  for (const cb of [...observed]) cb();
}

let height = 56;

function Harness() {
  const ref = useRef<HTMLElement | null>(null);
  useStickyHeaderHeight(ref);
  return <header ref={ref} data-testid="header" />;
}

function headerVar() {
  return document.documentElement.style.getPropertyValue("--app-header-h");
}

/** Simulate a rotate: new box height, orientationchange, then a frame. */
async function rotate(to: number) {
  height = to;
  await act(async () => {
    window.dispatchEvent(new Event("orientationchange"));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("useStickyHeaderHeight — orientation regression", () => {
  beforeEach(() => {
    observed = [];
    height = 56;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(0), 0) as unknown as number;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ height, width: 390, top: 0, left: 0, right: 390, bottom: height }) as DOMRect,
    );
    document.documentElement.style.removeProperty("--app-header-h");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--app-header-h");
  });

  it("publishes the header height on mount", () => {
    render(<Harness />);
    expect(headerVar()).toBe("56px");
  });

  it("republishes the height after a portrait -> landscape rotate", async () => {
    render(<Harness />);
    expect(headerVar()).toBe("56px");
    // Landscape drops the notch inset, so the padded header gets shorter.
    await rotate(48);
    expect(headerVar()).toBe("48px");
  });

  it("returns to the original offset after rotating back", async () => {
    render(<Harness />);
    await rotate(48);
    await rotate(56);
    expect(headerVar()).toBe("56px");
  });

  it("still applies the new height when touchend is dropped during a rotate", async () => {
    render(<Harness />);
    // Finger down (scrolling) — writes are deferred while touching.
    await act(async () => {
      window.dispatchEvent(new Event("touchstart"));
    });
    height = 48;
    await act(async () => flushResize());
    // Deferred: the sticky offsets must not move mid-gesture.
    expect(headerVar()).toBe("56px");
    // Device rotates; iOS never delivers touchend.
    await rotate(48);
    expect(headerVar()).toBe("48px");
  });

  it("does not defer forever after a rotate swallowed the gesture", async () => {
    render(<Harness />);
    await act(async () => {
      window.dispatchEvent(new Event("touchstart"));
    });
    await rotate(48);
    // A later resize (e.g. safe-area settling) applies immediately because the
    // rotate cleared the stale gesture guard.
    height = 44;
    await act(async () => flushResize());
    expect(headerVar()).toBe("44px");
  });

  it("ignores sub-pixel jitter so offsets stay stable across rotate settling", async () => {
    render(<Harness />);
    height = 56.4;
    await act(async () => flushResize());
    expect(headerVar()).toBe("56px");
  });

  it("reacts to visualViewport resize when orientationchange is absent", async () => {
    const listeners: Record<string, (() => void)[]> = {};
    vi.stubGlobal("visualViewport", {
      addEventListener: (t: string, cb: () => void) => {
        (listeners[t] ??= []).push(cb);
      },
      removeEventListener: (t: string, cb: () => void) => {
        listeners[t] = (listeners[t] ?? []).filter((c) => c !== cb);
      },
    });
    render(<Harness />);
    height = 50;
    await act(async () => {
      for (const cb of listeners["resize"] ?? []) cb();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(headerVar()).toBe("50px");
  });

  it("detaches rotate listeners on unmount", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Harness />);
    expect(add.mock.calls.some(([t]) => t === "orientationchange")).toBe(true);
    unmount();
    expect(remove.mock.calls.some(([t]) => t === "orientationchange")).toBe(true);
  });
});
