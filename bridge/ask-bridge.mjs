import http from "node:http";
import { timingSafeEqual } from "node:crypto";

import { isValidSecret } from "../scripts/secret-file.mjs";
import { GENERATOR_RULES, SAFETY, SPARK_RULES } from "./prompt.mjs";

const host = process.env.BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.BRIDGE_PORT || 8787);
const token = process.env.BRIDGE_TOKEN || "";
const allowLan = process.env.BRIDGE_ALLOW_LAN === "1";

if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
  if (!allowLan) {
    console.error("Refusing to bind the assistant bridge off localhost. Set BRIDGE_ALLOW_LAN=1 only if you accept that risk.");
    process.exit(1);
  }
  if (!isValidSecret(token, 16)) {
    console.error("BRIDGE_ALLOW_LAN requires a BRIDGE_TOKEN of at least 16 printable ASCII characters with no spaces.");
    process.exit(1);
  }
}

if (!isValidSecret(token, 16)) {
  console.error(
    "BRIDGE_TOKEN must be at least 16 printable ASCII characters with no spaces. The web app will keep running, but Ask the Hub stays offline."
  );
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      send(res, 401, { error: "Unauthorized" });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, { ok: true, provider: providerName() });
      return;
    }
    if (req.method === "POST" && (req.url === "/ask" || req.url === "/generate")) {
      const body = await readBody(req);
      const reply = req.url === "/generate" ? await generate(body) : await answer(body);
      send(res, 200, reply);
      return;
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bridge error";
    send(res, 400, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`Ask the Hub bridge listening on ${host}:${port}`);
});

function authorized(req) {
  const header = req.headers.authorization || "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(got);
  const right = Buffer.from(token);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 80_000) {
        reject(new Error("Question is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Expected JSON."));
      }
    });
    req.on("error", reject);
  });
}

// The app sends an age band, never the exact age (src/app/api/ask/route.ts).
const AGE_BANDS = new Set(["under 6", "6-7", "8-12", "13 or older"]);

function kidSystem(member) {
  const name = String(member?.name || "a child").slice(0, 40);
  const band = AGE_BANDS.has(member?.ageBand) ? member.ageBand : null;
  if (member?.preReader === true || band === "under 6") {
    return `${SAFETY}\nYou are talking to ${name}, who is very young and may not read yet. A grown-up may read this aloud. Use very short, playful sentences. Two or three sentences at most.`;
  }
  if (band === "6-7") {
    return `${SAFETY}\nYou are talking to ${name}, who is 6 or 7 years old. Use simple, concrete language and everyday comparisons. Two to four short sentences.`;
  }
  if (band) {
    return `${SAFETY}\nYou are talking to ${name}, aged ${band}. Real explanations are fine if you briefly explain big words. Three to six sentences.`;
  }
  return `${SAFETY}\nYou are talking to a child in the household. Keep it simple and friendly. Two to four sentences.`;
}

async function answer(body) {
  if (body.mode === "spark") {
    const text = await complete(SPARK_RULES, "Write today's family prompt.");
    return text;
  }
  const question = String(body.question || "").trim().slice(0, 2000);
  if (!question) throw new Error("Missing question.");
  const started = Date.now();
  const reply = await complete(kidSystem(body.member), `Question:\n${question}`);
  return {
    ...reply,
    source: reply.provider === "anthropic" ? "claude" : reply.provider,
    model: process.env.ANTHROPIC_MODEL || process.env.OLLAMA_MODEL || "none",
    latency_ms: Date.now() - started,
  };
}

async function generate(body) {
  const days = Array.isArray(body.days) ? body.days.map((day) => String(day)).slice(0, 7) : [];
  const avoid = Array.isArray(body.avoid) ? body.avoid.map((item) => String(item)).slice(0, 120) : [];
  if (!days.length) return { days: [] };
  const reply = await complete(
    GENERATOR_RULES,
    `Generate content for these dates: ${days.join(", ")}.\nDo not use these quotes:\n${avoid.join("\n")}`,
  );
  if (reply.provider === "offline") return { days: [] };
  try {
    const text = reply.answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(text);
    return { days: Array.isArray(parsed.days) ? parsed.days : [] };
  } catch {
    return { days: [] };
  }
}

async function complete(system, user) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return { provider: "anthropic", answer: await claude(system, user) };
    } catch (error) {
      if (!process.env.OLLAMA_URL) {
        return { provider: "offline", answer: `Claude did not answer (${safeError(error)}). Nothing was sent anywhere else.` };
      }
    }
  }
  if (process.env.OLLAMA_URL) {
    try {
      return { provider: "ollama", answer: await ollama(system, user) };
    } catch (error) {
      return { provider: "offline", answer: `Ollama did not answer (${safeError(error)}).` };
    }
  }
  return {
    provider: "offline",
    answer:
      "Ask the Hub is not connected to a model yet. A parent can add an Anthropic API key or an Ollama address in the environment. Your question was saved.",
  };
}

async function claude(system, user) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(40_000),
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const body = await response.json();
  const text = (body.content || []).map((block) => block.text || "").join("\n").trim();
  if (!text) throw new Error("empty reply");
  return text.slice(0, 4000);
}

async function ollama(system, user) {
  const base = String(process.env.OLLAMA_URL).replace(/\/$/, "");
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OLLAMA_URL must be http or https");
  }
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    signal: AbortSignal.timeout(40_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || "llama3.2",
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const body = await response.json();
  const text = String(body.message?.content || "").trim();
  if (!text) throw new Error("empty reply");
  return text.slice(0, 4000);
}

function providerName() {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OLLAMA_URL) return "ollama";
  return "offline";
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "request failed";
  return message.replace(/sk-[a-zA-Z0-9_-]+/g, "key").slice(0, 120);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}
