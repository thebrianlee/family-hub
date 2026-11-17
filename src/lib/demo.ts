// Demo mode: a shareable board for filming walkthroughs.
//
// When settings.demo_mode = "1":
//  - the calendar serves this deterministic generic schedule (no real school,
//    no real names, no addresses) instead of synced/wall events
//
// Two flavors, controlled by settings.demo_show_faces:
//  - "0" (full anonymize): cartoon dinos for avatars, screensaver runs quotes-
//    only. Use when the family must not appear on camera.
//  - "1" (featured family): real avatars + real screensaver photos, but the
//    calendar/meals stay as generic filler. Use for a personal demo where you
//    WANT your family shown over believable-but-fake schedule data.
// Real data is untouched underneath — flip demo_mode back to 0 and it all returns.

import { getSetting } from "./queries";
import { getKids, getParents } from "./household";
import type { CalendarEvent } from "./calendar";

export function isDemoMode(): boolean {
  return getSetting("demo_mode", "0") === "1";
}

/** In demo mode, show the real family (avatars + photos) instead of dinos. */
export function demoShowFaces(): boolean {
  return getSetting("demo_show_faces", "0") === "1";
}

// The demo schedule is written for slots, not people: three kid slots and two
// parent slots. getDemoEvents() hands them to the household's current kids and
// parents in order (a fourth kid takes the first kid slot again, and so on),
// so it never names anyone who is not on the board.
type Slot = "kid0" | "kid1" | "kid2" | "parent0" | "parent1" | "kids";
const KID_SLOTS = ["kid0", "kid1", "kid2"] as const;
const PARENT_SLOTS = ["parent0", "parent1"] as const;

interface Tpl {
  slot: Slot;
  title: string;
  /** 0=Sun..6=Sat */
  days: number[];
  start?: string;
  end?: string;
  location?: string;
}

const WEEKDAYS = [1, 2, 3, 4, 5];

// A believable-but-generic — and busy — family week, in Skylight-demo spirit.
// Mirrors the video's talking points: reading, Chinese, sport training.
// "kids" means every kid.
const WEEKLY: Tpl[] = [
  // School day
  { slot: "kids", title: "School", days: WEEKDAYS },
  { slot: "kids", title: "School Bus", days: WEEKDAYS, start: "08:15", end: "08:45", location: "Corner" },
  // Chinese (all the kids, the script calls it out)
  { slot: "kids", title: "Chinese Lesson", days: [2, 4], start: "15:30", end: "16:00" },
  // Oldest — sports + coding
  { slot: "kid0", title: "Soccer Practice", days: [2, 4], start: "16:30", end: "17:30", location: "Rec Field" },
  { slot: "kid0", title: "Soccer Game", days: [6], start: "10:00", end: "11:30", location: "Rec Field" },
  { slot: "kid0", title: "Coding Club", days: [3], start: "16:00", end: "17:00" },
  { slot: "kid0", title: "Reading Time", days: [1, 2, 3, 4, 0], start: "19:30", end: "20:00" },
  // Middle — swim + piano
  { slot: "kid1", title: "Swim Lesson", days: [1, 3], start: "17:00", end: "17:45", location: "Community Pool" },
  { slot: "kid1", title: "Piano Lesson", days: [5], start: "16:00", end: "16:45", location: "Ms. Chen" },
  { slot: "kid1", title: "Piano Practice", days: [1, 2, 3, 4], start: "18:00", end: "18:20" },
  { slot: "kid1", title: "Reading Time", days: [1, 2, 3, 4, 0], start: "19:30", end: "20:00" },
  // Youngest — preschool-age fun
  { slot: "kid2", title: "Playdate", days: [2], start: "15:30", end: "17:00" },
  { slot: "kid2", title: "Story Time", days: [6], start: "10:00", end: "10:45", location: "Library" },
  { slot: "kid2", title: "Swim Class", days: [4], start: "16:00", end: "16:30", location: "Community Pool" },
  // Parents
  { slot: "parent0", title: "Team Meeting", days: [1, 3, 5], start: "10:00", end: "11:00" },
  { slot: "parent0", title: "Gym", days: [2, 4], start: "07:00", end: "08:00" },
  { slot: "parent0", title: "Deep Work", days: [1, 3], start: "13:00", end: "15:00" },
  { slot: "parent1", title: "Studio Day", days: [2] },
  { slot: "parent1", title: "Yoga", days: [1, 3, 5], start: "08:00", end: "09:00" },
  { slot: "parent1", title: "Book Club", days: [4], start: "19:30", end: "21:00" },
  // Family
  { slot: "kids", title: "Family Movie Night", days: [5], start: "19:00", end: "21:00" },
  { slot: "parent0", title: "Farmers Market", days: [6], start: "09:30", end: "11:00" },
  { slot: "parent1", title: "Farmers Market", days: [6], start: "09:30", end: "11:00" },
  { slot: "kids", title: "Pancake Sunday", days: [0], start: "09:00", end: "10:00" },
];

