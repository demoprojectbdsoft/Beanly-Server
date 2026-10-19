import app from "./app";
import { connectDB } from "./config/db";
import { ENV } from "./config/env";

import cron from "node-cron";
import { restoreDemoChanges } from "./modules/demo/demo.service";

async function startServer() {
  await connectDB();

  // Schedule daily restore of demo admin changes at 12:00 AM (midnight)
  cron.schedule("0 0 * * *", async () => {
    console.log("[CRON] 🕒 Running daily demo data restore at 12:00 AM...");
    try {
      const result = await restoreDemoChanges();
      console.log("[CRON] ✅ Demo data restored successfully:", result);
    } catch (err) {
      console.error("[CRON] ❌ Failed to restore demo data:", err);
    }
  });

  app.listen(ENV.PORT, () => {
    console.log(`Server running on port ${ENV.PORT}`);
    console.log(`[CRON] Daily demo restore job scheduled for 12:00 AM`);
  });
}

startServer();