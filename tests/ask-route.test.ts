import http from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { setEnabled } from "@/lib/modules";

// A stand-in for the local bridge (bridge/ask-bridge.mjs). The route reaches
// it with a plain fetch to 127.0.0.1, so no real model is involved.
let mode: "error" | "answer" = "error";
let hits = 0;
let server: http.Server;
let POST: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      if (mode === "error") {
        // The bridge took the question but no answer comes back to log.
        res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "upstream" }));
        return;
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ answer: "Because air scatters blue light.", source: "claude", model: "test", latency_ms: 5 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.BRIDGE_PORT = String((server.address() as AddressInfo).port);
  // The caps are read when the route module loads.
  process.env.ASK_MAX_PER_MINUTE = "3";
  process.env.ASK_MAX_PER_DAY = "4";
  ({ POST } = await import("@/app/api/ask/route"));
  // Ask is off on a fresh install, and the route checks it as the bridge call starts.
  vi.spyOn(console, "log").mockImplementation(() => {});
  setEnabled({ ask: true }, { actor: "parent" });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function ask(): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kid: "quinn", question: "Why is the sky blue?" }),
    })
  );
}

const loggedQuestions = () => (getDb().prepare("SELECT COUNT(*) c FROM questions").get() as { c: number }).c;

describe("Ask the Hub caps", () => {
  it("count questions that reached the model even when no answer was logged", async () => {
    mode = "error";
    for (let i = 0; i < 3; i++) {
      const res = await ask();
      expect(res.status).toBe(503);
    }
    expect(hits).toBe(3);
    expect(loggedQuestions()).toBe(0);

    // Per-minute cap reached by questions that never got an answer.
    const capped = await ask();
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: "Lots of questions right now! Try again in a minute." });
    expect(hits).toBe(3);

    // A few minutes later the minute cap has room, and an answer is logged
    // and returned in the same shape as before.
    getDb().prepare("UPDATE ask_usage SET created_at = datetime(created_at, '-5 minutes')").run();
    mode = "answer";
    const answered = await ask();
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ answer: "Because air scatters blue light.", source: "claude" });
    expect(hits).toBe(4);
    expect(loggedQuestions()).toBe(1);

    // The day cap (4) counts the three unanswered questions too.
    const dayCapped = await ask();
    expect(dayCapped.status).toBe(429);
    expect(await dayCapped.json()).toEqual({
      error: "That's all the questions for today. Ask a grown-up, or try tomorrow!",
    });
    expect(hits).toBe(4);
  });
});
