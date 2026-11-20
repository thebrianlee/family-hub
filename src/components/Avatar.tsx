"use client";

// Member headshot circle. The initial-on-cream fallback sits BEHIND an
// always-opaque image, so a loaded photo simply covers it and a 404 (no
// photo yet) reveals the initial. This avoids the React cached-image race
// where onLoad never fires for an already-cached image.
//
// The same race hits errors: the server-rendered <img> can 404 before React
// hydrates, and then onError never fires and the browser's broken-image icon
// stays on screen. So the ref also checks, once the image is attached,
// whether it has already finished loading with no picture.

import { useState } from "react";
import { useMembers } from "./MembersProvider";

interface AvatarProps {
  member: string;
  size?: number;
  className?: string;
}

export default function Avatar({ member, size = 88, className = "" }: AvatarProps) {
  // Keyed by member, so a reused Avatar showing someone else tries their photo.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = failedFor === member;
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
          ref={(img) => {
            if (img && img.complete && img.naturalWidth === 0) setFailedFor(member);
          }}
          src={`/api/avatars/${encodeURIComponent(member)}.jpg`}
          alt=""
          onError={() => setFailedFor(member)}
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
    </div>
  );
}
