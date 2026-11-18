import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import TabNav from "@/components/TabNav";
import Ambient from "@/components/Ambient";
import SetupScreen from "@/components/SetupScreen";
import MembersProvider from "@/components/MembersProvider";
import BlockedScreen from "@/components/BlockedScreen";
import { isDbBlocked } from "@/lib/db";
import { getSetting } from "@/lib/queries";
import { getMembers } from "@/lib/household";
import { memberThemeCss } from "@/lib/member-theme";

// Bundled in the repo (SIL Open Font License, see fonts/OFL.txt) so builds work
// offline and on a Pi, and no request goes to Google at build time.
const jakarta = localFont({
  src: "./fonts/PlusJakartaSans-latin-variable.woff2",
  weight: "200 800",
  variable: "--font-nunito",
  display: "swap",
});

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sproutwall",
  description: "A wall display for one household",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  let ready: boolean;
  try {
    ready = getSetting("setup_complete", "0") === "1";
  } catch (e) {
    if (!isDbBlocked(e)) throw e;
    return (
      <html lang="en" className={jakarta.variable}>
        <body>
          <BlockedScreen code={e.code} />
        </body>
      </html>
    );
  }
  const members = ready ? getMembers() : [];
  return (
    <html lang="en" className={jakarta.variable}>
      <body>
        {ready ? (
          <MembersProvider members={members}>
            {/* One rule per member: .m-<id>{--member:…}. Ids are validated slugs. */}
            <style id="member-colors" dangerouslySetInnerHTML={{ __html: memberThemeCss(members) }} />
            <Ambient>
              <div className="h-screen w-screen flex flex-col">
                <main className="flex-1 min-h-0 px-8 pt-6">{children}</main>
                <TabNav />
              </div>
            </Ambient>
          </MembersProvider>
        ) : (
          <SetupScreen />
        )}
      </body>
    </html>
  );
}
