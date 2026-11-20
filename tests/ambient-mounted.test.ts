// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The screensaver as it runs on a wall screen, mounted in a DOM. A screen that
// was unlocked and stays open can lose its unlock (the 30 days ran out, or the
// PIN changed). From then on the household slides it loaded must never show:
// neither from the moon button nor from the idle timer. The hub's 401 must
// send it to /unlock instead.

const { goToUnlock } = vi.hoisted(() => ({ goToUnlock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/ModulesProvider", () => ({ useModules: () => ({ isOn: () => false }) }));
vi.mock("@/lib/unlock-redirect", () => ({ goToUnlock, unlockUrl: () => "/unlock" }));

const { default: Ambient } = await import("@/components/Ambient");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = (idleMinutes: number) => ({
  photos: ["/photos/family.jpg"],
  art: [],
  quotes: [{ kind: "rule", text: "We are kind." }],
  idleMinutes,
  sleepStart: "00:00",
  sleepEnd: "00:00",
  hardwareSleep: true,
});
const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const locked = () => answer(401, { error: "Unlock this screen with the parent PIN" });

let root: Root;
let host: HTMLDivElement;
let saverSeen: boolean;
let observer: MutationObserver;

const overlay = () => host.querySelector('[class*="z-[90]"]');
const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(Ambient, null, createElement("p", null, "the wall")));
  });
  await flush();
}

beforeEach(() => {
  goToUnlock.mockReset();
  saverSeen = false;
  observer = new MutationObserver(() => {
    if (overlay()) saverSeen = true;
  });
});

afterEach(async () => {
  observer.disconnect();
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Ambient on a screen that loses its unlock", () => {
  it("the moon button never shows the cached slides: it waits for the answer, and a 401 goes to /unlock", async () => {
    let answerSecond: (v: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(200, settings(10))) // on mount, still unlocked
      .mockReturnValueOnce(new Promise((resolve) => (answerSecond = resolve))); // the moon button
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    observer.observe(host, { subtree: true, childList: true });

    await act(async () => {
      window.dispatchEvent(new CustomEvent("sproutwall:sleep"));
    });
    await flush();
    expect(overlay()).toBeNull(); // still waiting for the hub

    answerSecond(locked());
    await flush();
    expect(saverSeen).toBe(false);
    expect(overlay()).toBeNull();
    expect(goToUnlock).toHaveBeenCalledOnce();
  });

  it("the moon button still works on an unlocked screen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer(200, settings(10))));
    await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("sproutwall:sleep"));
    });
    await flush();
    expect(overlay()).not.toBeNull();
    expect(goToUnlock).not.toHaveBeenCalled();
  });

  it("the idle screensaver asks first, and a 401 goes to /unlock without the slides", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(200, settings(1))) // on mount, still unlocked
      .mockResolvedValueOnce(locked()); // when idle: the unlock is gone
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    observer.observe(host, { subtree: true, childList: true });

    await act(async () => {
      vi.advanceTimersByTime(65_000); // past one idle minute, several 5 s ticks
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(saverSeen).toBe(false);
    expect(overlay()).toBeNull();
    expect(goToUnlock).toHaveBeenCalledOnce();
  });

  it("a stalled request gives up after 5 s instead of holding the screensaver back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(200, settings(10))) // on mount
      .mockReturnValueOnce(new Promise(() => {})); // the moon button: never answers
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("sproutwall:sleep"));
    });
    await flush();
    expect(overlay()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flush();
    expect(overlay()).not.toBeNull(); // the slides it already had, from an unlocked screen
    expect(goToUnlock).not.toHaveBeenCalled();
  });
});
