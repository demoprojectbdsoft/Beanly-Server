import app from "./app";
import { connectDB } from "./config/db";
import { ENV } from "./config/env";

import cron from "node-cron";
import { restoreDemoChanges } from "./modules/demo/demo.service";
import { expireStaleDeliveries } from "./modules/delivery/delivery.service";
import { expireDueSubscriptions } from "./modules/vendor/vendor-subscription.service";
import { expireDuePromotions } from "./modules/vendor/featured-promotion.service";
import { syncLegacyRoles, ensureDemoAdmin } from "./modules/user/user.service";

async function startServer() {
  await connectDB();

  // One-off sweep that gives every pre-multi-role row a `roles` array and an
  // `activeRole` mirror. It is idempotent, so a restart never re-touches an
  // account that already fits the shape. The rider and vendor approval paths
  // also `$addToSet` on their own, so a row that slipped past this sweep still
  // gains the entries it needs on its next state change.
  try {
    const migrated = await syncLegacyRoles();
    if (migrated.updated > 0) {
      console.log(`[STARTUP] Multi-role migration touched ${migrated.updated} account(s)`);
    }
  } catch (err) {
    console.error("[STARTUP] Multi-role migration failed:", err);
  }

  // The advertised demo login is only an admin once this grants it the
  // `demoadmin` role; a plain sign-up leaves it a customer. Runs after the
  // migration so the sweep can never add a stray `customer` entry back.
  try {
    const demo = await ensureDemoAdmin();
    if (demo.promoted) {
      console.log("[STARTUP] Demo admin account promoted to `demoadmin`");
    }
  } catch (err) {
    console.error("[STARTUP] Demo admin seeding failed:", err);
  }

  const timezone = process.env.CRON_TIMEZONE || "Asia/Dhaka";

  // Schedule daily restore of demo admin changes at 12:00 AM (midnight local time)
  cron.schedule(
    "0 0 * * *",
    async () => {
      console.log("[CRON] 🕒 Running daily demo data restore at 12:00 AM...");
      try {
        const result = await restoreDemoChanges();
        console.log("[CRON] ✅ Demo data restored successfully:", result);
      } catch (err) {
        console.error("[CRON] ❌ Failed to restore demo data:", err);
      }
    },
    { timezone }
  );

  // Delivery requests that nobody answered: every ten minutes, because a rider
  // has a thirty-minute window. The accept endpoint refuses an expired offer on
  // its own, so this only keeps the board honest.
  cron.schedule(
    "*/10 * * * *",
    async () => {
      try {
        const result = await expireStaleDeliveries();
        if (result.expired > 0) {
          console.log("[CRON] ⏳ Expired delivery requests:", result.expired);
        }
      } catch (err) {
        console.error("[CRON] ❌ Failed to expire deliveries:", err);
      }
    },
    { timezone }
  );

  // Each job keeps its own schedule so one failing sweep can never skip another.
  // A period is closed before the shelves are dimmed, because ending a plan also
  // ends the placements it bought.
  cron.schedule(
    "45 0 * * *",
    async () => {
      try {
        const result = await expireDueSubscriptions();
        if (result.expired > 0) {
          console.log("[CRON] ⏳ Lapsed vendor periods closed:", result.expired);
        }
      } catch (err) {
        console.error("[CRON] ❌ Failed to expire vendor subscriptions:", err);
      }
    },
    { timezone }
  );

  // Featured placements past their date come off the shelves, and whatever they
  // lifted stops reading as featured. Also exposed as GET /api/promotions/expire.
  cron.schedule(
    "0 1 * * *",
    async () => {
      try {
        const result = await expireDuePromotions();
        if (result.expired > 0) {
          console.log("[CRON] ⏳ Lapsed featured placements closed:", result.expired);
        }
      } catch (err) {
        console.error("[CRON] ❌ Failed to expire featured placements:", err);
      }
    },
    { timezone }
  );

  app.listen(ENV.PORT, () => {
    console.log(`Server running on port ${ENV.PORT}`);
    console.log(
      `[CRON] Demo restore 12:00 AM · vendor periods 12:45 AM · placements 1:00 AM · deliveries every 10 min`
    );
  });
}

startServer();