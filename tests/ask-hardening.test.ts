import http from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { setEnabled } from "@/lib/modules";

// A stand-in for the local bridge (bridge/ask-bridge.mjs), reached by the
// route's plain fetch to 127.0.0.1. It records what the hub sent.
type Mode = "answer" | "slow-answer" | "stall-body";
let mode: Mode = "answer";
let hits = 0;
let lastBody: Record<string, unknown> | null = null;
let server: http.Server;
let POST: (req: NextRequest) => Promise<Response>;

const TIMEOUT_MS = 300;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const answer = JSON.stringify({ answer: "Because air scatters blue light.", source: "claude", model: "test" });
      if (mode === "stall-body") {
        // Headers and the start of the body, then nothing: the answer never ends.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"answer":');
        return;
      }
      const send = () => res.writeHead(200, { "Content-Type": "application/json" }).end(answer);
      if (mode === "slow-answer") setTimeout(send, 50);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.BRIDGE_PORT = String((server.address() as AddressInfo).port);
  // Read when the route module loads.
  process.env.ASK_MAX_PER_MINUTE = "1";
  process.env.ASK_MAX_PER_DAY = "100";
  process.env.ASK_TIMEOUT_MS = String(TIMEOUT_MS);
  ({ POST } = await import("@/app/api/ask/route"));
  // Ask is off on a fresh install, and the route checks it as the bridge call starts.
  vi.spyOn(console, "log").mockImplementation(() => {});
  setEnabled({ ask: true }, { actor: "parent" });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  mode = "answer";
  hits = 0;
  lastBody = null;
  forgetUsage();
});

/** Make room under the one-per-minute cap again. */
function forgetUsage() {
  getDb().prepare("DELETE FROM ask_usage").run();
}

function ask(kid = "quinn"): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kid, question: "Why is the sky blue?" }),
    })
  );
}

/** The response, or "hung" when the route has not answered within `ms`. */
function within(ms: number, p: Promise<Response>): Promise<Response | "hung"> {
  return Promise.race([p, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms))]);
}

describe("Ask the Hub cap reservation", () => {
  it("lets only one of two simultaneous questions reach the bridge when the cap is one a minute", async () => {
    mode = "slow-answer";
    const results = await Promise.all([ask(), ask()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(hits).toBe(1);
    expect((getDb().prepare("SELECT COUNT(*) c FROM ask_usage").get() as { c: number }).c).toBe(1);
  });
});

describe("Ask the Hub bridge deadline", () => {
  it("covers reading the body: a bridge that stalls mid-answer times out and frees its slot", async () => {
    mode = "stall-body";
    // Two stalled answers would take both concurrency slots for good if the
    // deadline stopped at the headers.
    for (let i = 0; i < 2; i++) {
      forgetUsage();
      const started = Date.now();
      const res = await within(TIMEOUT_MS + 3000, ask());
      expect(res).not.toBe("hung");
      expect((res as Response).status).toBe(503);
      expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    }
    expect(hits).toBe(2);

    // Both slots are free again: the next question reaches the bridge.
    forgetUsage();
    mode = "answer";
    const next = await within(3000, ask());
    expect(next).not.toBe("hung");
    expect((next as Response).status).toBe(200);
    expect(hits).toBe(3);
  });
});

describe("what the model is told about the child", () => {
  it.each([
    ["sam", "under 6", true],
    ["quinn", "8-12", false],
    ["riley", "8-12", false],
  ])("%s: an age band (%s), never the exact age", async (kid, band, preReader) => {
    const res = await ask(kid);
    expect(res.status).toBe(200);
    expect(lastBody?.member).toEqual({ ageBand: band, preReader });
    expect(JSON.stringify(lastBody)).not.toMatch(/"age"/);
  });

  it.each([
    [6, "6-7"],
    [7, "6-7"],
    [12, "8-12"],
    [13, "13 or older"],
    [17, "13 or older"],
  ])("age %i goes out as %s", async (age, band) => {
    getDb().prepare("UPDATE members SET age=? WHERE id='quinn'").run(age);
    const res = await ask("quinn");
    expect(res.status).toBe(200);
    expect(lastBody?.member).toMatchObject({ ageBand: band });
    expect(JSON.stringify(lastBody)).not.toMatch(/"age"/);
  });

  it("a guest question carries no age at all", async () => {
    const res = await ask("nobody");
    expect(res.status).toBe(200);
    expect(lastBody?.member).toEqual({ preReader: false });
  });
});
