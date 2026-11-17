"use client";

// Member headshot circle. The initial-on-cream fallback sits BEHIND an
// always-opaque image, so a loaded photo simply covers it and a 404 (no
// photo yet) triggers onError to reveal the initial. This avoids the React
// cached-image race where onLoad never fires for an already-cached image.

import { useState } from "react";
import { useMembers } from "./MembersProvider";

interface AvatarProps {
  member: string;
  size?: number;
  className?: string;
}

export default function Avatar({ member, size = 88, className = "" }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const name = useMembers().byId[member]?.name ?? member;
  const initial = (name.charAt(0) || "?").toUpperCase();
  return (
    <div
      className={`relative rounded-full overflow-hidden shrink-0 shadow-tile ${className}`}
      style={{ width: size, height: size }}
    >
      <div
        className="absolute inset-0 flex items-center justify-center bg-cream-sunken text-ink-soft font-extrabold"
        style={{ fontSize: size * 0.42 }}
      >
        {initial}
      </div>
      {!failed && (
         
        <img
          src={`/api/avatars/${encodeURIComponent(member)}.jpg`}
          alt=""
          onError={() => setFailed(true)}
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
    </div>
  );
}
