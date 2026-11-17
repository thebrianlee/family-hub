// The household's members, read from the `members` table. Server-only: it
// imports the database, so a client component that imports it fails the build.
// Client components get the same data through useMembers().

import { getDb } from "./db";
import type { KidId, MemberId, MemberRecord, MemberRole, ParentId } from "./family";
import { MEMBER_ID_RE, isPaletteColor } from "./member-theme";

type Db = ReturnType<typeof getDb>;

interface MemberRow {
  id: string;
  name: string;
  role: MemberRole;
  age: number | null;
  pre_reader: number;
  color: string;
}

const COLS = "id, name, role, age, pre_reader, color";
const ORDER = "ORDER BY CASE role WHEN 'kid' THEN 0 ELSE 1 END, sort, rowid";

function toRecord(r: MemberRow): MemberRecord {
  return { id: r.id, name: r.name, role: r.role, age: r.age, preReader: r.pre_reader === 1, color: r.color };
}

/** Active members, kids first, then parents, each in their sort order. */
export function getMembers(db: Db = getDb()): MemberRecord[] {
  return (db.prepare(`SELECT ${COLS} FROM members WHERE active=1 ${ORDER}`).all() as MemberRow[]).map(toRecord);
}

export function getKids(db: Db = getDb()): MemberRecord[] {
  return getMembers(db).filter((m) => m.role === "kid");
}

export function getParents(db: Db = getDb()): MemberRecord[] {
  return getMembers(db).filter((m) => m.role === "parent");
}

export function getMember(id: unknown, db: Db = getDb()): MemberRecord | null {
  if (typeof id !== "string" || !MEMBER_ID_RE.test(id)) return null;
  const row = db.prepare(`SELECT ${COLS} FROM members WHERE id=? AND active=1`).get(id) as MemberRow | undefined;
  return row ? toRecord(row) : null;
}

export function isMemberId(id: unknown): id is MemberId {
  return getMember(id) !== null;
}

export function isKidId(id: unknown): id is KidId {
  return getMember(id)?.role === "kid";
}

export function isParentId(id: unknown): id is ParentId {
  return getMember(id)?.role === "parent";
}

// ---------- validation ----------

export const MAX_KIDS = 8;
export const MAX_PARENTS = 4;
export const MAX_NAME = 30;
export const MAX_AGE = 18;

/** Ids the app already uses for something that is not a member. */
// "guest" is used for questions asked without a kid; "auto" and "px" would make
// the member class m-<id> collide with Tailwind's m-auto / m-px margin utilities.
const RESERVED_IDS = new Set(["guest", "auto", "px"]);

export class MemberError extends Error {}

export interface MemberInput {
  name: string;
  role: MemberRole;
  age: number | null;
  preReader: boolean;
  color: string;
}

/** Trimmed, single-spaced name of 1-30 characters, or an error. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw new MemberError("Every person needs a name.");
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) throw new MemberError("Every person needs a name.");
  if (/[\u0000-\u001f\u007f<>]/.test(name)) throw new MemberError(`"${name}" has characters a name can't use.`);
  if ([...name].length > MAX_NAME) throw new MemberError(`Keep names to ${MAX_NAME} characters.`);
  return name;
}

/** Validate one member. Kids need an age from 0 to 18; parents have none. */
export function validateMember(raw: unknown, role: MemberRole): MemberInput {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = cleanName(o.name);
  let age: number | null = null;
  if (role === "kid") {
    const a = typeof o.age === "string" && o.age.trim() !== "" ? Number(o.age) : o.age;
    if (typeof a !== "number" || !Number.isInteger(a) || a < 0 || a > MAX_AGE) {
      throw new MemberError(`${name}'s age should be a whole number from 0 to ${MAX_AGE}.`);
    }
    age = a;
  }
  const color = typeof o.color === "string" ? o.color.toUpperCase() : "";
  if (!isPaletteColor(color)) throw new MemberError(`Pick one of the offered colors for ${name}.`);
  return { name, role, age, preReader: role === "kid" && o.preReader === true, color };
}

