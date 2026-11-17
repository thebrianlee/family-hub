"use client";

// A member's color identity as an initial-in-circle. Sizes to `size` px.
import { useMembers } from "./MembersProvider";

export default function MemberBadge({ member, size = 26 }: { member: string; size?: number }) {
  const m = useMembers().memberOf(member);
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-extrabold text-white shrink-0"
      style={{ width: size, height: size, background: m.color, fontSize: size * 0.5 }}
      title={m.name}
      aria-hidden="true"
    >
      {m.name.charAt(0).toUpperCase()}
    </span>
  );
}
