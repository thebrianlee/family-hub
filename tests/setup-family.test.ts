import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { POST as balancePost } from "@/app/api/balance/route";
import { POST as eventsPost } from "@/app/api/events/route";
import { GET as levelupGet, POST as levelupPost } from "@/app/api/levelup/route";
import { GET as mydayGet, POST as mydayPost } from "@/app/api/myday/route";
import { POST as templatesPost } from "@/app/api/myday/templates/route";
import { GET as progressGet } from "@/app/api/progress/route";
import { GET as readingGet, POST as readingPost } from "@/app/api/reading/route";
import { POST as setupPost } from "@/app/api/setup/route";
import { POST as statusPost } from "@/app/api/status/route";
import { getDb } from "@/lib/db";
import { getMembers, isKidId, isMemberId } from "@/lib/household";
import { getSetting, setSetting } from "@/lib/queries";

const HOST = "hub.home:3847";
const PIN = "5938";
const SAMPLE_IDS = ["riley", "quinn", "sam", "avery", "jordan"];

function req(path: string, body?: unknown) {
  const headers = new Headers({ host: HOST, origin: `http://${HOST}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`http://${HOST}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function count(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { c: number }).c;
}

let familyWide: Record<string, number>;

beforeAll(async () => {
  // A sample-family calendar link set before setup must not survive it.
  setSetting("ics_url_avery", "https://calendar.example/avery.ics");
  // A "guest" question is member-keyed sample data too.
  getDb()
    .prepare("INSERT INTO questions (kid, question, answer, source, model) VALUES ('guest', 'Why?', 'Because.', 'claude', 'x')")
    .run();
  familyWide = {
    task_values: count("SELECT COUNT(*) c FROM task_values"),
    rewards: count("SELECT COUNT(*) c FROM rewards WHERE kid IS NULL"),
    rules: count("SELECT COUNT(*) c FROM family_rules"),
    meals: count("SELECT COUNT(*) c FROM meal_defaults"),
    lists: count("SELECT COUNT(*) c FROM lists"),
    task_box: count("SELECT COUNT(*) c FROM task_box"),
  };
  // Make sure the sample family really has data everywhere before replacing it.
  getDb().prepare("INSERT INTO rewards (label, emoji, cost, kid) VALUES ('Quinn only', '🎁', 5, 'quinn')").run();
  getDb().prepare("INSERT INTO mood_logs (kid, date, mood) VALUES ('sam', '2026-01-01', 'good')").run();
  getDb().prepare("INSERT INTO wall_events (group_id, member, title, date) VALUES ('g1', 'jordan', 'Sample', '2026-01-01')").run();
  getDb().prepare("INSERT INTO synced_events (id, member, title, date) VALUES ('avery:1', 'avery', 'Sample', '2026-01-01')").run();
  getDb().prepare("INSERT INTO reward_requests (kid, label) VALUES ('riley', 'Kite')").run();
  getDb().prepare("INSERT INTO selected_goals (kid, label, cost) VALUES ('riley', 'Kite', 10)").run();
  const t = getDb().prepare("SELECT id FROM checklist_templates WHERE kid='riley' LIMIT 1").get() as { id: number };
  getDb().prepare("INSERT INTO checklist_completions (template_id, kid, date) VALUES (?, 'riley', '2026-01-01')").run(t.id);
  const b = getDb().prepare("SELECT id FROM books WHERE kid='quinn' LIMIT 1").get() as { id: number };
  getDb().prepare("INSERT INTO book_notes (book_id, kid, answer) VALUES (?, 'quinn', 'Loved it')").run(b.id);

  const res = await setupPost(
    req("/api/setup", {
      pin: PIN,
      familyName: "The Okafor family",
      greeting: "Okafors",
      currency: "Stars",
      timezone: "America/Chicago",
      latitude: "39.10",
      longitude: "-94.58",
      household: {
        mode: "custom",
        kids: [
          { name: "Mila", age: 9, preReader: false, color: "#C2738A" },
          { name: "Théo", age: 4, preReader: true, color: "#4E978F" },
        ],
        parents: [{ name: "Dana", color: "#5E7B86" }],
      },
    })
  );
  expect(res.status).toBe(200);
});

describe("setup option B: Set up my family", () => {
  it("replaces the sample family with the new members", () => {
    expect(getSetting("setup_complete")).toBe("1");
    expect(getMembers()).toEqual([
      { id: "mila", name: "Mila", role: "kid", age: 9, preReader: false, color: "#C2738A" },
      { id: "theo", name: "Théo", role: "kid", age: 4, preReader: true, color: "#4E978F" },
      { id: "dana", name: "Dana", role: "parent", age: null, preReader: false, color: "#5E7B86" },
    ]);
    for (const id of SAMPLE_IDS) expect(isMemberId(id)).toBe(false);
  });

  it("leaves no row keyed to a sample member in any table", () => {
    const db = getDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]).map((t) => t.name);
    expect(tables).toContain("members");
    const hits: string[] = [];
    for (const table of tables) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).filter(
        (c) => c.type.toUpperCase() === "TEXT"
      );
      for (const { name: col } of cols) {
        const n = count(`SELECT COUNT(*) c FROM ${table} WHERE lower(${col}) IN (${SAMPLE_IDS.map(() => "?").join(",")})`, ...SAMPLE_IDS);
        if (n) hits.push(`${table}.${col}: ${n}`);
      }
    }
    expect(hits).toEqual([]);
    expect(count("SELECT COUNT(*) c FROM settings WHERE key LIKE 'ics_url_%'")).toBe(0);
    // Every member-keyed table only holds the new family now.
    for (const [table, col] of [
      ["checklist_templates", "kid"],
      ["checklist_completions", "kid"],
      ["ledger", "kid"],
      ["books", "kid"],
      ["book_notes", "kid"],
      ["activities", "kid"],
      ["levelup_logs", "kid"],
      ["mood_logs", "kid"],
      ["selected_goals", "kid"],
      ["reward_requests", "kid"],
      ["questions", "kid"],
      ["events", "member"],
      ["synced_events", "member"],
      ["wall_events", "member"],
      ["parent_status", "member"],
      ["rewards", "kid"],
    ]) {
      expect(count(`SELECT COUNT(*) c FROM ${table} WHERE ${col} IS NOT NULL AND ${col} NOT IN ('mila','theo','dana')`), table).toBe(0);
    }
  });

  it("gives each kid a starter routine and each parent a status", () => {
    const rows = getDb()
      .prepare("SELECT kid, label, bucket FROM checklist_templates WHERE active=1 ORDER BY kid, sort")
      .all();
    expect(rows).toEqual([
      { kid: "mila", label: "Brush Teeth", bucket: "morning" },
      { kid: "mila", label: "Make Bed", bucket: "morning" },
      { kid: "mila", label: "Brush Teeth", bucket: "evening" },
      { kid: "theo", label: "Brush Teeth", bucket: "morning" },
      { kid: "theo", label: "Make Bed", bucket: "morning" },
      { kid: "theo", label: "Brush Teeth", bucket: "evening" },
    ]);
    expect(getDb().prepare("SELECT member, status FROM parent_status").all()).toEqual([{ member: "dana", status: "Home" }]);
    expect(count("SELECT COUNT(*) c FROM ledger")).toBe(0);
  });

  it("keeps the family-wide defaults", () => {
    expect({
      task_values: count("SELECT COUNT(*) c FROM task_values"),
      rewards: count("SELECT COUNT(*) c FROM rewards WHERE kid IS NULL"),
      rules: count("SELECT COUNT(*) c FROM family_rules"),
      meals: count("SELECT COUNT(*) c FROM meal_defaults"),
      lists: count("SELECT COUNT(*) c FROM lists"),
      task_box: count("SELECT COUNT(*) c FROM task_box"),
    }).toEqual(familyWide);
    expect(getSetting("family_name")).toBe("The Okafor family");
  });
});

