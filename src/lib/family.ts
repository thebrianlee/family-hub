// Household types and the constants that are not member data. The members
// themselves live in the `members` table: read them with src/lib/household.ts
// on the server and with useMembers() (components/MembersProvider) on the client.

import { MemberTheme, NEUTRAL_COLOR, PARENT_THEME, memberTheme } from "./member-theme";

export type { MemberTheme } from "./member-theme";

/** Member ids are slugs from the members table; validate them with household.ts. */
export type KidId = string;
export type ParentId = string;
export type MemberId = string;
export type MemberRole = "kid" | "parent";

/** One member as stored (and passed from the server layout to the client). */
export interface MemberRecord {
  id: MemberId;
  name: string;
  role: MemberRole;
  age: number | null;
  preReader: boolean;
  color: string; // #RRGGBB from MEMBER_PALETTE
}

/** A member with display data, as client components use it. */
export interface Member extends MemberRecord {
  isParent: boolean;
  theme: MemberTheme;
}
export type Kid = Member;
export type Parent = Member;

export interface Household {
  kids: Member[];
  parents: Member[];
  /** Today-view row order: kids first, then parents. */
  rowOrder: Member[];
  byId: Readonly<Record<string, Member | undefined>>;
  /** The member, or a neutral stand-in for an id that is no longer in the household. */
  memberOf: (id: string) => Member;
}

export function toMember(r: MemberRecord): Member {
  const isParent = r.role === "parent";
  return { ...r, isParent, theme: isParent ? PARENT_THEME : memberTheme(r.id, r.color) };
}

export function buildHousehold(records: readonly MemberRecord[]): Household {
  const all = records.map(toMember);
  const kids = all.filter((m) => !m.isParent);
  const parents = all.filter((m) => m.isParent);
  const byId: Record<string, Member> = Object.create(null);
  for (const m of all) byId[m.id] = m;
  return {
    kids,
    parents,
    rowOrder: [...kids, ...parents],
    byId,
    memberOf: (id: string) =>
      byId[id] ?? {
        id,
        name: id,
        role: "kid",
        isParent: false,
        age: null,
        preReader: false,
        color: NEUTRAL_COLOR,
        theme: PARENT_THEME,
      },
  };
}

export const PARENT_STATUSES = ["Home", "Office", "City", "Traveling", "Out"] as const;
export type ParentStatus = (typeof PARENT_STATUSES)[number];

export const STATUS_EMOJI: Record<ParentStatus, string> = {
  Home: "🏠",
  Office: "💼",
  City: "🏙️",
  Traveling: "✈️",
  Out: "🚶",
};
