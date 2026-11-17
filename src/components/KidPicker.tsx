"use client";

// One big color-coded button per kid — shared by Level Up / Reading.

import { KidId } from "@/lib/family";
import { useMembers } from "./MembersProvider";
import Avatar from "./Avatar";

interface KidPickerProps {
  selected: KidId | null;
  onSelect: (kid: KidId) => void;
}

export default function KidPicker({ selected, onSelect }: KidPickerProps) {
  const { kids } = useMembers();
  return (
    <div className="flex gap-5 shrink-0">
      {kids.map((k) => {
        const active = selected === k.id;
        return (
          <button
            key={k.id}
            onClick={() => onSelect(k.id)}
            className={`touch-target flex-1 flex items-center justify-center gap-4 rounded-card py-4 text-4xl font-extrabold transition-all active:scale-[0.97] ${
              active
                ? `${k.theme.bg} text-white shadow-card`
                : `${k.theme.bgSoft} ${k.theme.text} shadow-tile`
            }`}
          >
            <Avatar member={k.id} size={72} className={active ? "ring-4 ring-white/60" : ""} />
            {k.name}
          </button>
        );
      })}
    </div>
  );
}
