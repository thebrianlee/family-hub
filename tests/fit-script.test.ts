// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { FIT_SCRIPT } from "../src/app/fit-script";

// Runs the inline head script at a given screen size and reads what it set.
function fitAt(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  new Function(FIT_SCRIPT)();
  const root = document.documentElement;
  return { fit: Number(root.style.getPropertyValue("--fit")), phone: root.dataset.phone };
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.phone;
});

describe("FIT_SCRIPT", () => {
  it("leaves the design-target screens at full size", () => {
    expect(fitAt(1440, 2560)).toEqual({ fit: 1, phone: "0" });
    expect(fitAt(1080, 1920)).toEqual({ fit: 1, phone: "0" });
    expect(fitAt(1920, 1080)).toEqual({ fit: 1, phone: "0" });
  });

  it("scales smaller kiosk screens down by the tighter of width and height", () => {
    expect(fitAt(720, 1280).fit).toBeCloseTo(720 / 1080);
    expect(fitAt(800, 480).fit).toBeCloseTo(800 / 1080);
    expect(fitAt(1024, 600).fit).toBeCloseTo(1024 / 1080);
    expect(fitAt(844, 390).fit).toBeCloseTo(390 / 600);
  });

  it("never scales below half size", () => {
    expect(fitAt(700, 200).fit).toBe(0.5);
  });

  it("switches phones to their own layout instead of scaling", () => {
    expect(fitAt(390, 844)).toEqual({ fit: 1, phone: "1" });
    expect(fitAt(639, 900).phone).toBe("1");
    expect(fitAt(640, 900).phone).toBe("0");
  });

  it("recomputes when the screen is resized or rotated", () => {
    fitAt(1080, 1920);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.dataset.phone).toBe("1");
  });
});
