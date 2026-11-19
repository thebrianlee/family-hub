import { verifyPin } from "./auth";
import { getDb } from "./db";
import { KidId, ParentId, ParentStatus } from "./family";
import { getKids } from "./household";
import { MEAL_TYPE_KEYS } from "./meals";

// ---------- settings ----------

export function getSetting(key: string, fallback = ""): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, value);
}

/**
 * Compare a PIN with the stored hash. No lockout here: every caller goes
 * through attemptPin() in pin-attempts.ts, which rate-limits.
 */
export function pinMatches(pin: string): boolean {
  const stored = getSetting("parent_pin", "");
  const splitAt = stored.indexOf(":");
  const salt = splitAt > 0 ? stored.slice(0, splitAt) : "";
  const hash = splitAt > 0 ? stored.slice(splitAt + 1) : "";
  return Boolean(salt && hash && verifyPin(pin, { salt, hash, updatedAt: "" }));
}

export function getTaskValue(key: string, fallback: number): number {
  const db = getDb();
  const row = db.prepare("SELECT value FROM task_values WHERE key=?").get(key) as { value: number } | undefined;
  return row?.value ?? fallback;
}

// ---------- shared helpers ----------

export function isoToday(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Consecutive-day streak ending today or yesterday. */
export function streakFromDates(dates: string[], today = new Date()): number {
  const set = new Set(dates);
  const cursor = new Date(today);
  const isoOf = (d: Date) => isoToday(d);
  if (!set.has(isoOf(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!set.has(isoOf(cursor))) return 0;
  }
  let streak = 0;
  while (set.has(isoOf(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function deposit(kid: KidId, amount: number, source: string, label: string) {
  if (amount === 0) return;
  getDb().prepare("INSERT INTO ledger (kid, amount, source, label) VALUES (?, ?, ?, ?)").run(kid, amount, source, label);
}

// ---------- Today: parent status + dinner ----------

export function getParentStatuses(): Record<ParentId, ParentStatus> {
  const db = getDb();
  const rows = db.prepare("SELECT member, status FROM parent_status").all() as {
    member: ParentId;
    status: ParentStatus;
  }[];
  return Object.fromEntries(rows.map((r) => [r.member, r.status])) as Record<ParentId, ParentStatus>;
}

export function setParentStatus(member: ParentId, status: ParentStatus): void {
  getDb()
    .prepare(
      "INSERT INTO parent_status (member, status) VALUES (?, ?) ON CONFLICT(member) DO UPDATE SET status=excluded.status"
    )
    .run(member, status);
}

export interface DinnerInfo {
  meal: string;
  emoji: string;
  isOverride: boolean;
}

export function getDinnerFor(dateIso: string, weekday: number): DinnerInfo {
  const db = getDb();
  const ov = db.prepare("SELECT meal, emoji FROM meal_overrides WHERE date=?").get(dateIso) as
    | { meal: string; emoji: string }
    | undefined;
  if (ov) return { meal: ov.meal, emoji: ov.emoji, isOverride: true };
  const def = db.prepare("SELECT meal, emoji FROM meal_defaults WHERE weekday=?").get(weekday) as
    | { meal: string; emoji: string }
    | undefined;
  return def
    ? { meal: def.meal, emoji: def.emoji, isOverride: false }
    : { meal: "Family Choice", emoji: "🍽️", isOverride: false };
}

// ---------- Meals utility ----------

export interface WeekMeal {
  date: string;
  weekday: number;
  dayLabel: string;
  dinner: DinnerInfo;
}

export function getWeekPlan(today = new Date()): WeekMeal[] {
  const out: WeekMeal[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    out.push({
      date: isoToday(d),
      weekday: d.getDay(),
      dayLabel: i === 0 ? "Tonight" : d.toLocaleDateString("en-US", { weekday: "long" }),
      dinner: getDinnerFor(isoToday(d), d.getDay()),
    });
  }
  return out;
}

export function setMealOverride(date: string, meal: string, emoji: string): void {
  getDb()
    .prepare(
      "INSERT INTO meal_overrides (date, meal, emoji) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET meal=excluded.meal, emoji=excluded.emoji"
    )
    .run(date, meal, emoji || "🍽️");
}

export function clearMealOverride(date: string): void {
  getDb().prepare("DELETE FROM meal_overrides WHERE date=?").run(date);
}

export function setMealDefault(weekday: number, meal: string, emoji: string): void {
  getDb()
    .prepare(
      "INSERT INTO meal_defaults (weekday, meal, emoji) VALUES (?, ?, ?) ON CONFLICT(weekday) DO UPDATE SET meal=excluded.meal, emoji=excluded.emoji"
    )
    .run(weekday, meal, emoji || "🍽️");
}

export function getMealDefaults(): { weekday: number; meal: string; emoji: string }[] {
  return getDb().prepare("SELECT weekday, meal, emoji FROM meal_defaults ORDER BY weekday").all() as {
    weekday: number;
    meal: string;
    emoji: string;
  }[];
}

// ---------- Meal grid (breakfast/lunch/dinner/snack × days) ----------

export interface MealCell {
  name: string;
  emoji: string;
  ingredients: string[];
}
export interface MealDay {
  date: string;
  dayLabel: string;
  isToday: boolean;
  slots: Record<string, MealCell | null>;
}

export function getMealWeek(today = new Date()): MealDay[] {
  return getMealDays(isoToday(today), 7);
}

/** N days of the meal grid starting from an ISO date. Powers day/week/month views. */
export function getMealDays(startIso: string, count: number): MealDay[] {
  const db = getDb();
  const todayI = isoToday();
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const out: MealDay[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const date = isoToday(d);
    const rows = db
      .prepare("SELECT slot, name, emoji, ingredients FROM meal_slots WHERE date=?")
      .all(date) as { slot: string; name: string; emoji: string; ingredients: string | null }[];
    const slots: Record<string, MealCell | null> = {};
    for (const key of MEAL_TYPE_KEYS) {
      const r = rows.find((x) => x.slot === key);
      slots[key] = r ? { name: r.name, emoji: r.emoji, ingredients: r.ingredients ? r.ingredients.split("\n").filter(Boolean) : [] } : null;
    }
    // Dinner falls back to the rotating default so the grid isn't empty.
    if (!slots.dinner) {
      const din = getDinnerFor(date, d.getDay());
      slots.dinner = { name: din.meal, emoji: din.emoji, ingredients: [] };
    }
    out.push({
      date,
      dayLabel: date === todayI ? "Today" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
      isToday: date === todayI,
      slots,
    });
  }
  return out;
}

export function setMealSlot(date: string, slot: string, name: string, emoji: string, ingredients: string[]): void {
  if (!MEAL_TYPE_KEYS.includes(slot)) return;
  getDb()
    .prepare(
      "INSERT INTO meal_slots (date, slot, name, emoji, ingredients) VALUES (?, ?, ?, ?, ?) ON CONFLICT(date, slot) DO UPDATE SET name=excluded.name, emoji=excluded.emoji, ingredients=excluded.ingredients"
    )
    .run(date, slot, name.slice(0, 120), emoji || "🍽️", ingredients.length ? ingredients.join("\n") : null);
}
export function clearMealSlot(date: string, slot: string): void {
  getDb().prepare("DELETE FROM meal_slots WHERE date=? AND slot=?").run(date, slot);
}
/** Push a meal's ingredients into the shared grocery list. Returns count added. */
export function addMealSlotToList(date: string, slot: string): number {
  const db = getDb();
  const r = db.prepare("SELECT ingredients FROM meal_slots WHERE date=? AND slot=?").get(date, slot) as
    | { ingredients: string | null }
    | undefined;
  const items = r?.ingredients ? r.ingredients.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  for (const it of items) addGrocery(it);
  return items.length;
}

export interface GroceryItem {
  id: number;
  label: string;
  checked: number;
}

export function getGrocery(): GroceryItem[] {
  return getDb()
    .prepare("SELECT id, label, checked FROM grocery ORDER BY checked, id DESC")
    .all() as GroceryItem[];
}

export function addGrocery(label: string): void {
  // Routes into the named-lists system: the "Groceries" list (or first list).
  const db = getDb();
  const l =
    (db.prepare("SELECT id FROM lists WHERE active=1 AND name='Groceries' LIMIT 1").get() as { id: number } | undefined) ??
    (db.prepare("SELECT id FROM lists WHERE active=1 ORDER BY sort LIMIT 1").get() as { id: number } | undefined);
  if (l) db.prepare("INSERT INTO list_items (list_id, section, label) VALUES (?, 'General', ?)").run(l.id, label);
  else db.prepare("INSERT INTO grocery (label) VALUES (?)").run(label);
}

export function toggleGrocery(id: number): void {
  getDb().prepare("UPDATE grocery SET checked = 1 - checked WHERE id=?").run(id);
}

export function deleteGrocery(id: number): void {
  getDb().prepare("DELETE FROM grocery WHERE id=?").run(id);
}

// ---------- Named lists v2 ----------

export interface ListItemRow {
  id: number;
  label: string;
  checked: boolean;
}
export interface ListSection {
  name: string;
  items: ListItemRow[];
}
export interface NamedList {
  id: number;
  name: string;
  color: string;
  sections: ListSection[];
  open: number;
  done: number;
}

export function getLists(): NamedList[] {
  const db = getDb();
  const lists = db.prepare("SELECT id, name, color FROM lists WHERE active=1 ORDER BY sort, id").all() as {
    id: number;
    name: string;
    color: string;
  }[];
  return lists.map((l) => {
    const items = db
      .prepare("SELECT id, section, label, checked FROM list_items WHERE list_id=? ORDER BY checked, id")
      .all(l.id) as { id: number; section: string; label: string; checked: number }[];
    const map = new Map<string, ListItemRow[]>();
    for (const it of items) {
      const s = it.section || "General";
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push({ id: it.id, label: it.label, checked: !!it.checked });
    }
    const sections = Array.from(map.entries()).map(([name, its]) => ({ name, items: its }));
    const open = items.filter((i) => !i.checked).length;
    return { id: l.id, name: l.name, color: l.color, sections, open, done: items.length - open };
  });
}

export function addList(name: string, color: string): number {
  const db = getDb();
  const max = (db.prepare("SELECT COALESCE(MAX(sort),0) m FROM lists").get() as { m: number }).m;
  return Number(db.prepare("INSERT INTO lists (name, color, sort) VALUES (?, ?, ?)").run(name.slice(0, 40), color, max + 1).lastInsertRowid);
}
export function deleteList(id: number): void {
  const db = getDb();
  db.prepare("UPDATE lists SET active=0 WHERE id=?").run(id);
  db.prepare("DELETE FROM list_items WHERE list_id=?").run(id);
}
export function addListItem(listId: number, section: string, label: string): void {
  getDb()
    .prepare("INSERT INTO list_items (list_id, section, label) VALUES (?, ?, ?)")
    .run(listId, section.trim() ? section.trim().slice(0, 40) : "General", label.slice(0, 100));
}
export function toggleListItem(id: number): void {
  getDb().prepare("UPDATE list_items SET checked = 1 - checked WHERE id=?").run(id);
}
export function deleteListItem(id: number): void {
  getDb().prepare("DELETE FROM list_items WHERE id=?").run(id);
}

// ---------- family rules ----------

// ---------- Ask the Hub ----------

export interface KidQuestion {
  id: number;
  kid: string;
  question: string;
  answer: string;
  source: string;
  model: string;
  created_at: string;
}

export function addQuestion(
  kid: string, question: string, answer: string, source: string, model: string, latencyMs: number
): void {
  getDb()
    .prepare("INSERT INTO questions (kid, question, answer, source, model, latency_ms) VALUES (?,?,?,?,?,?)")
    .run(kid, question, answer, source, model, latencyMs);
}

/**
 * Check the Ask the Hub caps and, if there is room, count this question, as
 * one IMMEDIATE transaction: the write lock is taken before the counts are
 * read, so neither another request nor another process sharing the database
 * can pass the same check before this row is written. Called before the model
 * is asked, so questions that never get an answer logged still cost a slot.
 * Rows older than two days are no longer needed by any cap.
 */
export function reserveAskSlot(perMinute: number, perDay: number): "ok" | "minute" | "day" {
  const db = getDb();
  return db
    .transaction((): "ok" | "minute" | "day" => {
      if (countRecentAsks(1) >= perMinute) return "minute";
      if (countRecentAsks(24 * 60) >= perDay) return "day";
      db.prepare("INSERT INTO ask_usage DEFAULT VALUES").run();
      db.prepare("DELETE FROM ask_usage WHERE created_at < datetime('now', '-2 days')").run();
      return "ok";
    })
    .immediate();
}

/** Questions sent to the model in the last `minutes`, answered or not. */
export function countRecentAsks(minutes: number): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) c FROM ask_usage WHERE created_at >= datetime('now', ?)")
    .get(`-${Math.max(1, Math.floor(minutes))} minutes`) as { c: number };
  return row.c;
}

export function getRecentQuestions(limit = 20): KidQuestion[] {
  return getDb()
    .prepare("SELECT id, kid, question, answer, source, model, created_at FROM questions ORDER BY id DESC LIMIT ?")
    .all(limit) as KidQuestion[];
}

export interface FamilyRule {
  id: number;
  text: string;
  sort: number;
  emoji: string;
}

export function getRules(): FamilyRule[] {
  return getDb()
    .prepare("SELECT id, text, sort, COALESCE(emoji,'📜') emoji FROM family_rules WHERE active=1 ORDER BY sort")
    .all() as FamilyRule[];
}

export function addRule(text: string): void {
  const db = getDb();
  const max = (db.prepare("SELECT COALESCE(MAX(sort),0) m FROM family_rules").get() as { m: number }).m;
  db.prepare("INSERT INTO family_rules (text, sort) VALUES (?, ?)").run(text, max + 1);
}

export function updateRule(id: number, text: string): void {
  getDb().prepare("UPDATE family_rules SET text=? WHERE id=?").run(text, id);
}

export function deleteRule(id: number): void {
  getDb().prepare("UPDATE family_rules SET active=0 WHERE id=?").run(id);
}

// ---------- My Day (bucketed routines) ----------

export type Bucket = "morning" | "afternoon" | "evening";
export const BUCKETS: Bucket[] = ["morning", "afternoon", "evening"];

/** Which bucket the wall auto-focuses on, by local hour. */
export function currentBucket(d = new Date()): Bucket {
  const h = d.getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

export interface ChecklistItem {
  id: number;
  label: string;
  emoji: string;
  points: number;
  bucket: Bucket;
  tracked: boolean;
  unit: string | null;
  metric_label: string | null;
  contribution: boolean;
  detail_kind: "reading" | "levelup" | null;
  type: "routine" | "job";
  freq: string | null; // human label for jobs (Today / By Sat / Weekly / Any day)
  done: boolean;
  amount: number | null;
  streak: number;
}

type TemplateRow = {
  id: number;
  label: string;
  emoji: string;
  points: number;
  bucket: string;
  tracked: number;
  unit: string | null;
  metric_label: string | null;
  contribution: number;
  detail_kind: string | null;
  type: string;
  due_date: string | null;
  days: string | null;
};

const TEMPLATE_COLS =
  "id, label, emoji, points, bucket, tracked, unit, metric_label, contribution, detail_kind, type, due_date, days";

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function jobFreq(t: TemplateRow, today: string): string {
  if (t.due_date) return t.due_date === today ? "Today" : `By ${shortDate(t.due_date)}`;
  const days = t.days ?? "0123456";
  return days === "0123456" ? "Any day" : "Weekly";
}

function toItem(db: ReturnType<typeof getDb>, t: TemplateRow, today: string): ChecklistItem {
  const isOneOffJob = t.type === "job" && !!t.due_date;
  // One-off jobs are "done" once ever; everything else is per-today.
  const done = isOneOffJob
    ? (db.prepare("SELECT amount FROM checklist_completions WHERE template_id=? ORDER BY date DESC LIMIT 1").get(t.id) as { amount: number | null } | undefined)
    : (db.prepare("SELECT amount FROM checklist_completions WHERE template_id=? AND date=?").get(t.id, today) as { amount: number | null } | undefined);
  const dates = (
    db
      .prepare("SELECT date FROM checklist_completions WHERE template_id=? ORDER BY date DESC")
      .all(t.id) as { date: string }[]
  ).map((r) => r.date);
  return {
    id: t.id,
    label: t.label,
    emoji: t.emoji,
    points: t.points,
    bucket: (t.bucket as Bucket) ?? "morning",
    tracked: !!t.tracked,
    unit: t.unit,
    metric_label: t.metric_label,
    contribution: !!t.contribution,
    detail_kind: (t.detail_kind as "reading" | "levelup" | null) ?? null,
    type: t.type === "job" ? "job" : "routine",
    freq: t.type === "job" ? jobFreq(t, today) : null,
    done: done !== undefined,
    amount: done?.amount ?? null,
    streak: streakFromDates(dates),
  };
}

export interface KidDay {
  kid: KidId;
  buckets: Record<Bucket, ChecklistItem[]>;
  jobs: ChecklistItem[];
  mood: string | null;
  earnedToday: number;
}

/**
 * Is an item due today? The one rule for what My Day shows, what a tick pays
 * and what the bucket bonus waits for. Routines: today's weekday is one of
 * their days. One-off jobs: due on/before today and not yet done. Recurring
 * jobs: weekday matches.
 */
function dueToday(db: ReturnType<typeof getDb>, t: TemplateRow, today: string, wd: string): boolean {
  if (t.type === "job" && t.due_date) {
    if (t.due_date > today) return false; // not yet
    const doneEver = db.prepare("SELECT 1 FROM checklist_completions WHERE template_id=? LIMIT 1").get(t.id);
    return !doneEver; // hide once completed
  }
  return (t.days ?? "0123456").includes(wd);
}

/** Today's date and weekday (0=Sun..6=Sat), read from one clock reading. */
function todayAndWeekday(): { today: string; wd: string } {
  const now = new Date();
  return { today: isoToday(now), wd: String(now.getDay()) };
}

export function getKidDay(kid: KidId): KidDay {
  const db = getDb();
  const { today, wd } = todayAndWeekday();
  const rows = db
    .prepare(`SELECT ${TEMPLATE_COLS} FROM checklist_templates WHERE kid=? AND active=1 ORDER BY sort`)
    .all(kid) as TemplateRow[];
  const buckets: Record<Bucket, ChecklistItem[]> = { morning: [], afternoon: [], evening: [] };
  const jobs: ChecklistItem[] = [];
  for (const r of rows) {
    if (!dueToday(db, r, today, wd)) continue;
    const item = toItem(db, r, today);
    if (r.type === "job") jobs.push(item);
    else (buckets[item.bucket] ?? buckets.morning).push(item);
  }
  const earnedToday = (
    db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=? AND amount>0 AND date(created_at)=date('now','localtime')"
      )
      .get(kid) as { s: number }
  ).s;
  return { kid, buckets, jobs, mood: getMood(kid), earnedToday };
}

// ---------- Week view (chore-chart matrix) ----------

export interface WeekRow {
  id: number;
  label: string;
  emoji: string;
  type: "routine" | "job";
  bucket: Bucket;
  done: boolean[]; // Sun..Sat
}
export interface KidWeek {
  kid: KidId;
  dates: string[]; // 7 iso dates, Sun..Sat
  rows: WeekRow[];
  streak: number;
}

export function getKidWeek(kid: KidId): KidWeek {
  const db = getDb();
  const now = new Date();
  const sun = new Date(now);
  sun.setDate(now.getDate() - now.getDay());
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sun);
    d.setDate(sun.getDate() + i);
    dates.push(isoToday(d));
  }
  const tpls = db
    .prepare("SELECT id, label, emoji, type, bucket FROM checklist_templates WHERE kid=? AND active=1 ORDER BY type DESC, sort")
    .all(kid) as { id: number; label: string; emoji: string; type: string; bucket: string }[];
  const rows: WeekRow[] = tpls.map((t) => {
    const doneDates = new Set(
      (
        db
          .prepare("SELECT DISTINCT date FROM checklist_completions WHERE template_id=? AND date>=? AND date<=?")
          .all(t.id, dates[0], dates[6]) as { date: string }[]
      ).map((r) => r.date)
    );
    return {
      id: t.id,
      label: t.label,
      emoji: t.emoji,
      type: t.type === "job" ? "job" : "routine",
      bucket: (t.bucket as Bucket) ?? "morning",
      done: dates.map((d) => doneDates.has(d)),
    };
  });
  const allDates = (
    db.prepare("SELECT DISTINCT date FROM checklist_completions WHERE kid=? ORDER BY date DESC").all(kid) as { date: string }[]
  ).map((r) => r.date);
  return { kid, dates, rows, streak: streakFromDates(allDates) };
}

// ---------- family rhythm (Hearth-style weekly pulse) ----------
// Four dimensions, scored over the current week so far (Sunday..today):
//   rhythm       (35) — % of routine items completed across kid-days
//   participation(25) — % of kid-days where the kid did at least one thing
//   followThrough(20) — % of job items completed (full credit if none assigned)
//   checkIns     (20) — % of kid-days with a mood logged (feeling sad still counts:
//                       the signal is checking in, not being happy)

export interface FamilyRhythm {
  score: number; // 0-100
  label: string;
  dims: { key: string; label: string; emoji: string; pct: number }[];
}

export function getFamilyRhythm(): FamilyRhythm {
  const db = getDb();
  const todayI = isoToday();
  const dayIdx = new Date().getDay(); // days elapsed this week = dayIdx + 1

  let routineDone = 0, routineDue = 0;
  let jobDone = 0, jobDue = 0;
  let activeDays = 0, kidDays = 0;
  let moodDays = 0;

  for (const k of getKids()) {
    const week = getKidWeek(k.id);
    for (let i = 0; i <= dayIdx; i++) {
      kidDays++;
      let didSomething = false;
      for (const r of week.rows) {
        if (r.type === "job") { jobDue++; if (r.done[i]) { jobDone++; didSomething = true; } }
        else { routineDue++; if (r.done[i]) { routineDone++; didSomething = true; } }
      }
      if (didSomething) activeDays++;
    }
    const moods = db
      .prepare("SELECT COUNT(DISTINCT date) c FROM mood_logs WHERE kid=? AND date>=? AND date<=?")
      .get(k.id, week.dates[0], todayI) as { c: number };
    moodDays += Math.min(moods.c, dayIdx + 1);
  }

  const pct = (num: number, den: number, fallback = 1) => (den > 0 ? num / den : fallback);
  const rhythm = pct(routineDone, routineDue);
  const participation = pct(activeDays, kidDays);
  const follow = pct(jobDone, jobDue);
  const checkIns = pct(moodDays, kidDays);

  const score = Math.round(100 * (0.35 * rhythm + 0.25 * participation + 0.2 * follow + 0.2 * checkIns));
  const label = score >= 80 ? "In Rhythm" : score >= 50 ? "Getting There" : "Finding Our Flow";
  return {
    score,
    label,
    dims: [
      { key: "rhythm", label: "Routines", emoji: "🔁", pct: Math.round(rhythm * 100) },
      { key: "participation", label: "Everyone In", emoji: "🙌", pct: Math.round(participation * 100) },
      { key: "follow", label: "Jobs Done", emoji: "🧹", pct: Math.round(follow * 100) },
      { key: "checkins", label: "Check-ins", emoji: "💛", pct: Math.round(checkIns * 100) },
    ],
  };
}

/** Back-compat flat list (used by any older caller). */
export function getChecklist(kid: KidId): ChecklistItem[] {
  const db = getDb();
  const today = isoToday();
  const rows = db
    .prepare(`SELECT ${TEMPLATE_COLS} FROM checklist_templates WHERE kid=? AND active=1 ORDER BY sort`)
    .all(kid) as TemplateRow[];
  return rows.map((r) => toItem(db, r, today));
}

export interface TickResult {
  ok: boolean;
  alreadyDone?: boolean;
  earned?: number;
  streak?: number;
  detail_kind?: "reading" | "levelup" | null;
  bucketDone?: Bucket | null; // bucket that just got fully completed
  allDoneBonus?: number;
}

/** Completion, points and bonus are written together or not at all. */
export function tickChecklist(kid: KidId, templateId: number, amount?: number | null): TickResult {
  return getDb().transaction(() => tickChecklistTx(kid, templateId, amount))();
}

function tickChecklistTx(kid: KidId, templateId: number, amount?: number | null): TickResult {
  const db = getDb();
  const { today, wd } = todayAndWeekday();
  const t = db
    .prepare(`SELECT ${TEMPLATE_COLS} FROM checklist_templates WHERE id=? AND kid=? AND active=1`)
    .get(templateId, kid) as TemplateRow | undefined;
  if (!t) return { ok: false };

  // Checked before the due check: a one-off job done earlier today is no
  // longer "due", but a second tap is still just "already done".
  const exists = db
    .prepare("SELECT 1 FROM checklist_completions WHERE template_id=? AND date=?")
    .get(templateId, today);
  if (exists) return { ok: true, alreadyDone: true };

  // Items pay only when they are due today: a routine or weekly job only on
  // its days, a one-off job once ever. The screen hides them otherwise, but
  // the server is what enforces it.
  if (!dueToday(db, t, today, wd)) return { ok: false };

  const amt = t.tracked && amount != null && Number.isFinite(amount) && amount > 0 ? amount : null;
  db.prepare("INSERT INTO checklist_completions (template_id, kid, date, amount) VALUES (?, ?, ?, ?)").run(
    templateId,
    kid,
    today,
    amt
  );
  deposit(kid, t.points, "myday", t.label);

  // Whole-bucket bonus: every routine My Day shows in this bucket today is
  // done. Jobs have their own list, so they neither complete nor hold up a
  // bucket, and items not due today (another weekday, a later job) don't count.
  let bucketDone: Bucket | null = null;
  let allDoneBonus = 0;
  if (t.type !== "job") {
    const isDone = db.prepare("SELECT 1 FROM checklist_completions WHERE template_id=? AND date=?");
    const remaining = (
      db
        .prepare(`SELECT ${TEMPLATE_COLS} FROM checklist_templates WHERE kid=? AND active=1 AND bucket=? AND type<>'job'`)
        .all(kid, t.bucket) as TemplateRow[]
    ).filter((r) => dueToday(db, r, today, wd) && !isDone.get(r.id, today));
    if (remaining.length === 0) {
      bucketDone = t.bucket as Bucket;
      allDoneBonus = getTaskValue("streak_bonus", 5);
      deposit(kid, allDoneBonus, "streak_bonus", `${capitalize(t.bucket)} routine done!`);
    }
  }

  const dates = (
    db
      .prepare("SELECT date FROM checklist_completions WHERE template_id=? ORDER BY date DESC")
      .all(templateId) as { date: string }[]
  ).map((r) => r.date);

  return {
    ok: true,
    earned: t.points,
    streak: streakFromDates(dates),
    detail_kind: (t.detail_kind as "reading" | "levelup" | null) ?? null,
    bucketDone,
    allDoneBonus,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Mood ----------

export const MOODS = [
  { id: "great", emoji: "😄", label: "Great" },
  { id: "good", emoji: "🙂", label: "Good" },
  { id: "ok", emoji: "😐", label: "Okay" },
  { id: "sad", emoji: "😢", label: "Sad" },
  { id: "mad", emoji: "😠", label: "Mad" },
] as const;

export function getMood(kid: KidId, date = isoToday()): string | null {
  const row = getDb()
    .prepare("SELECT mood FROM mood_logs WHERE kid=? AND date=?")
    .get(kid, date) as { mood: string } | undefined;
  return row?.mood ?? null;
}

export function setMood(kid: KidId, mood: string): void {
  if (!MOODS.some((m) => m.id === mood)) return;
  getDb()
    .prepare(
      "INSERT INTO mood_logs (kid, date, mood) VALUES (?, ?, ?) ON CONFLICT(kid, date) DO UPDATE SET mood=excluded.mood, created_at=datetime('now','localtime')"
    )
    .run(kid, isoToday(), mood);
}

/** Last N days of mood for the quiet strip (oldest→newest). */
export function getMoodHistory(kid: KidId, days = 7): { date: string; mood: string | null }[] {
  const db = getDb();
  const out: { date: string; mood: string | null }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = isoToday(d);
    const row = db.prepare("SELECT mood FROM mood_logs WHERE kid=? AND date=?").get(kid, iso) as
      | { mood: string }
      | undefined;
    out.push({ date: iso, mood: row?.mood ?? null });
  }
  return out;
}

// -- template admin (parent, PIN-gated at the route) --

export function getTemplates(kid: KidId) {
  return getDb()
    .prepare(`SELECT ${TEMPLATE_COLS}, sort FROM checklist_templates WHERE kid=? AND active=1 ORDER BY sort`)
    .all(kid);
}

export interface NewTemplate {
  label: string;
  emoji: string;
  points: number;
  bucket: Bucket;
  tracked: boolean;
  unit: string | null;
  metric_label: string | null;
  contribution: boolean;
  detailKind: string | null;
  days?: string; // weekday digits 0=Sun..6=Sat; default all
  type?: "routine" | "job";
  dueDate?: string | null; // one-off job date; null = recurring
}

export function addTemplate(kid: KidId, t: NewTemplate) {
  const db = getDb();
  const max = (
    db.prepare("SELECT COALESCE(MAX(sort),0) m FROM checklist_templates WHERE kid=?").get(kid) as { m: number }
  ).m;
  const type = t.type === "job" ? "job" : "routine";
  db.prepare(
    `INSERT INTO checklist_templates
     (kid, label, emoji, points, detail_kind, sort, bucket, tracked, unit, metric_label, contribution, days, type, due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    kid,
    t.label,
    t.emoji,
    t.points,
    t.detailKind,
    max + 1,
    t.bucket,
    t.tracked ? 1 : 0,
    t.unit,
    t.metric_label,
    // jobs are "helps the family" contributions by default
    type === "job" ? 1 : t.contribution ? 1 : 0,
    t.days && /^[0-6]+$/.test(t.days) ? t.days : "0123456",
    type,
    type === "job" && t.dueDate ? t.dueDate : null
  );
}

// ---------- Wall events (the ＋ Add flow) ----------

export function addWallEvent(
  members: string[],
  title: string,
  date: string,
  start: string | null,
  end: string | null,
  location: string | null,
  countdown = false
): void {
  const db = getDb();
  // group_id ties a multi-member event together; derived from the max id so we
  // don't need Math.random (which is unavailable in some contexts).
  const next = (db.prepare("SELECT COALESCE(MAX(id),0)+1 n FROM wall_events").get() as { n: number }).n;
  const gid = `g${next}`;
  const ins = db.prepare(
    "INSERT INTO wall_events (group_id, member, title, date, start, end, location, countdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const tx = db.transaction(() => {
    for (const m of members) ins.run(gid, m, title.slice(0, 200), date, start, end, location, countdown ? 1 : 0);
  });
  tx();
}

export function deleteWallEvent(id: number): void {
  const db = getDb();
  const row = db.prepare("SELECT group_id FROM wall_events WHERE id=?").get(id) as { group_id: string } | undefined;
  if (row) db.prepare("DELETE FROM wall_events WHERE group_id=?").run(row.group_id);
}

export function removeTemplate(id: number) {
  getDb().prepare("UPDATE checklist_templates SET active=0 WHERE id=?").run(id);
}

// ---------- Task Box (reusable presets) ----------

export interface TaskBoxItem {
  id: number;
  label: string;
  emoji: string;
  bucket: Bucket;
  tracked: boolean;
  type: "routine" | "job";
}
export function getTaskBox(): TaskBoxItem[] {
  return (
    getDb().prepare("SELECT id, label, emoji, bucket, tracked, type FROM task_box ORDER BY type, id").all() as {
      id: number;
      label: string;
      emoji: string;
      bucket: string;
      tracked: number;
      type: string;
    }[]
  ).map((r) => ({ id: r.id, label: r.label, emoji: r.emoji, bucket: (r.bucket as Bucket) ?? "morning", tracked: !!r.tracked, type: r.type === "job" ? "job" : "routine" }));
}
export function addToTaskBox(label: string, emoji: string, bucket: string, tracked: boolean, type: string): void {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM task_box WHERE label=? COLLATE NOCASE").get(label);
  if (!exists) db.prepare("INSERT INTO task_box (label, emoji, bucket, tracked, type) VALUES (?, ?, ?, ?, ?)").run(label.slice(0, 40), emoji, bucket, tracked ? 1 : 0, type === "job" ? "job" : "routine");
}

// ---------- Level Up ----------

export interface ActivityDef {
  slug: string;
  label: string;
  emoji: string;
  metric: "count" | "duration";
  unit: string;
}

export function getActivities(kid: KidId): ActivityDef[] {
  return getDb()
    .prepare("SELECT slug, label, emoji, metric, unit FROM activities WHERE kid=? AND active=1 ORDER BY sort, id")
    .all(kid) as ActivityDef[];
}

export function addActivity(
  kid: KidId,
  label: string,
  emoji: string,
  metric: "count" | "duration"
): { ok: boolean; error?: string } {
  const db = getDb();
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!slug) return { ok: false, error: "Name required" };
  const exists = db.prepare("SELECT 1 FROM activities WHERE kid=? AND slug=?").get(kid, slug);
  if (exists) {
    db.prepare("UPDATE activities SET active=1 WHERE kid=? AND slug=?").run(kid, slug);
    return { ok: true };
  }
  const max = (
    db.prepare("SELECT COALESCE(MAX(sort),0) m FROM activities WHERE kid=?").get(kid) as { m: number }
  ).m;
  db.prepare(
    "INSERT INTO activities (kid, slug, label, emoji, metric, unit, sort) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(kid, slug, label, emoji, metric, metric === "duration" ? "min" : "reps", max + 1);
  return { ok: true };
}

export function removeActivity(kid: KidId, slug: string): void {
  // Soft-delete: history in levelup_logs stays intact.
  getDb().prepare("UPDATE activities SET active=0 WHERE kid=? AND slug=?").run(kid, slug);
}

export interface Badge {
  id: string;
  label: string;
  emoji: string;
  earned: boolean;
  progress: number; // 0..1
  detail: string;
}

export interface ActivitySummary {
  activity: string;
  label: string;
  emoji: string;
  metric: "duration" | "count";
  unit: string;
  sessions: number;
  best: number | null;      // count metrics: highest count; duration: longest session
  latest: number | null;
  totalMinutes: number;
  history: { value: number; created_at: string }[];
  nextMilestone: { target: number; progress: number } | null;
}

export interface KidLevelUp {
  kid: KidId;
  streak: number;
  totalSessions: number;
  badges: Badge[];
  activities: ActivitySummary[];
}

const SESSION_MILESTONES = [5, 15, 30, 60, 100];
const RECORD_MILESTONES = [10, 25, 50, 100, 200];

export function getLevelUp(kid: KidId): KidLevelUp {
  const db = getDb();
  const dates = (
    db
      .prepare("SELECT DISTINCT date(created_at) d FROM levelup_logs WHERE kid=? ORDER BY d DESC")
      .all(kid) as { d: string }[]
  ).map((r) => r.d);
  const streak = streakFromDates(dates);
  const totalSessions = (
    db.prepare("SELECT COUNT(*) c FROM levelup_logs WHERE kid=?").get(kid) as { c: number }
  ).c;

  const activities: ActivitySummary[] = getActivities(kid).map((a) => {
    const rows = db
      .prepare("SELECT duration_min, count, created_at FROM levelup_logs WHERE kid=? AND activity=? ORDER BY created_at ASC")
      .all(kid, a.slug) as { duration_min: number | null; count: number | null; created_at: string }[];
    const values = rows
      .map((r) => (a.metric === "count" ? r.count : r.duration_min))
      .filter((v): v is number => v !== null && v !== undefined);
    const best = values.length ? Math.max(...values) : null;
    const nextTarget = RECORD_MILESTONES.find((m) => (best ?? 0) < m) ?? null;
    return {
      activity: a.slug,
      label: a.label,
      emoji: a.emoji,
      metric: a.metric,
      unit: a.unit,
      sessions: rows.length,
      best,
      latest: values.length ? values[values.length - 1] : null,
      totalMinutes: rows.reduce((s, r) => s + (r.duration_min ?? 0), 0),
      history: rows
        .map((r) => ({ value: (a.metric === "count" ? r.count : r.duration_min) ?? 0, created_at: r.created_at }))
        .filter((h) => h.value > 0)
        .slice(-14),
      nextMilestone:
        a.metric === "count" && nextTarget
          ? { target: nextTarget, progress: Math.min(1, (best ?? 0) / nextTarget) }
          : null,
    };
  });

  const juggleBest = activities.find((a) => a.activity === "juggling")?.best ?? 0;
  const badges: Badge[] = [
    ...SESSION_MILESTONES.map((m) => ({
      id: `sessions-${m}`,
      label: `${m} Sessions`,
      emoji: "🎖️",
      earned: totalSessions >= m,
      progress: Math.min(1, totalSessions / m),
      detail: `${totalSessions}/${m} sessions logged`,
    })),
    ...RECORD_MILESTONES.slice(0, 3).map((m) => ({
      id: `juggle-${m}`,
      label: `Juggle ${m}`,
      emoji: "🤹",
      earned: juggleBest >= m,
      progress: Math.min(1, juggleBest / m),
      detail: `Best: ${juggleBest} touches`,
    })),
    ...[3, 7, 14].map((m) => ({
      id: `streak-${m}`,
      label: `${m}-Day Streak`,
      emoji: "🔥",
      earned: streak >= m,
      progress: Math.min(1, streak / m),
      detail: `Current streak: ${streak}`,
    })),
  ];

  return { kid, streak, totalSessions, badges, activities };
}

/** The session row and its points deposit are written together or not at all. */
export function logLevelUp(
  kid: KidId,
  activity: string,
  durationMin: number | null,
  count: number | null
): { isPersonalBest: boolean; previousBest: number | null; earned: number } {
  return getDb().transaction(() => logLevelUpTx(kid, activity, durationMin, count))();
}

function logLevelUpTx(
  kid: KidId,
  activity: string,
  durationMin: number | null,
  count: number | null
): { isPersonalBest: boolean; previousBest: number | null; earned: number } {
  const db = getDb();
  const def = getActivities(kid).find((a) => a.slug === activity);
  if (!def) throw new Error(`Unknown activity: ${activity}`);

  const rows = db
    .prepare("SELECT duration_min, count FROM levelup_logs WHERE kid=? AND activity=?")
    .all(kid, activity) as { duration_min: number | null; count: number | null }[];
  const values = rows
    .map((r) => (def.metric === "count" ? r.count : r.duration_min))
    .filter((v): v is number => v !== null && v !== undefined);
  const previousBest = values.length ? Math.max(...values) : null;

  db.prepare("INSERT INTO levelup_logs (kid, activity, duration_min, count) VALUES (?, ?, ?, ?)").run(
    kid,
    activity,
    durationMin,
    count
  );

  const newValue = def.metric === "count" ? count : durationMin;
  const isPersonalBest = newValue !== null && (previousBest === null || newValue > previousBest);

  const earned = getTaskValue("levelup_log", 5);
  deposit(kid, earned, "levelup", `${def.label} session`);

  return { isPersonalBest, previousBest, earned };
}

// ---------- Reading ----------

export interface ShelfBook {
  id: number;
  title: string;
  author: string | null;
  finished_at: string;
  hasNote: boolean;
  cover_path: string | null;
  readDays: number | null;
}

export interface ReadingBook {
  id: number;
  title: string;
  author: string | null;
  cover_path: string | null;
  day: number; // Day N since started
}

export interface KidReading {
  kid: KidId;
  reading: ReadingBook[];
  finishedThisYear: number;
  streak: number;
  shelf: ShelfBook[];
}

// The only cover address a screen is given: a cover cached on the hub and
// served by /api/covers (src/lib/books.ts writes nothing else).
// Anything else in the column, from an edited or restored database, is
// dropped, so the browser never loads a cover from another host.
const LOCAL_COVER = /^\/api\/covers\/book-\d+\.jpg$/;

export function localCoverPath(value: unknown): string | null {
  return typeof value === "string" && LOCAL_COVER.test(value) ? value : null;
}

export function getReading(kid: KidId): KidReading {
  const db = getDb();
  const reading = db
    .prepare(
      `SELECT id, title, author, cover_path,
              CAST(julianday('now','localtime') - julianday(started_at) AS INT) + 1 AS day
       FROM books WHERE kid=? AND status='reading' ORDER BY id DESC`
    )
    .all(kid) as ReadingBook[];
  for (const b of reading) b.cover_path = localCoverPath(b.cover_path);
  const finishedThisYear = (
    db
      .prepare(
        "SELECT COUNT(*) c FROM books WHERE kid=? AND status='finished' AND strftime('%Y', finished_at)=strftime('%Y','now','localtime')"
      )
      .get(kid) as { c: number }
  ).c;
  // Reading streak: days with a reading-flagged checklist completion or a finish.
  const dates = (
    db
      .prepare(
        `SELECT DISTINCT d FROM (
           SELECT cc.date d FROM checklist_completions cc
             JOIN checklist_templates ct ON ct.id=cc.template_id
           WHERE cc.kid=? AND ct.detail_kind='reading'
           UNION
           SELECT date(finished_at) d FROM books WHERE kid=? AND finished_at IS NOT NULL
         ) ORDER BY d DESC`
      )
      .all(kid, kid) as { d: string }[]
  ).map((r) => r.d);
  const shelf = db
    .prepare(
      `SELECT b.id, b.title, b.author, b.finished_at, b.cover_path,
              EXISTS(SELECT 1 FROM book_notes n WHERE n.book_id=b.id) hasNote,
              MAX(1, CAST(julianday(b.finished_at) - julianday(b.started_at) AS INT)) readDays
       FROM books b WHERE b.kid=? AND b.status='finished' ORDER BY b.finished_at DESC`
    )
    .all(kid) as (Omit<ShelfBook, "hasNote"> & { hasNote: number })[];
  return {
    kid,
    reading,
    finishedThisYear,
    streak: streakFromDates(dates),
    shelf: shelf.map((b) => ({ ...b, cover_path: localCoverPath(b.cover_path), hasNote: !!b.hasNote })),
  };
}

/** Remove a not-yet-finished book (mis-taps). Finished books are permanent. */
export function removeReadingBook(kid: KidId, bookId: number): boolean {
  const res = getDb()
    .prepare("DELETE FROM books WHERE id=? AND kid=? AND status='reading'")
    .run(bookId, kid);
  return res.changes > 0;
}

export function startBook(kid: KidId, title: string, author: string | null, isbn: string | null = null): number {
  const info = getDb()
    .prepare("INSERT INTO books (kid, title, author, isbn) VALUES (?, ?, ?, ?)")
    .run(kid, title, author, isbn);
  return Number(info.lastInsertRowid);
}

/** Status change and the points deposit commit together. */
export function finishBook(kid: KidId, bookId: number): { earned: number; readDays: number } {
  return getDb().transaction(() => finishBookTx(kid, bookId))();
}

function finishBookTx(kid: KidId, bookId: number): { earned: number; readDays: number } {
  const db = getDb();
  const res = db
    .prepare("UPDATE books SET status='finished', finished_at=datetime('now','localtime') WHERE id=? AND kid=? AND status='reading'")
    .run(bookId, kid);
  if (res.changes === 0) return { earned: 0, readDays: 0 };
  const earned = getTaskValue("book_finish", 15);
  const row = db
    .prepare(
      "SELECT title, MAX(1, CAST(julianday(finished_at) - julianday(started_at) AS INT)) d FROM books WHERE id=?"
    )
    .get(bookId) as { title: string; d: number };
  deposit(kid, earned, "book", `Finished "${row.title}"`);
  return { earned, readDays: row.d };
}

export function saveBookNote(kid: KidId, bookId: number, prompt: string, answer: string): void {
  getDb()
    .prepare("INSERT INTO book_notes (book_id, kid, prompt, answer) VALUES (?, ?, ?, ?)")
    .run(bookId, kid, prompt, answer);
}

// ---------- Progress (accumulation dashboard) ----------
// The "byproduct" of the measured routine items: x hours of practice, y minutes
// read, books finished. Metrics come straight from tracked routine completions
// (amount grouped by metric_label); books come from the shelf.

export type MetricCategory = "knowledge" | "physical";

// Which section a tracked activity belongs to. Default is knowledge; anything
// clearly physical goes to the body column.
const PHYSICAL_METRICS = new Set([
  "Soccer", "Lacrosse", "Walk", "Workout", "Basketball", "Swim", "Swimming",
  "Running", "Run", "Sports", "Baseball", "Dance", "Bike", "Biking", "Gym",
  "Football", "Tennis", "Hockey", "Yoga", "Karate", "Gymnastics",
]);
function categoryOf(label: string): MetricCategory {
  return PHYSICAL_METRICS.has(label) ? "physical" : "knowledge";
}

export interface MetricTotal {
  label: string;
  unit: string;
  emoji: string;
  category: MetricCategory;
  total: number; // all-time sum of logged amounts
  weekTotal: number; // last 7 days
  sessions: number; // logged amounts
}

export interface KidProgress {
  kid: KidId;
  metrics: MetricTotal[];
  knowledge: MetricTotal[];
  physical: MetricTotal[];
  routineStreak: number;
  readingStreak: number;
  booksThisYear: number;
  booksAllTime: number;
  reading: ReadingBook[];
  shelf: ShelfBook[];
  moodHistory: { date: string; mood: string | null }[];
  mood: string | null;
  // points / reward progress (folded in from Balance)
  currency: string;
  balance: number;
  todayEarned: number;
  weekEarned: number;
  goal: KidGoal | null;
}

export function getProgress(kid: KidId): KidProgress {
  const db = getDb();

  const raw = db
    .prepare(
      `SELECT ct.metric_label label, ct.unit unit, MAX(ct.emoji) emoji,
              COALESCE(SUM(cc.amount),0) total,
              COALESCE(SUM(CASE WHEN cc.date >= date('now','localtime','-6 days') THEN cc.amount ELSE 0 END),0) weekTotal,
              COUNT(cc.id) sessions
       FROM checklist_completions cc
       JOIN checklist_templates ct ON ct.id = cc.template_id
       WHERE cc.kid=? AND ct.tracked=1 AND ct.metric_label IS NOT NULL AND cc.amount IS NOT NULL
       GROUP BY ct.metric_label, ct.unit
       ORDER BY total DESC`
    )
    .all(kid) as Omit<MetricTotal, "category">[];
  const metrics: MetricTotal[] = raw.map((m) => ({ ...m, category: categoryOf(m.label) }));

  const routineDates = (
    db
      .prepare("SELECT DISTINCT date FROM checklist_completions WHERE kid=? ORDER BY date DESC")
      .all(kid) as { date: string }[]
  ).map((r) => r.date);

  const reading = getReading(kid);

  const balance = (
    db.prepare("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=?").get(kid) as { s: number }
  ).s;
  const todayEarned = (
    db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=? AND amount>0 AND date(created_at)=date('now','localtime')"
      )
      .get(kid) as { s: number }
  ).s;
  const weekEarned = (
    db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=? AND amount>0 AND date(created_at)>=date('now','localtime','-6 days')"
      )
      .get(kid) as { s: number }
  ).s;
  const goal = db
    .prepare("SELECT id, label, emoji, cost FROM selected_goals WHERE kid=? AND active=1 ORDER BY id DESC LIMIT 1")
    .get(kid) as KidGoal | undefined;

  return {
    kid,
    metrics,
    knowledge: metrics.filter((m) => m.category === "knowledge"),
    physical: metrics.filter((m) => m.category === "physical"),
    routineStreak: streakFromDates(routineDates),
    readingStreak: reading.streak,
    booksThisYear: reading.finishedThisYear,
    booksAllTime: reading.shelf.length,
    reading: reading.reading,
    shelf: reading.shelf,
    moodHistory: getMoodHistory(kid, 7),
    mood: getMood(kid),
    currency: getSetting("currency_name", "Family Bucks"),
    balance,
    todayEarned,
    weekEarned,
    goal: goal ?? null,
  };
}

// ---------- Balance ----------

export interface LedgerEntry {
  id: number;
  amount: number;
  source: string;
  label: string;
  created_at: string;
}

export interface Reward {
  id: number;
  label: string;
  emoji: string;
  cost: number;
  kid: string | null; // NULL = family-wide, else that kid's own item
}

export interface RewardRequest {
  id: number;
  kid: string;
  label: string;
  emoji: string;
  status: string;
}

/** Kid asks for a new reward; parents price it later. */
export function requestReward(kid: KidId, label: string, emoji: string): void {
  getDb()
    .prepare("INSERT INTO reward_requests (kid, label, emoji) VALUES (?, ?, ?)")
    .run(kid, label.slice(0, 80), emoji || "🎁");
}

/** Parent (PIN at route) sets a price: request becomes a real menu item and
 *  automatically that kid's goal. */
export function priceRequest(requestId: number, cost: number): { ok: boolean } {
  const db = getDb();
  const req = db
    .prepare("SELECT id, kid, label, emoji FROM reward_requests WHERE id=? AND status='pending'")
    .get(requestId) as RewardRequest | undefined;
  if (!req) return { ok: false };
  db.prepare("INSERT INTO rewards (label, emoji, cost, kid) VALUES (?, ?, ?, ?)").run(
    req.label,
    req.emoji,
    cost,
    req.kid
  );
  db.prepare("UPDATE reward_requests SET status='priced' WHERE id=?").run(requestId);
  db.prepare("UPDATE selected_goals SET active=0 WHERE kid=?").run(req.kid);
  db.prepare("INSERT INTO selected_goals (kid, label, emoji, cost) VALUES (?, ?, ?, ?)").run(
    req.kid,
    req.label,
    req.emoji,
    cost
  );
  return { ok: true };
}

export function declineRequest(requestId: number): void {
  getDb().prepare("UPDATE reward_requests SET status='declined' WHERE id=? AND status='pending'").run(requestId);
}

export interface KidGoal {
  id: number;
  label: string;
  emoji: string;
  cost: number;
}

export interface KidBalance {
  kid: KidId;
  balance: number;
  earnedTotal: number;
  todayEarned: number;
  weekEarned: number;
  goal: KidGoal | null;
  pendingRequests: RewardRequest[];
  ledger: LedgerEntry[];
}

/** Lightweight per-kid balances for ambient display (Today rows). */
export function getBalanceMap(): Record<string, number> {
  const db = getDb();
  const rows = db.prepare("SELECT kid, COALESCE(SUM(amount),0) s FROM ledger GROUP BY kid").all() as {
    kid: string;
    s: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.kid, r.s]));
}

export function getBalances(): {
  currency: string;
  kids: KidBalance[];
  rewards: Reward[];
} {
  const db = getDb();
  const kids: KidBalance[] = getKids().map((k) => {
    const balance = (
      db.prepare("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=?").get(k.id) as { s: number }
    ).s;
    const earnedTotal = (
      db.prepare("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=? AND amount>0").get(k.id) as { s: number }
    ).s;
    const todayEarned = (
      db
        .prepare(
          "SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=? AND amount>0 AND date(created_at)=date('now','localtime')"
        )
        .get(k.id) as { s: number }
    ).s;
    const weekEarned = (
      db
        .prepare(
          "SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=? AND amount>0 AND date(created_at)>=date('now','localtime','-6 days')"
        )
        .get(k.id) as { s: number }
    ).s;
    const goal = db
      .prepare("SELECT id, label, emoji, cost FROM selected_goals WHERE kid=? AND active=1 ORDER BY id DESC LIMIT 1")
      .get(k.id) as KidGoal | undefined;
    const pendingRequests = db
      .prepare("SELECT id, kid, label, emoji, status FROM reward_requests WHERE kid=? AND status='pending' ORDER BY id")
      .all(k.id) as RewardRequest[];
    const ledger = db
      .prepare("SELECT id, amount, source, label, created_at FROM ledger WHERE kid=? ORDER BY id DESC LIMIT 40")
      .all(k.id) as LedgerEntry[];
    return { kid: k.id, balance, earnedTotal, todayEarned, weekEarned, goal: goal ?? null, pendingRequests, ledger };
  });
  return {
    currency: getSetting("currency_name", "Family Bucks"),
    kids,
    rewards: db
      .prepare("SELECT id, label, emoji, cost, kid FROM rewards WHERE active=1 ORDER BY cost")
      .all() as Reward[],
  };
}

/** Kid picks a menu item as their goal — shows as a progress bar on their card. */
export function selectGoal(kid: KidId, rewardId: number): { ok: boolean } {
  const db = getDb();
  // A kid-specific reward can only be picked by that kid.
  const reward = db
    .prepare("SELECT label, emoji, cost FROM rewards WHERE id=? AND active=1 AND (kid IS NULL OR kid=?)")
    .get(rewardId, kid) as { label: string; emoji: string; cost: number } | undefined;
  if (!reward) return { ok: false };
  db.prepare("UPDATE selected_goals SET active=0 WHERE kid=?").run(kid);
  db.prepare("INSERT INTO selected_goals (kid, label, emoji, cost) VALUES (?, ?, ?, ?)").run(
    kid,
    reward.label,
    reward.emoji,
    reward.cost
  );
  return { ok: true };
}

export function clearGoal(kid: KidId): void {
  getDb().prepare("UPDATE selected_goals SET active=0 WHERE kid=?").run(kid);
}

/**
 * PIN-verified at the route. Deducts the reward cost if affordable.
 * `opId` is the screen's key for this one redemption: the same key sent again
 * (a double tap, a retried request) answers like the first time and charges
 * nothing more. Without a key the redemption still works, unprotected.
 */
export function redeemReward(
  kid: KidId,
  rewardId: number,
  opId: string | null = null
): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  // Key check, balance check, deduction and key record in one transaction.
  return db
    .transaction((): { ok: true } | { ok: false; error: string } => {
      // The key is bound to this kid and reward, so reusing an opId for a
      // different redemption never silently skips a real charge.
      const opKey = opId ? `${opId}:${kid}:${rewardId}` : null;
      if (opKey && db.prepare("SELECT 1 FROM ledger_ops WHERE op_id=?").get(opKey)) return { ok: true };
      const result = redeemRewardTx(kid, rewardId);
      // Only a redemption that charged is recorded: a refused one may be retried.
      if (result.ok && opKey) {
        db.prepare("INSERT INTO ledger_ops (op_id) VALUES (?)").run(opKey);
        db.prepare("DELETE FROM ledger_ops WHERE created_at < datetime('now', '-7 days')").run();
      }
      return result;
    })
    .immediate();
}

function redeemRewardTx(kid: KidId, rewardId: number): { ok: true } | { ok: false; error: string } {
  const db = getDb();
  const reward = db
    .prepare("SELECT label, emoji, cost FROM rewards WHERE id=? AND active=1 AND (kid IS NULL OR kid=?)")
    .get(rewardId, kid) as { label: string; emoji: string; cost: number } | undefined;
  if (!reward) return { ok: false, error: "Unknown reward" };
  const balance = (
    db.prepare("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=?").get(kid) as { s: number }
  ).s;
  if (balance < reward.cost) return { ok: false, error: "Not enough saved up yet" };
  db.prepare("INSERT INTO ledger (kid, amount, source, label) VALUES (?, ?, 'redeem', ?)").run(
    kid,
    -reward.cost,
    `${reward.emoji} ${reward.label}`
  );
  // If they redeemed their active goal, retire it.
  db.prepare("UPDATE selected_goals SET active=0 WHERE kid=? AND label=? AND active=1").run(kid, reward.label);
  return { ok: true };
}
