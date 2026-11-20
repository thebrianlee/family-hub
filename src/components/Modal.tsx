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
        className={`relative rounded-hero bg-cream shadow-float p-10 max-sm:p-4 ${
          wide ? "w-[min(1240px,calc(100%-2rem))]" : "min-w-[min(560px,calc(100%-1rem))] max-w-[min(1100px,calc(100%-1rem))]"
        } max-h-[calc(85vh/var(--fit,1))] overflow-hidden flex flex-col animate-pop-in`}
      >
        <div className="flex items-center justify-between mb-7 shrink-0">
          <h2 className="text-5xl max-sm:text-3xl font-extrabold tracking-tight">{title}</h2>
          <button
            onClick={onClose}
            className="touch-target w-16 h-16 rounded-card bg-cream-raised shadow-tile text-3xl font-bold text-ink-soft active:bg-cream-sunken"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {/* Scrolls when a dialog is taller than the screen (short or small screens). */}
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