/** Lower-case ASCII slug from a name: "Zoë Ann" -> "zoe-ann". */
export function slugifyName(name: string): string {
  let s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(s)) s = s ? `m-${s}` : "member";
  return s.slice(0, 24).replace(/-+$/, "");
}

/** A slug for `name` that is not in `taken` (adds -2, -3, ... when needed). */
export function uniqueMemberId(name: string, taken: ReadonlySet<string>): string {
  const base = slugifyName(name);
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED_IDS.has(id); n++) {
    const suffix = `-${n}`;
    id = `${base.slice(0, 24 - suffix.length).replace(/-+$/, "")}${suffix}`;
  }
  if (!MEMBER_ID_RE.test(id)) throw new MemberError("Could not make an id for that name.");
  return id;
}

function takenIds(db: Db): Set<string> {
  return new Set((db.prepare("SELECT id FROM members").all() as { id: string }[]).map((r) => r.id));
}

function assertUniqueNames(names: string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    const key = n.toLocaleLowerCase();
    if (seen.has(key)) throw new MemberError(`Two people are named ${n}. Give each person a different name.`);
    seen.add(key);
  }
}

// ---------- CRUD ----------

function insertMember(db: Db, m: MemberInput, sort: number, taken: Set<string>): MemberRecord {
  const id = uniqueMemberId(m.name, taken);
  taken.add(id);
  db.prepare(
    "INSERT INTO members (id, name, role, age, pre_reader, color, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
  ).run(id, m.name, m.role, m.age, m.preReader ? 1 : 0, m.color, sort);
  return { id, name: m.name, role: m.role, age: m.age, preReader: m.preReader, color: m.color };
}

/** Add one member (validated). Its id is derived from the name and unique. */
export function addMember(raw: unknown, role: MemberRole): MemberRecord {
  const db = getDb();
  const m = validateMember(raw, role);
  return db.transaction(() => {
    assertUniqueNames([...getMembers(db).map((x) => x.name), m.name]);
    if (role === "kid" && getKids(db).length >= MAX_KIDS) throw new MemberError(`Up to ${MAX_KIDS} kids.`);
    if (role === "parent" && getParents(db).length >= MAX_PARENTS) throw new MemberError(`Up to ${MAX_PARENTS} parents.`);
    const sort = (db.prepare("SELECT COALESCE(MAX(sort),0) m FROM members WHERE role=?").get(role) as { m: number }).m + 1;
    const rec = insertMember(db, m, sort, takenIds(db));
    if (role === "parent") {
      db.prepare("INSERT OR IGNORE INTO parent_status (member, status) VALUES (?, 'Home')").run(rec.id);
    }
    return rec;
  })();
}

/** Change a member's name, age, pre-reader flag or color. The id never changes. */
export function updateMember(id: string, patch: Record<string, unknown>): MemberRecord {
  const db = getDb();
  const cur = getMember(id, db);
  if (!cur) throw new MemberError("Unknown member.");
  const next = validateMember({ ...cur, ...patch }, cur.role);
  assertUniqueNames([...getMembers(db).filter((x) => x.id !== id).map((x) => x.name), next.name]);
  db.prepare("UPDATE members SET name=?, age=?, pre_reader=?, color=? WHERE id=?").run(
    next.name,
    next.age,
    next.preReader ? 1 : 0,
    next.color,
    id
  );
  return { ...cur, name: next.name, age: next.age, preReader: next.preReader, color: next.color };
}

/**
 * Hide a member. Their history (routines, points, books, questions) stays in
 * the database and their id stays taken. Their calendar link is a secret, so
 * it is deleted, together with the events it brought in (a later link
 * refetches them).
 */
export function removeMember(id: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const hidden = db.prepare("UPDATE members SET active=0 WHERE id=? AND active=1").run(id).changes > 0;
    if (hidden) {
      db.prepare("DELETE FROM settings WHERE key=?").run(`ics_url_${id}`);
      db.prepare("DELETE FROM synced_events WHERE member=?").run(id);
    }
    return hidden;
  })();
}

// ---------- replacing the sample family (first-run setup) ----------

