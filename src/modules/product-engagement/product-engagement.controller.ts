import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import { ENGAGEMENT_TYPES, getEngagementReport, recordEngagement } from "./product-engagement.service";
import type { EngagementType } from "./product-engagement.service";

/** Keeps a hand-typed range inside what the counters can honestly answer. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Public: one look at one listing.
 *
 * Anyone can call it, because anyone can browse the shop. The body only chooses
 * between the two counters; nothing about the product is written from here.
 */
export const trackEngagement = catchAsync(async (req, res) => {
  const raw = String((req.body as any)?.type || "view");
  const type: EngagementType = (ENGAGEMENT_TYPES as readonly string[]).includes(raw)
    ? (raw as EngagementType)
    : "view";

  const result = await recordEngagement(String(req.params.productId), type, req.user?.id);
  apiResponse(res, 201, result, result.counted ? "Recorded" : "Own listing — not counted");
});

/** Admin: the whole catalogue's attention, by product. */
export const getAdminEngagement = catchAsync(async (req, res) => {
  const range = clamp(Number(req.query.range) || 30, 1, 365);
  const limit = clamp(Number(req.query.limit) || 10, 1, 50);

  const report = await getEngagementReport({ range, limit });
  apiResponse(res, 200, report, "Engagement fetched successfully");
});
