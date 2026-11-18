import type { DbBlockedCode } from "@/lib/db";

// Shown instead of the app when the database must not be used (lib/db.ts
// DbBlockedError). Nothing reads or writes household data while this is up.
const TEXT: Record<DbBlockedCode, { title: string; body: string[] }> = {
  db_newer_than_app: {
    title: "This hub needs an update",
    body: [
      "Its data was saved by a newer version of the app than the one running now. To keep the data safe, the hub won't open it.",
      "Update the app to the newest version, or restore the backup you made before going back to this version.",
    ],
  },
  low_disk: {
    title: "Not enough space to update safely",
    body: [
      "Before an update changes your data, the hub makes a backup copy. There isn't enough free space for it, so nothing was changed.",
      "Free up some space on the hub's storage (or use a bigger card), then restart the hub.",
    ],
  },
  backup_failed: {
    title: "The update is paused",
    body: [
      "Before an update changes your data, the hub makes and checks a backup copy. That didn't work, so nothing was changed.",
      "Restart the hub to try again. If this keeps showing, check the hub's storage.",
    ],
  },
};

export default function BlockedScreen({ code }: { code: DbBlockedCode }) {
  const t = TEXT[code];
  return (
    <div className="h-screen w-screen flex items-center justify-center p-12">
      <div className="card max-w-3xl p-12 text-center">
        <h1 className="text-5xl font-extrabold tracking-tight">{t.title}</h1>
        {t.body.map((line) => (
          <p key={line} className="mt-6 text-2xl text-ink-soft">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
