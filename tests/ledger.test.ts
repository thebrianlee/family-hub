import { describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { isoToday, logLevelUp, redeemReward, selectGoal, tickChecklist } from "@/lib/queries";

function balance(kid: string): number {
  return (getDb().prepare("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=?").get(kid) as { s: number }).s;
}

function count(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { c: number }).c;
}

function addJob(kid: string, dueDate: string | null, days: string | null = null): number {
  const res = getDb()
    .prepare(
      "INSERT INTO checklist_templates (kid, label, emoji, points, sort, bucket, type, due_date, days) VALUES (?, 'Wash car', '🚗', 10, 99, 'afternoon', 'job', ?, ?)"
    )
    .run(kid, dueDate, days ?? "0123456");
  return Number(res.lastInsertRowid);
}

/** Make a statement fail inside SQLite itself, for one test. */
function withFailingTrigger(name: string, ddl: string, fn: () => void): void {
  const db = getDb();
  db.exec(`CREATE TEMP TRIGGER ${name} ${ddl}`);
  try {
    fn();
  } finally {
    db.exec(`DROP TRIGGER ${name}`);
  }
}

// Riley and Quinn each have a seeded "Practice" routine in the afternoon
// bucket that these tests never tick, so ticking an afternoon job never
// completes the bucket and never adds a bucket bonus.

describe("one-off jobs", () => {
  it("pay once, even when the earlier completion was on another day", () => {
    const id = addJob("riley", "2000-01-01");
    const before = balance("riley");
    expect(tickChecklist("riley", id)).toMatchObject({ ok: true, earned: 10, allDoneBonus: 0 });
    const afterFirst = balance("riley");
    expect(afterFirst).toBe(before + 10);

    // Move the completion into the past, as if it happened yesterday.
    getDb().prepare("UPDATE checklist_completions SET date='2000-01-02' WHERE template_id=?").run(id);
    expect(tickChecklist("riley", id)).toEqual({ ok: false });
    expect(balance("riley")).toBe(afterFirst);
  });

  it("answer a second tap on the same day with alreadyDone, and pay nothing more", () => {
    const id = addJob("quinn", isoToday());
    const before = balance("quinn");
    expect(tickChecklist("quinn", id)).toMatchObject({ ok: true, earned: 10, allDoneBonus: 0 });
    expect(balance("quinn")).toBe(before + 10);

    expect(tickChecklist("quinn", id)).toEqual({ ok: true, alreadyDone: true });
    expect(balance("quinn")).toBe(before + 10);
    expect(count("SELECT COUNT(*) c FROM checklist_completions WHERE template_id=?", id)).toBe(1);
  });

  it("do not pay before their due date", () => {
    const id = addJob("quinn", "2999-01-01");
    const before = balance("quinn");
    expect(tickChecklist("quinn", id)).toEqual({ ok: false });
    expect(balance("quinn")).toBe(before);
  });

  it("weekly jobs pay only on their days", () => {
    const today = String(new Date().getDay());
    const notToday = String((Number(today) + 1) % 7);
    const id = addJob("sam", null, notToday);
    const before = balance("sam");
    expect(tickChecklist("sam", id)).toEqual({ ok: false });
    expect(balance("sam")).toBe(before);
  });
});

