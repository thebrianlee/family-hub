// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A member with no photo yet must show their initial, never the browser's
// broken-image icon. On a real screen the photo request can 404 before React
// attaches its error handler, so the error event is never seen; the avatar
// must notice an image that already finished with no picture.

vi.mock("@/components/MembersProvider", () => ({
  useMembers: () => ({ byId: { mia: { name: "Mia" }, alex: { name: "Alex" } } }),
}));

const { default: Avatar } = await import("@/components/Avatar");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

// Pretend every image has already finished loading, with or without a picture.
function imagesFinished(naturalWidth: number | null) {
  const proto = HTMLImageElement.prototype;
  if (naturalWidth === null) {
    vi.spyOn(proto, "complete", "get").mockReturnValue(false);
    vi.spyOn(proto, "naturalWidth", "get").mockReturnValue(0);
  } else {
    vi.spyOn(proto, "complete", "get").mockReturnValue(true);
    vi.spyOn(proto, "naturalWidth", "get").mockReturnValue(naturalWidth);
  }
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = (member: string) => act(() => root.render(createElement(Avatar, { member })));

describe("Avatar", () => {
  it("shows the initial when the photo already failed before React saw it", () => {
    imagesFinished(0);
    render("mia");
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("M");
  });

  it("keeps a photo that already loaded", () => {
    imagesFinished(320);
    render("mia");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/api/avatars/mia.jpg");
  });

  it("shows the initial when a photo still loading then fails", () => {
    imagesFinished(null);
    render("mia");
    const img = host.querySelector("img")!;
    expect(img).not.toBeNull();
    act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(host.querySelector("img")).toBeNull();
  });

  it("tries the next member's photo after one member had none", () => {
    imagesFinished(0);
    render("mia");
    expect(host.querySelector("img")).toBeNull();
    vi.restoreAllMocks();
    imagesFinished(null);
    render("alex");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/api/avatars/alex.jpg");
    expect(host.textContent).toBe("A");
  });
});
