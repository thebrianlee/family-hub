import type { Metadata } from "next";
import { cookies } from "next/headers";
import localFont from "next/font/local";
import "./globals.css";
import TabNav from "@/components/TabNav";
import Ambient from "@/components/Ambient";
import SetupScreen from "@/components/SetupScreen";
import MembersProvider from "@/components/MembersProvider";
import ModulesProvider from "@/components/ModulesProvider";
import BlockedScreen from "@/components/BlockedScreen";
import { isDbBlocked } from "@/lib/db";
import { getSetting } from "@/lib/queries";
import { getMembers } from "@/lib/household";
import { enabledModules, enabledTabs, modulesRev } from "@/lib/modules";
import { memberThemeCss } from "@/lib/member-theme";

import { FIT_SCRIPT } from "./fit-script";
import { screenUnlocked } from "@/lib/session";

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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let ready: boolean;
  try {
    ready = getSetting("setup_complete", "0") === "1";
  } catch (e) {
    if (!isDbBlocked(e)) throw e;
    return (
      <html lang="en" className={jakarta.variable}>
          <head>
            <script dangerouslySetInnerHTML={{ __html: FIT_SCRIPT }} />
          </head>
        <body>
          <BlockedScreen code={e.code} />
        </body>
      </html>
    );
  }
  if (ready) {
    const jar = await cookies();
    if (!screenUnlocked((name) => jar.get(name)?.value)) {
      // A locked screen only ever reaches /unlock: the proxy redirects every
      // other page there. Render it bare. Household members, the module list,
      // the screensaver and the tab bar (which would prefetch locked pages)
      // must not reach a browser that hasn't entered the PIN.
      return (
        <html lang="en" className={jakarta.variable}>
          <head>
            <script dangerouslySetInnerHTML={{ __html: FIT_SCRIPT }} />
          </head>
          <body>
            <main className="screen-fit">{children}</main>
          </body>
        </html>
      );
    }
  }
  const members = ready ? getMembers() : [];
  const modules = ready ? enabledModules() : [];
  const rev = ready ? modulesRev() : 0;
  return (
    <html lang="en" className={jakarta.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: FIT_SCRIPT }} />
      </head>
      <body>
        {ready ? (
          <MembersProvider members={members}>
            <ModulesProvider rev={rev} enabled={modules} tabs={enabledTabs(modules)}>
              {/* One rule per member: .m-<id>{--member:…}. Ids are validated slugs. */}
              <style id="member-colors" dangerouslySetInnerHTML={{ __html: memberThemeCss(members) }} />
              <Ambient>
                <div className="screen-fit flex flex-col">
                  <main className="app-main flex-1 min-h-0 px-8 pt-6">{children}</main>
                  <TabNav />
                </div>
              </Ambient>
            </ModulesProvider>
          </MembersProvider>
        ) : (
          <SetupScreen />
        )}
      </body>
    </html>
  );
}
