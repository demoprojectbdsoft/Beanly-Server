import { ClientSession } from "mongoose";
import { Warranty } from "./warranty.model";
import { Product } from "../product/product.model";
import { Order } from "../order/order.model";
import { ApiError } from "../../utils/apiError";
import { refIdString } from "../../utils/ids";
import {
  SubmitWarrantyClaimInput,
  AdminUpdateClaimInput,
  EmailWarrantyInput,
  ExtendWarrantyInput,
  GetWarrantiesQuery,
} from "./warranty.validator";
import {
  IssuedWarranty,
  notifyClaimSubmitted,
  notifyClaimUpdated,
  notifyWarrantyExtended,
  sendWarrantyMessage,
} from "./warranty.notifications";
import {
  describeWarrantyType,
  extensionsLeft,
  hasWarrantyCoverage,
  isExtendableWarrantyType,
  isWarrantyType,
  MAX_WARRANTY_EXTENSIONS,
} from "./warranty.types";

/**
 * Statuses that still have a claim an admin may move forward. `active` has no
 * claim yet, and `resolved` / `expired` are closed for good.
 */
const OPEN_CLAIM_STATUSES = ["claim_submitted", "under_review"];

/**
 * Every status a record only reaches after a customer filed a claim. `active`
 * means nobody has claimed yet, and `expired` can also mean the date simply
 * passed or the order went back, so neither of those belongs to this group.
 */
const CLAIMED_STATUSES = [...OPEN_CLAIM_STATUSES, "resolved"];

/**
 * Add `months` calendar months to a date, clamped to the last valid day of the
 * target month so that e.g. Jan 31 + 1 month lands on Feb 28/29 (not Mar 3).
 */