/** Every table and column that holds a member id. */
export const MEMBER_KEYED: readonly { table: string; column: string }[] = [
  { table: "events", column: "member" },
  { table: "synced_events", column: "member" },
  { table: "wall_events", column: "member" },
  { table: "checklist_completions", column: "kid" },
  { table: "checklist_templates", column: "kid" },
  { table: "mood_logs", column: "kid" },
  { table: "levelup_logs", column: "kid" },
  { table: "book_notes", column: "kid" },
  { table: "books", column: "kid" },
  { table: "ledger", column: "kid" },
  { table: "parent_status", column: "member" },
  { table: "rewards", column: "kid" }, // kid NULL = family-wide, kept
  { table: "activities", column: "kid" },
  { table: "reward_requests", column: "kid" },
  { table: "selected_goals", column: "kid" },
  { table: "questions", column: "kid" },
];

export interface HouseholdPlan {
  kids: MemberInput[];
  parents: MemberInput[];
}

/** Validate the setup wizard's "Set up my family" answers. Throws MemberError. */
export function validateHousehold(raw: unknown): HouseholdPlan {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kidsIn = Array.isArray(o.kids) ? o.kids : [];
  const parentsIn = Array.isArray(o.parents) ? o.parents : [];
  if (kidsIn.length < 1 || kidsIn.length > MAX_KIDS) throw new MemberError(`Add between 1 and ${MAX_KIDS} kids.`);
  if (parentsIn.length < 1 || parentsIn.length > MAX_PARENTS) {
    throw new MemberError(`Add between 1 and ${MAX_PARENTS} parents.`);
  }
  const kids = kidsIn.map((k) => validateMember(k, "kid"));
  const parents = parentsIn.map((p) => validateMember(p, "parent"));
  assertUniqueNames([...kids, ...parents].map((m) => m.name));
  return { kids, parents };
}

/**
 * Replace every member, and everything keyed to a member, with a new household.
 * Family-wide data (task values, meals, lists, family-wide rewards, rules,
 * task box) stays. Each kid gets a small starter routine and each parent a
 * status row. Runs in a transaction (a savepoint when the caller has one open).
 */
export function replaceHousehold(plan: HouseholdPlan): MemberRecord[] {
  const db = getDb();
  return db.transaction(() => {
    // Everything keyed to a person belongs to the household being replaced
    // (at first-run setup: the sample family), including strays such as a
    // "guest" question. Family-wide rewards have kid NULL and stay.
    for (const { table, column } of MEMBER_KEYED) {
      db.prepare(`DELETE FROM ${table} WHERE ${column} IS NOT NULL`).run();
    }
    const oldIds = (db.prepare("SELECT id FROM members").all() as { id: string }[]).map((r) => r.id);
    for (const id of oldIds) db.prepare("DELETE FROM settings WHERE key=?").run(`ics_url_${id}`);
    // The kids' shared calendar belonged to the household being replaced too.
    db.prepare("DELETE FROM settings WHERE key='ics_url_kids_shared'").run();
    db.prepare("DELETE FROM members").run();

    const taken = new Set<string>();
    const out: MemberRecord[] = [];
    plan.kids.forEach((k, i) => out.push(insertMember(db, k, i + 1, taken)));
    plan.parents.forEach((p, i) => out.push(insertMember(db, p, i + 1, taken)));

    const routine = db.prepare(
      "INSERT INTO checklist_templates (kid, label, emoji, points, detail_kind, sort, bucket, contribution) VALUES (?, ?, ?, 2, NULL, ?, ?, ?)"
    );
    const status = db.prepare("INSERT OR REPLACE INTO parent_status (member, status) VALUES (?, 'Home')");
    for (const m of out) {
      if (m.role === "kid") {
        routine.run(m.id, "Brush Teeth", "🪥", 1, "morning", 0);
        routine.run(m.id, "Make Bed", "🛏️", 2, "morning", 1);
        routine.run(m.id, "Brush Teeth", "🪥", 3, "evening", 0);
      } else {
        status.run(m.id);
      }
    }
    return out;
  })();
}
