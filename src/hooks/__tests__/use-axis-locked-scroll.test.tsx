// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useAxisLockedScroll } from "../use-axis-locked-scroll";

function Strip({ width = 400, client = 100 }: { width?: number; client?: number }) {
  const { ref } = useAxisLockedScroll<HTMLDivElement>();
  return (
    <div
      ref={(el) => {
        if (el) {
          Object.defineProperty(el, "scrollWidth", { value: width, configurable: true });
          Object.defineProperty(el, "clientWidth", { value: client, configurable: true });
        }
        ref.current = el;
      }}
      data-testid="strip"
    >
      <a href="#a">a</a>
    </div>
  );
}

function touch(el: Element, type: string, x: number, y: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "touches", {
    value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
  });
  el.dispatchEvent(ev);
  return ev;
}

describe("useAxisLockedScroll", () => {
  afterEach(() => cleanup());

  it("claims the gesture (preventDefault) once locked horizontally", () => {
    const { getByTestId } = render(<Strip />);
    const el = getByTestId("strip");
    touch(el, "touchstart", 100, 100);
    const move = touch(el, "touchmove", 60, 103);
    expect(move.defaultPrevented).toBe(true);
  });

  it("leaves vertical gestures to the page", () => {
    const { getByTestId } = render(<Strip />);
    const el = getByTestId("strip");
    touch(el, "touchstart", 100, 100);
    const move = touch(el, "touchmove", 103, 60);
    expect(move.defaultPrevented).toBe(false);
  });

  it("does not lock horizontally when there is nothing to scroll", () => {
    const { getByTestId } = render(<Strip width={100} client={100} />);
    const el = getByTestId("strip");
    touch(el, "touchstart", 100, 100);
    const move = touch(el, "touchmove", 40, 100);
    expect(move.defaultPrevented).toBe(false);
  });

  it("ignores sub-threshold jitter before an axis is chosen", () => {
    const { getByTestId } = render(<Strip />);
    const el = getByTestId("strip");
    touch(el, "touchstart", 100, 100);
    const move = touch(el, "touchmove", 98, 101);
    expect(move.defaultPrevented).toBe(false);
  });

  it("keeps the axis locked for the rest of the gesture", () => {
    const { getByTestId } = render(<Strip />);
    const el = getByTestId("strip");
    touch(el, "touchstart", 100, 100);
    touch(el, "touchmove", 103, 60); // locks vertical
    const later = touch(el, "touchmove", 20, 55); // now mostly horizontal
    expect(later.defaultPrevented).toBe(false);
  });
});