describe("routes after setup check member ids against the database", () => {
  it("refuse the sample ids and unknown ids", async () => {
    expect(isKidId("riley")).toBe(false);
    const refused: [string, Promise<Response>][] = [
      ["myday GET", mydayGet(req("/api/myday?kid=riley"))],
      ["myday POST", mydayPost(req("/api/myday", { kid: "riley", templateId: 1 }))],
      ["myday mood", mydayPost(req("/api/myday", { action: "mood", kid: "nobody", mood: "good" }))],
      ["myday parent as kid", mydayPost(req("/api/myday", { action: "mood", kid: "dana", mood: "good" }))],
      ["templates", templatesPost(req("/api/myday/templates", { kid: "quinn", action: "list" }))],
      ["reading GET", readingGet(req("/api/reading?kid=sam"))],
      ["reading POST", readingPost(req("/api/reading", { kid: "sam", action: "start", title: "X" }))],
      ["levelup GET", levelupGet(req("/api/levelup?kid=riley"))],
      ["levelup POST", levelupPost(req("/api/levelup", { kid: "riley", activity: "soccer", duration_min: 5 }))],
      ["progress", progressGet(req("/api/progress?kid=quinn"))],
      ["balance", balancePost(req("/api/balance", { action: "clear_goal", kid: "riley" }))],
      ["events sample", eventsPost(req("/api/events", { members: ["riley"], title: "X", date: "2026-12-01" }))],
      ["events mixed", eventsPost(req("/api/events", { members: ["mila", "nobody"], title: "X", date: "2026-12-01" }))],
      ["events bad type", eventsPost(req("/api/events", { members: [{ id: "mila" }], title: "X", date: "2026-12-01" }))],
      ["status sample", statusPost(req("/api/status", { pin: PIN, member: "avery", status: "Home" }))],
      ["status kid", statusPost(req("/api/status", { pin: PIN, member: "mila", status: "Home" }))],
    ];
    for (const [name, pending] of refused) {
      expect((await pending).status, name).toBe(400);
    }
  });

  it("accept the new members", async () => {
    expect((await mydayGet(req("/api/myday?kid=mila"))).status).toBe(200);
    const days = await (await mydayGet(req("/api/myday"))).json();
    expect(days.days.map((d: { kid: string }) => d.kid)).toEqual(["mila", "theo"]);
    expect((await mydayPost(req("/api/myday", { action: "mood", kid: "theo", mood: "good" }))).status).toBe(200);
    expect((await eventsPost(req("/api/events", { members: ["mila", "dana"], title: "Zoo", date: "2026-12-01" }))).status).toBe(200);
    expect(count("SELECT COUNT(*) c FROM wall_events WHERE title='Zoo'")).toBe(2);
    expect((await statusPost(req("/api/status", { pin: PIN, member: "dana", status: "Office" }))).status).toBe(200);
    expect(getDb().prepare("SELECT status FROM parent_status WHERE member='dana'").get()).toEqual({ status: "Office" });
    const progress = await (await progressGet(req("/api/progress"))).json();
    expect(progress.all.map((p: { kid: string }) => p.kid)).toEqual(["mila", "theo"]);
  });

  it("a restart keeps the new family and does not bring back sample data", () => {
    getDb().close();
    globalThis.__familyHubDb = undefined;
    expect(getMembers().map((m) => m.id)).toEqual(["mila", "theo", "dana"]);
    expect(count("SELECT COUNT(*) c FROM activities")).toBe(0);
    expect(count("SELECT COUNT(*) c FROM events")).toBe(0);
  });
});
