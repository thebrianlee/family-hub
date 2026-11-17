"use client";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}

export default function Modal({ open, onClose, title, children, wide }: ModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-ink-deep/45" onClick={onClose} />
      <div
        className={`relative rounded-hero bg-cream shadow-float p-10 ${
          wide ? "w-[1240px]" : "min-w-[560px] max-w-[1100px]"
        } max-h-[85vh] overflow-hidden flex flex-col animate-pop-in`}
      >
        <div className="flex items-center justify-between mb-7 shrink-0">
          <h2 className="text-5xl font-extrabold tracking-tight">{title}</h2>
          <button
            onClick={onClose}
            className="touch-target w-16 h-16 rounded-card bg-cream-raised shadow-tile text-3xl font-bold text-ink-soft active:bg-cream-sunken"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