describe("level-up sessions", () => {
  const logs = (kid: string) => count("SELECT COUNT(*) c FROM levelup_logs WHERE kid=?", kid);
  const deposits = (kid: string) => count("SELECT COUNT(*) c FROM ledger WHERE kid=? AND source='levelup'", kid);

  it("write the session row and its deposit together", () => {
    const [logsBefore, depositsBefore, balanceBefore] = [logs("riley"), deposits("riley"), balance("riley")];
    expect(logLevelUp("riley", "juggling", null, 20)).toEqual({ isPersonalBest: true, previousBest: 14, earned: 5 });
    expect(logs("riley")).toBe(logsBefore + 1);
    expect(deposits("riley")).toBe(depositsBefore + 1);
    expect(balance("riley")).toBe(balanceBefore + 5);
  });

  it("write neither when the deposit fails", () => {
    const [logsBefore, depositsBefore, balanceBefore] = [logs("quinn"), deposits("quinn"), balance("quinn")];
    withFailingTrigger(
      "fail_levelup_deposit",
      "BEFORE INSERT ON ledger WHEN NEW.source = 'levelup' BEGIN SELECT RAISE(ABORT, 'deposit failed'); END",
      () => {
        expect(() => logLevelUp("quinn", "soccer", 30, null)).toThrow(/deposit failed/);
      }
    );
    expect(logs("quinn")).toBe(logsBefore);
    expect(deposits("quinn")).toBe(depositsBefore);
    expect(balance("quinn")).toBe(balanceBefore);
  });
});

describe("kid-specific rewards", () => {
  it("cannot be selected by another kid", () => {
    const res = getDb()
      .prepare("INSERT INTO rewards (label, emoji, cost, kid) VALUES ('Quinn only', '🎁', 5, 'quinn')")
      .run();
    const id = Number(res.lastInsertRowid);
    expect(selectGoal("sam", id).ok).toBe(false);
    expect(selectGoal("quinn", id).ok).toBe(true);
  });

  it("cannot be redeemed by another kid, even one who can afford it", () => {
    const id = Number(
      getDb().prepare("INSERT INTO rewards (label, emoji, cost, kid) VALUES ('Sam only', '🦖', 6, 'sam')").run()
        .lastInsertRowid
    );
    getDb().prepare("INSERT INTO ledger (kid, amount, source, label) VALUES ('riley', 100, 'test', 'top-up')").run();
    getDb().prepare("INSERT INTO ledger (kid, amount, source, label) VALUES ('sam', 100, 'test', 'top-up')").run();
    const [riley, sam] = [balance("riley"), balance("sam")];

    expect(redeemReward("riley", id)).toEqual({ ok: false, error: "Unknown reward" });
    expect(balance("riley")).toBe(riley);

    expect(redeemReward("sam", id)).toEqual({ ok: true });
    expect(balance("sam")).toBe(sam - 6);
    expect(balance("riley")).toBe(riley);
  });
});

describe("reward redemption", () => {
  it("rolls back the deduction when a later write in the same redemption fails", () => {
    const id = Number(
      getDb().prepare("INSERT INTO rewards (label, emoji, cost) VALUES ('Kite', '🪁', 40)").run().lastInsertRowid
    );
    getDb().prepare("INSERT INTO ledger (kid, amount, source, label) VALUES ('quinn', 100, 'test', 'top-up')").run();
    expect(selectGoal("quinn", id).ok).toBe(true);
    const before = balance("quinn");
    const redeems = () => count("SELECT COUNT(*) c FROM ledger WHERE kid='quinn' AND source='redeem'");
    const redeemsBefore = redeems();

    // Redemption deducts first, then retires the goal. Fail the second write.
    withFailingTrigger(
      "fail_goal_retire",
      "BEFORE UPDATE ON selected_goals BEGIN SELECT RAISE(ABORT, 'goal update failed'); END",
      () => {
        expect(() => redeemReward("quinn", id)).toThrow(/goal update failed/);
      }
    );
    expect(balance("quinn")).toBe(before);
    expect(redeems()).toBe(redeemsBefore);
    expect(count("SELECT COUNT(*) c FROM selected_goals WHERE kid='quinn' AND label='Kite' AND active=1")).toBe(1);

    // Without the failure the same redemption goes through and retires the goal.
    expect(redeemReward("quinn", id)).toEqual({ ok: true });
    expect(balance("quinn")).toBe(before - 40);
    expect(count("SELECT COUNT(*) c FROM selected_goals WHERE kid='quinn' AND label='Kite' AND active=1")).toBe(0);
  });
});