// One-off dated events (offset in days from "today"), for texture on the
// month/list views + a couple of countdown-worthy anticipations. "{name}" is
// replaced with the member's name.
const ONEOFFS: { slot: Slot; title: string; offset: number; start?: string; end?: string; location?: string; countdown?: boolean }[] = [
  { slot: "kid2", title: "Dentist Checkup", offset: 2, start: "14:00", end: "14:45", location: "Dr. Park" },
  { slot: "kid1", title: "Birthday Party", offset: 3, start: "13:00", end: "15:00", location: "Jump Zone" },
  { slot: "kid0", title: "Field Trip: Aquarium", offset: 4, start: "09:00", end: "14:00" },
  { slot: "kid1", title: "Piano Recital", offset: 6, start: "17:00", end: "18:30", location: "Hall B", countdown: true },
  { slot: "kid0", title: "Soccer Tournament", offset: 9, start: "08:00", end: "16:00", location: "Regional Park", countdown: true },
  { slot: "parent1", title: "Parent-Teacher Night", offset: 5, start: "18:00", end: "20:00", location: "School" },
  { slot: "kids", title: "Camping Trip", offset: 12, countdown: true },
  { slot: "kid0", title: "Grandma & Grandpa Visit", offset: 15, countdown: true },
  { slot: "kid2", title: "{name}'s Birthday! 🎂", offset: 21, countdown: true },
];

/** Members who fill a slot, given the household's kids and parents in order. */
export function demoSlotMembers(
  slot: Slot,
  kids: readonly { id: string; name: string }[],
  parents: readonly { id: string; name: string }[]
): { id: string; name: string }[] {
  if (slot === "kids") return [...kids];
  const kidIdx = (KID_SLOTS as readonly string[]).indexOf(slot);
  if (kidIdx >= 0) return kids.filter((_, i) => i % KID_SLOTS.length === kidIdx);
  const parentIdx = (PARENT_SLOTS as readonly string[]).indexOf(slot);
  return parents.filter((_, i) => i % PARENT_SLOTS.length === parentIdx);
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getDemoEvents(fromIso: string, toIso: string): CalendarEvent[] {
  const kids = getKids();
  const parents = getParents();
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const from = new Date(fy, fm - 1, fd);
  const out: CalendarEvent[] = [];

  // Recurring weekly schedule.
  for (let d = new Date(from); iso(d) <= toIso; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    const dateIso = iso(d);
    for (const t of WEEKLY) {
      if (!t.days.includes(dow)) continue;
      for (const m of demoSlotMembers(t.slot, kids, parents)) {
        out.push({
          id: `demo-${m.id}-${t.title.replace(/\s+/g, "-").toLowerCase()}-${dateIso}`,
          member: m.id,
          title: t.title,
          date: dateIso,
          start: t.start,
          end: t.end,
          location: t.location,
        });
      }
    }
  }

  // Dated one-offs, offset from "today" (stable within a day).
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  for (const o of ONEOFFS) {
    const d = new Date(midnight); d.setDate(d.getDate() + o.offset);
    const dateIso = iso(d);
    if (dateIso < fromIso || dateIso > toIso) continue;
    for (const m of demoSlotMembers(o.slot, kids, parents)) {
      const title = o.title.replace("{name}", m.name);
      out.push({
        id: `demo-oneoff-${m.id}-${o.title.replace(/\s+/g, "-").toLowerCase()}`,
        member: m.id,
        title,
        date: dateIso,
        start: o.start,
        end: o.end,
        location: o.location,
        countdown: o.countdown,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? "").localeCompare(b.start ?? ""));
}
