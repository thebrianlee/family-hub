"use client";

// The household, for client components. The root layout (a server component)
// reads the members table and passes the rows here; useMembers() returns
// { kids, parents, rowOrder, byId, memberOf } with each member's theme.

import { createContext, useContext, useMemo } from "react";
import { buildHousehold, Household, MemberRecord } from "@/lib/family";

const EMPTY = buildHousehold([]);
const MembersContext = createContext<Household>(EMPTY);

export default function MembersProvider({ members, children }: { members: MemberRecord[]; children: React.ReactNode }) {
  const value = useMemo(() => buildHousehold(members), [members]);
  return <MembersContext.Provider value={value}>{children}</MembersContext.Provider>;
}

export function useMembers(): Household {
  return useContext(MembersContext);
}
