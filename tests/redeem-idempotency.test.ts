import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";

import { POST } from "@/app/api/balance/route";
import { hashPin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { redeemReward, setSetting } from "@/lib/queries";
import { PARENT_COOKIE, signCookie } from "@/lib/session";

const balance = (kid: string) =>
  (getDb().prepare("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE kid=?").get(kid) as { s: number }).s;
const charges = (kid: string) =>
  (getDb().prepare("SELECT COUNT(*) c FROM ledger WHERE kid=? AND source='redeem'").get(kid) as { c: number }).c;

let rewardId = 0;
beforeAll(() => {
  rewardId = Number(
    getDb().prepare("INSERT INTO rewards (label, emoji, cost) VALUES ('Sticker', '⭐', 10)").run().lastInsertRowid
  );
  for (const kid of ["riley", "quinn", "sam"]) {
    getDb().prepare("INSERT INTO ledger (kid, amount, source, label) VALUES (?, 100, 'test', 'top-up')").run(kid);
  }
  const h = hashPin("5938");
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
});

describe("redeemReward with an operation key", () => {
  it("charges once when the same key arrives twice, and answers the same both times", () => {
    const before = balance("riley");
    const op = "op-same-key-0001";
    expect(redeemReward("riley", rewardId, op)).toEqual({ ok: true });
    expect(redeemReward("riley", rewardId, op)).toEqual({ ok: true });
    expect(balance("riley")).toBe(before - 10);
    expect(charges("riley")).toBe(1);
  });

  it("charges twice for two different keys", () => {
    const before = balance("quinn");
    expect(redeemReward("quinn", rewardId, "op-first-tap-0001")).toEqual({ ok: true });
    expect(redeemReward("quinn", rewardId, "op-second-tap-002")).toEqual({ ok: true });
    expect(balance("quinn")).toBe(before - 20);
  });

  it("binds the key to the kid and reward: reusing it elsewhere is a new charge, not a silent skip", () => {
    const before = balance("sam");
    expect(redeemReward("riley", rewardId, "op-shared-key-01")).toEqual({ ok: true });
    expect(redeemReward("sam", rewardId, "op-shared-key-01")).toEqual({ ok: true });
    expect(balance("sam")).toBe(before - 10);
  });

  it("still works without a key, and records nothing for it", () => {
    const ops = () => (getDb().prepare("SELECT COUNT(*) c FROM ledger_ops").get() as { c: number }).c;
    const [before, opsBefore] = [balance("sam"), ops()];
    expect(redeemReward("sam", rewardId)).toEqual({ ok: true });
    expect(balance("sam")).toBe(before - 10);
    expect(ops()).toBe(opsBefore);
  });

  it("does not record a key whose redemption was refused, so it can be retried", () => {
    const pricey = Number(
      getDb().prepare("INSERT INTO rewards (label, emoji, cost) VALUES ('Bike', '🚲', 1000)").run().lastInsertRowid
    );
    const op = "op-not-enough-001";
    expect(redeemReward("sam", pricey, op)).toEqual({ ok: false, error: "Not enough saved up yet" });
    getDb().prepare("INSERT INTO ledger (kid, amount, source, label) VALUES ('sam', 1000, 'test', 'top-up')").run();
    const before = balance("sam");
    expect(redeemReward("sam", pricey, op)).toEqual({ ok: true });
    expect(balance("sam")).toBe(before - 1000);
  });
});

describe("the redeem request", () => {
  const redeem = (extra: Record<string, unknown>) =>
    POST(
      new NextRequest("http://hub.home/api/balance", {
        method: "POST",
        headers: {
          host: "hub.home",
          origin: "http://hub.home",
          "content-type": "application/json",
          cookie: `${PARENT_COOKIE}=${signCookie("parent")}`,
        },
        body: JSON.stringify({ action: "redeem", kid: "riley", rewardId, ...extra }),
      })
    );

  it("sent twice with the same opId charges once", async () => {
    const before = balance("riley");
    const op = "00000000-0000-4000-8000-000000000001";
    expect((await redeem({ opId: op })).status).toBe(200);
    expect((await redeem({ opId: op })).status).toBe(200);
    expect(balance("riley")).toBe(before - 10);
  });

  it("refuses a malformed opId without charging, and works without one", async () => {
    const before = balance("riley");
    expect((await redeem({ opId: "x" })).status).toBe(400);
    expect((await redeem({ opId: 42 })).status).toBe(400);
    expect(balance("riley")).toBe(before);
    expect((await redeem({})).status).toBe(200);
    expect(balance("riley")).toBe(before - 10);
  });
});