function addMonthsClamped(from: Date, months: number): Date {
  const target = new Date(from);
  const day = target.getDate();
  target.setDate(1);
  target.setMonth(target.getMonth() + months);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

/**
 * A warranty only exists because the store delivered the goods. Once the order
 * is cancelled (a returned delivery is cancelled too) the coverage is gone for
 * good, whatever the record itself says — a claim rejected before the return
 * still reads "rejected", so the closed reason alone cannot be trusted here.
 */
async function assertOrderStillCovered(orderId: any) {
  const id = refIdString(orderId);
  if (!id) return;

  const order: any = await Order.findById(id).select("orderStatus").lean();
  if (order && order.orderStatus === "cancelled") {
    throw new ApiError(
      400,
      "This warranty was closed because the order was cancelled or returned"
    );
  }
}

/**
 * Report an "active" warranty that has already passed its expiry date as
 * expired. The status column is only rewritten by the daily sweep, so this
 * keeps responses honest on hosts where the sweep has not run yet.
 *
 * The reason is filled in as well, so the screens can say "expired on this
 * date" instead of showing a bare Expired badge.
 */
function withEffectiveStatus<T extends { status?: string; expiryDate?: any }>(w: T): T {
  if (w?.status === "active" && w.expiryDate && new Date(w.expiryDate) < new Date()) {
    return { ...w, status: "expired", closedReason: "date" };
  }
  return w;
}

/**
 * Create warranty records for every item in a delivered order that has a
 * warranty period configured on the product. Called from the order service
 * when an order transitions to "delivered".
 *
 * Idempotent: a warranty is only created once per (user, product, order).
 */
export async function createWarrantiesForOrder(
  orderId: string,
  userId: string,
  items: { productId: any; quantity?: number }[],
  session?: ClientSession
): Promise<IssuedWarranty[]> {
  // The summaries go back to the caller so the confirmation email can be sent
  // after the order has actually been committed.
  const created: IssuedWarranty[] = [];
  for (const item of items || []) {
    const productId = refIdString(item?.productId);
    if (!productId) continue;

    const product = session
      ? await Product.findById(productId).session(session).lean()
      : await Product.findById(productId).lean();
    if (!product) continue;
    const months = Number(product.warrantyPeriodMonths || 0);
    // Coverage needs both halves of the promise: a type that includes coverage
    // and a period to count from. A "No warranty" product never leaves an
    // empty record behind, and a leftover type with 0 months is ignored too.
    if (!hasWarrantyCoverage(product.warrantyType, months)) continue;
    const warrantyType = isWarrantyType(product.warrantyType) ? product.warrantyType : "other";

    // One warranty per (user, product, order) — never duplicate on re-delivery.
    const existing = session
      ? await Warranty.findOne({ userId, productId, orderId }).session(session)
      : await Warranty.findOne({ userId, productId, orderId });
    if (existing) continue;

    const activationDate = new Date();
    const expiryDate = addMonthsClamped(activationDate, months);

    const warranty = new Warranty({
      userId,
      productId,
      orderId,
      activationDate,
      expiryDate,
      status: "active",
      // Snapshot the product's warranty terms. The claim screens read these
      // when the product itself is no longer available.
      warrantyType,
      warrantyPeriodMonths: months,
      warrantyTerms: product.warrantyTerms,
    });
    await warranty.save({ session });
    created.push({
      productTitle: product.title,
      warrantyType,
      warrantyPeriodMonths: months,
      warrantyTerms: product.warrantyTerms,
      expiryDate,
    });
  }
  return created;
}

/**
 * Re-evaluate warranty statuses that have passed their expiry date.
 */
export async function expireStaleWarranties(): Promise<number> {
  const result = await Warranty.updateMany(
    {
      status: "active",
      expiryDate: { $lte: new Date() },
    },
    { $set: { status: "expired", closedReason: "date" } }
  );
  return result.modifiedCount || 0;
}

/**
 * Close out every open warranty that belongs to an order. Called when a
 * delivered order is cancelled or returned, so the customer cannot keep
 * claiming coverage for goods they no longer own.
 */
export async function voidWarrantiesForOrder(
  orderId: string,
  session?: ClientSession
): Promise<number> {
  const result = await Warranty.updateMany(
    {
      orderId,
      status: { $in: ["active", "claim_submitted", "under_review"] },
    },
    // "void" is its own reason: these goods went back, so no extension can
    // ever bring the coverage back to life.
    { $set: { status: "expired", closedReason: "void" } },
    { session }
  );
  return result.modifiedCount || 0;
}

/**
 * Fetch the single warranty record for one (user, order, product) triple.
 * Returns null when no warranty exists — the caller decides what to show.
 */
export async function getWarrantyForOrderItem(
  orderId: string,
  productId: string,
  userId: string
) {
  const warranty = await Warranty.findOne({
    orderId,
    productId,
    userId,
  })
    .populate("productId", "title slug image price warrantyPeriodMonths warrantyType warrantyTerms")
    .populate("orderId", "orderStatus totalAmount orderNumber")
    .lean();

  if (!warranty) return null;

  return formatWarranty(warranty);
}

/**
 * Fetch warranties for a customer, optionally filtered by status.
 *
 * `productIds` narrows the list to one seller's own listings. It is set by the
 * controller from the caller's id, never by the query string, so a vendor can
 * only ever read the warranties of products they own.
 */
export async function getWarranties(
  query: GetWarrantiesQuery & { productIds?: string[] }
) {
  const { userId, productId, orderId, status, warrantyType, productIds, page, limit } = query;
  const filter: any = {};
  if (userId) filter.userId = userId;
  // The seller scope wins over the single-product filter: asking for a product
  // that is not theirs simply finds nothing instead of widening the list.
  if (productIds) {
    filter.productId = productId
      ? { $in: productIds.filter((id) => id === productId) }
      : { $in: productIds };
  } else if (productId) {
    filter.productId = productId;
  }
  if (orderId) filter.orderId = orderId;
  // The type lives beside the status, so both filters simply narrow the same
  // list and can be used together.
  if (warrantyType) filter.warrantyType = warrantyType;
  if (status) {
    // "claimed" is a group, not a status: it answers "what came in from
    // customers?", which is what the admin screen opens on. Everything else is
    // matched exactly, so an unknown value simply finds nothing.
    filter.status = status === "claimed" ? { $in: CLAIMED_STATUSES } : status;
  }

  const skip = (page - 1) * limit;
  const [warranties, total] = await Promise.all([
    Warranty.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("productId", "title slug image price warrantyPeriodMonths warrantyType warrantyTerms")
      .populate("orderId", "orderStatus totalAmount orderNumber")
      .populate("userId", "name email")
      .lean(),
    Warranty.countDocuments(filter),
  ]);

  return {
    warranties: warranties.map((w) => withEffectiveStatus(w)),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/**
 * A customer submits a claim for one of their own warranties.
 * Server-side checks:
 *   - the warranty exists and belongs to the caller
 *   - the warranty is still active (not expired, not already claimed)
 */
export async function submitClaim(
  warrantyId: string,
  data: SubmitWarrantyClaimInput,
  userId: string
) {
  const warranty = await Warranty.findById(warrantyId);
  if (!warranty) throw new ApiError(404, "Warranty not found");
  if (warranty.userId.toString() !== userId) {
    throw new ApiError(403, "You can only claim your own warranty");
  }
  // Defensive: a record with no coverage should not exist any more, but one
  // written before these rules could still be sitting there. Checked first,
  // because "there was never any cover" is the real reason.
  if (!hasWarrantyCoverage(warranty.warrantyType, warranty.warrantyPeriodMonths)) {
    throw new ApiError(400, "This item was sold without warranty coverage");
  }
  await assertOrderStillCovered(warranty.orderId);
  if (warranty.closedReason === "void") {
    throw new ApiError(
      400,
      "This warranty was closed because the order was cancelled or returned"
    );
  }
  // Only an untouched record takes a claim. Anything already claimed stays
  // closed to further submissions, so one order line never holds two claims.
  if (warranty.status !== "active") {
    throw new ApiError(400, "This warranty is no longer active");
  }
  if (warranty.expiryDate && warranty.expiryDate < new Date()) {
    throw new ApiError(400, "This warranty has expired");
  }

  warranty.status = "claim_submitted";
  // Optional: only stored when the caller sent a code, so a claim made from the
  // current form leaves the field empty instead of saving `undefined`.
  if (data.problem) warranty.claimProblem = data.problem;
  warranty.claimReason = data.reason;

  warranty.claimDescription = data.description;
  warranty.claimImages = data.images || [];

  await warranty.save();

  // Sent after the write, and it never throws, so a mail problem can never undo
  // a claim the customer just filed.
  await notifyClaimSubmitted(warranty);

  return formatWarranty(warranty);
}

/**
 * A vendor may only act on warranties of products they listed.
 *
 * The store team keeps its bypass — no id means an admin — but a seller's id
 * turns the warranty's product into a permission check, so one shop can never
 * resolve, reject, email or extend another shop's claim.
 */
async function assertWarrantyOwner(warranty: any, vendorId?: string) {
  if (!vendorId) return;
  const product = await Product.findById(warranty.productId).select("vendorId").lean();
  if (!product || String((product as any).vendorId) !== String(vendorId)) {
    throw new ApiError(403, "This warranty belongs to another seller's product");
  }
}

/**
 * Admin actions on a claim.
 *   mark_under_review -> status = under_review
 *   resolve           -> status = resolved, resolution recorded
 *   reject            -> status = expired (claim rejected, warranty consumed)
 *
 * A vendor calling this is held to their own listings by `assertWarrantyOwner`.
 */
export async function adminUpdateClaim(
  warrantyId: string,
  data: AdminUpdateClaimInput,
  vendorId?: string
) {
  const warranty = await Warranty.findById(warrantyId);
  if (!warranty) throw new ApiError(404, "Warranty not found");
  await assertWarrantyOwner(warranty, vendorId);

  // Every action may only move an open claim. Without this check the API would
  // happily "resolve" a warranty that was never claimed, or reopen a closed one.
  if (!OPEN_CLAIM_STATUSES.includes(warranty.status)) {
    const reason =
      warranty.status === "resolved"
        ? "This claim is already resolved"
        : warranty.status === "expired"
          ? "This claim is closed, so no further action can be taken"
          : "No claim has been submitted for this warranty yet";
    throw new ApiError(400, reason);
  }

  // The UI already asks for these, but the API must not accept a silent no-op.
  const note = data.adminNote?.trim();
  const resolution = data.resolution?.trim();

  if ((data.action === "resolve" || data.action === "reject") && !resolution && !note) {
    throw new ApiError(400, "Provide resolution details or an admin note");
  }

  switch (data.action) {
    case "mark_under_review":
      warranty.status = "under_review";
      break;
    case "resolve":
      warranty.status = "resolved";
      warranty.resolutionDetails = resolution || note || "";
      break;
    case "reject":
      warranty.status = "expired";
      // Rejected is not the same as lapsed: the date may still be far away, so
      // the reason is stored and an extension must not reopen it.
      warranty.closedReason = "rejected";
      warranty.resolutionDetails = resolution || note || "Claim rejected";
      break;
    default:
      throw new ApiError(400, "Unknown action");
  }

  // An empty note never wipes what an earlier admin wrote.
  if (note) warranty.claimAdminNote = note;

  await warranty.save();

  // The customer learns the decision by email as well as in the dashboard.
  await notifyClaimUpdated(warranty);

  return formatWarranty(warranty);
}

/**
 * Emails the customer about one warranty on behalf of an admin. The address is
 * read from the warranty record, so a request can never pick a different one.
 */
export async function emailWarrantyCustomer(
  warrantyId: string,
  data: EmailWarrantyInput,
  vendorId?: string
): Promise<{ to: string }> {
  const warranty = await Warranty.findById(warrantyId);
  if (!warranty) throw new ApiError(404, "Warranty not found");
  await assertWarrantyOwner(warranty, vendorId);

  const result = await sendWarrantyMessage(warranty, data.subject, data.message);
  if (!result.to) {
    throw new ApiError(400, "This customer has no email address on file");
  }
  if (!result.sent) {
    // The mail server's own reason is passed on, so "the login was rejected"
    // reaches the admin instead of a message that only says "it failed".
    throw new ApiError(
      502,
      result.error
        ? `The email could not be sent: ${result.error}`
        : "The email could not be sent. Check the mail settings and try again."
    );
  }

  return { to: result.to };
}

/**
 * Admin extends the coverage of one warranty.
 *
 * The months are added to whichever is later: the date already stored, or
 * today. A lapsed warranty therefore gains real months instead of months that
 * are already in the past.
 */
export async function extendWarranty(
  warrantyId: string,
  data: ExtendWarrantyInput,
  actor?: { name?: string; email?: string },
  vendorId?: string
) {
  const warranty = await Warranty.findById(warrantyId);
  if (!warranty) throw new ApiError(404, "Warranty not found");
  await assertWarrantyOwner(warranty, vendorId);

  // The route validates the body, but the service is the last line of defence:
  // a zero or negative count would quietly write a useless extension.
  if (!Number.isInteger(data.months) || data.months < 1) {
    throw new ApiError(400, "Add at least one month");
  }
  if (data.months > 60) {
    throw new ApiError(400, "At most 60 months can be added at a time");
  }

  // A warranty covers a repair, it is not a subscription. The record keeps a
  // short history of extensions and refuses to grow past that history.
  if ((warranty.extensions?.length || 0) >= MAX_WARRANTY_EXTENSIONS) {
    throw new ApiError(
      400,
      `This warranty has already been extended ${MAX_WARRANTY_EXTENSIONS} times, which is the most we allow`
    );
  }

  // Nothing was promised, so there is nothing to lengthen.
  if (!hasWarrantyCoverage(warranty.warrantyType, warranty.warrantyPeriodMonths)) {
    throw new ApiError(
      400,
      "This item was sold without warranty coverage, so there is nothing to extend"
    );
  }

  // Extension belongs to the Extended warranty. A manufacturer or seller
  // warranty covers exactly the period it was sold with, so it stays untouched.
  if (!isExtendableWarrantyType(warranty.warrantyType)) {
    throw new ApiError(
      400,
      "Only an extended warranty can be extended, so this coverage stays as it is"
    );
  }
  await assertOrderStillCovered(warranty.orderId);
  if (warranty.closedReason === "void") {
    throw new ApiError(
      400,
      "This warranty was closed because the order was cancelled or returned"
    );
  }

  const now = new Date();
  const previousExpiryDate = warranty.expiryDate ? new Date(warranty.expiryDate) : now;
  const base = previousExpiryDate > now ? previousExpiryDate : now;
  const newExpiryDate = addMonthsClamped(base, data.months);

  warranty.expiryDate = newExpiryDate;
  warranty.extensions.push({
    months: data.months,
    previousExpiryDate,
    newExpiryDate,
    reason: data.reason,
    extendedBy: actor?.name || actor?.email || "Admin",
    createdAt: now,
  });

  // A warranty that only lapsed by date becomes usable again. A rejected claim
  // stays closed: that decision was about the claim, not about the calendar.
  if (
    warranty.status === "expired" &&
    warranty.closedReason === "date" &&
    !warranty.claimReason
  ) {
    warranty.status = "active";
    warranty.closedReason = undefined;
  }

  await warranty.save();

  // Best effort, like every other warranty email.
  await notifyWarrantyExtended(warranty, {
    months: data.months,
    previousExpiryDate,
    newExpiryDate,
    reason: data.reason,
  });

  return formatWarranty(warranty);
}

function formatWarranty(w: any) {
  return withEffectiveStatus({
    id: w._id.toString(),
    userId: w?.userId?.toString?.(),
    productId: refIdString(w?.productId),
    orderId: refIdString(w?.orderId),
    activationDate: w.activationDate,
    expiryDate: w.expiryDate,
    status: w.status,
    // Why it is closed, when it is: date, rejected or void.
    closedReason: w.closedReason,
    warrantyType: w.warrantyType,
    warrantyTypeLabel: describeWarrantyType(w.warrantyType).label,
    warrantyPeriodMonths: w.warrantyPeriodMonths,
    warrantyTerms: w.warrantyTerms,
    // Oldest first, so a screen can read them like a timeline.
    extensions: Array.isArray(w.extensions)
      ? w.extensions.map((entry: any) => ({
          months: entry.months,
          previousExpiryDate: entry.previousExpiryDate,
          newExpiryDate: entry.newExpiryDate,
          reason: entry.reason,
          extendedBy: entry.extendedBy,
          createdAt: entry.createdAt,
        }))
      : [],
    // How many extensions the record may still take, so a screen can disable
    // the button without hardcoding the limit.
    maxExtensions: MAX_WARRANTY_EXTENSIONS,
    extensionsLeft: extensionsLeft(w.extensions),
    claimProblem: w.claimProblem,
    claimReason: w.claimReason,
    claimDescription: w.claimDescription,
    claimImages: Array.isArray(w.claimImages) ? w.claimImages : [],
    claimAdminNote: w.claimAdminNote,
    resolutionDetails: w.resolutionDetails,
  });
}