import { describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { getKidDay, getTaskValue, isoToday, tickChecklist } from "@/lib/queries";

const today = String(new Date().getDay());
const notToday = String((Number(today) + 1) % 7);

function balance(kid: string): number {
  return (getDb().prepare("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=?").get(kid) as { s: number }).s;
}

function add(kid: string, label: string, bucket: string, type: "routine" | "job", days = "0123456", dueDate: string | null = null): number {
  return Number(
    getDb()
      .prepare(
        "INSERT INTO checklist_templates (kid, label, emoji, points, sort, bucket, type, days, due_date) VALUES (?, ?, '✅', 3, 50, ?, ?, ?, ?)"
      )
      .run(kid, label, bucket, type, days, dueDate).lastInsertRowid
  );
}

/** The kid's seeded routines in a bucket that My Day shows today. */
function shownIds(kid: string, bucket: "morning" | "afternoon" | "evening"): number[] {
  return getKidDay(kid).buckets[bucket].map((i) => i.id);
}

describe("routines on a day they are not scheduled", () => {
  it("are not shown, and a tick pays nothing", () => {
    const id = add("riley", "Piano", "afternoon", "routine", notToday);
    expect(shownIds("riley", "afternoon")).not.toContain(id);
    const before = balance("riley");
    expect(tickChecklist("riley", id)).toEqual({ ok: false });
    expect(balance("riley")).toBe(before);
    expect(getDb().prepare("SELECT COUNT(*) c FROM checklist_completions WHERE template_id=?").get(id)).toEqual({ c: 0 });
  });
});

describe("the bucket bonus", () => {
  it("is paid when every routine shown in the bucket is done, whatever else shares the bucket", () => {
    // Sam's morning: Brush Teeth and Get Dressed (sample seed). Also in the
    // morning bucket, none of them shown in it today:
    add("sam", "Wash the car", "morning", "job", "0123456", "2999-01-01"); // a job due later
    add("sam", "Swim bag", "morning", "routine", notToday); // a routine for another weekday
    add("sam", "Feed the cat", "morning", "job"); // a job due today: it has its own list
    const morning = shownIds("sam", "morning");
    expect(morning).toHaveLength(2);

    const before = balance("sam");
    expect(tickChecklist("sam", morning[0])).toMatchObject({ ok: true, bucketDone: null, allDoneBonus: 0 });
    const bonus = getTaskValue("streak_bonus", 5);
    expect(tickChecklist("sam", morning[1])).toMatchObject({ ok: true, bucketDone: "morning", allDoneBonus: bonus });
    expect(balance("sam")).toBe(before + 2 + 2 + bonus);
  });

  it("is not paid by ticking a job", () => {
    // Quinn's evening routines stay undone; a job in the evening bucket is ticked.
    const job = add("quinn", "Dishes", "evening", "job", "0123456", isoToday());
    expect(tickChecklist("quinn", job)).toMatchObject({ ok: true, earned: 3, bucketDone: null, allDoneBonus: 0 });
  });
});
