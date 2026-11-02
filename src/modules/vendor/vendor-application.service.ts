import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { ApiError } from "../../utils/apiError";
import { applySection } from "../../utils/profilePatch";
import { withTransaction } from "../../utils/transactions";
import { User } from "../user/user.model";
import { VendorApplication } from "./vendor-application.model";
import { VendorStore } from "./vendor-store.model";
import { updateMyStore } from "./vendor-store.service";
import { SubscriptionTransaction, VendorSubscription } from "./vendor-subscription.model";
import { notifyAdminVendorApplication, notifyVendorApplication } from "./vendor.notifications";
import { getPlan } from "./vendor-plan.service";
import { billingDays } from "./vendor.types";
import { normalizeRoles } from "../../utils/roles";
import { APPLICATION_SECTIONS } from "./vendor-application.validator";
import type { UpdateStoreInput } from "./vendor-store.validator";
import type {
  CreateApplicationInput,
  ReviewApplicationInput,
  UpdateMyApplicationInput,
  VendorApplicationQuery,
} from "./vendor-application.validator";

/**
 * The application lifecycle, start to finish.
 *
 * Everything here is enforced on the server: whether a person may apply, what
 * a submission may contain, who may review it, and what an approval is allowed
 * to change. The screens call these functions; they never decide for
 * themselves.
 */

/** "APP-4F9C21" — the reference an applicant quotes to support. */
function newReference(): string {
  return `APP-${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** "My Store & Co" -> "my-store-co". */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Refuses a slug or store name somebody else already holds.
 *
 * A rejected application does not reserve anything, so the only rows compared
 * against are live applications and real stores.
 */
async function assertStoreIdentityFree(slug: string, name: string, applicantId: string) {
  const [slugStore, nameStore, slugApplication, nameApplication] = await Promise.all([
    VendorStore.findOne({ slug }).select("userId").lean(),
    VendorStore.findOne({ name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } })
      .select("userId")
      .lean(),
    VendorApplication.findOne({
      "storeInfo.slug": slug,
      status: { $in: ["pending", "under_review", "approved"] },
    })
      .select("userId")
      .lean(),
    VendorApplication.findOne({
      "storeInfo.name": { $regex: `^${escapeRegex(name)}$`, $options: "i" },
      status: { $in: ["pending", "under_review", "approved"] },
    })
      .select("userId")
      .lean(),
  ]);

  const someoneElse = (row: any) => row && String(row.userId) !== applicantId;

  if (someoneElse(slugStore) || someoneElse(slugApplication)) {
    throw new ApiError(409, "That store link is already taken. Choose another one.");
  }
  if (someoneElse(nameStore) || someoneElse(nameApplication)) {
    throw new ApiError(409, "That store name is already taken. Choose another name.");
  }
}

/** Loads the account behind an application and refuses the wrong roles. */
async function loadApplicant(userId: string) {
  const user: any = await User.findById(userId).lean();
  if (!user) throw new ApiError(404, "Account not found");
  return user;
}

/**
 * Whether this account may open a vendor application.
 *
 * Admins do not convert, and a vendor already has a shop. A customer — or a
 * customer who is also an approved rider — may apply, because the multi-role
 * design lets one account hold both authorities at once.
 */
function assertCanApply(user: any) {
  const pool = normalizeRoles(user.roles);
  const legacy = pool.length > 0 ? pool : normalizeRoles(user.role || "customer");
  if (legacy.includes("admin") || legacy.includes("demoadmin")) {
    throw new ApiError(403, "Administrator accounts cannot apply to become a vendor");
  }
  if (legacy.includes("vendor") || user.vendorStoreId) {
    throw new ApiError(409, "This account already owns a store");
  }
}

/** The summary every screen shows, wherever the application is read from. */
export function toApplicationDto(application: any) {
  if (!application) return null;
  return {
    _id: String(application._id),
    reference: application.reference,
    status: application.status,
    personalInfo: application.personalInfo,
    storeInfo: application.storeInfo,
    businessAddress: application.businessAddress,
    verification: application.verification,
    selectedPlan: application.selectedPlan,
    billingCycle: application.billingCycle,
    rejectionReason: application.rejectionReason || "",
    reviewNotes: application.reviewNotes || "",
    reviewedAt: application.reviewedAt || null,
    submittedAt: application.submittedAt,
    resubmissionCount: application.resubmissionCount || 0,
    storeId: application.storeId ? String(application.storeId) : null,
    history: (application.history || []).map((event: any) => ({
      status: event.status,
      at: event.at,
      note: event.note || "",
    })),
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
  };
}

/**
 * Creates or refreshes the application of one customer.
 *
 * A customer converting from an existing account is the same call as a new
 * sign-up: the row is linked to the account's own id, so no second account is
 * ever made and every order, review and wallet balance stays where it was.
 *
 * A rejected applicant who applies again updates that same row, which keeps
 * their reference stable and leaves the earlier review in `history`.
 */
export async function submitApplication(userId: string, input: CreateApplicationInput) {
  const user = await loadApplicant(userId);
  assertCanApply(user);

  const existing: any = await VendorApplication.findOne({
    userId,
    status: { $in: ["pending", "under_review", "approved"] },
  });

  if (existing) {
    throw new ApiError(
      409,
      existing.status === "approved"
        ? "Your vendor application is already approved"
        : "You already have an application waiting for review"
    );
  }

  const name = input.storeInfo.name.trim();
  const slug = slugify(input.storeInfo.slug || name);
  if (!slug) throw new ApiError(400, "Store link is required");

  await assertStoreIdentityFree(slug, name, userId);

  const plan = await getPlan(input.selectedPlan);
  if (!plan.isActive) throw new ApiError(400, "That plan is not available");

  const rejected: any = await VendorApplication.findOne({
    userId,
    status: { $in: ["rejected", "cancelled"] },
  }).sort({ createdAt: -1 });

  const now = new Date();
  const payload = {
    personalInfo: input.personalInfo,
    storeInfo: { ...input.storeInfo, name, slug },
    businessAddress: input.businessAddress,
    verification: input.verification || {},
    selectedPlan: input.selectedPlan,
    billingCycle: input.billingCycle,
    status: "pending" as const,
    submittedAt: now,
    // A fresh review has to start clean: the old reason belongs to the old try.
    rejectionReason: "",
    reviewNotes: "",
    reviewedBy: null,
    reviewedAt: null,
  };

  let application: any;
  if (rejected) {
    Object.assign(rejected, payload, {
      resubmissionCount: (rejected.resubmissionCount || 0) + 1,
    });
    rejected.history.push({ status: "pending", at: now, note: "Resubmitted" });
    application = await rejected.save();
  } else {
    application = await VendorApplication.create({
      ...payload,
      userId,
      reference: newReference(),
      history: [{ status: "pending", at: now, note: "Application submitted" }],
    });
  }

  // The account keeps its customer role; only its marketplace state changes.
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        vendorStatus: "pending",
        vendorApplicationId: application._id,
        // A display name is the one personal detail worth copying over.
        name: user.name || input.personalInfo.fullName,
        phone: user.phone || input.personalInfo.phone || undefined,
      },
    }
  );

  await notifyVendorApplication({
    userId,
    title: rejected ? "Vendor application resubmitted" : "Vendor application received",
    detail: `${name} · ${application.reference}`,
    applicationId: String(application._id),
  });

  await notifyAdminVendorApplication({
    title: rejected
      ? `Vendor application resubmitted: ${name}`
      : `New vendor application: ${name}`,
    detail: `${input.personalInfo.fullName} · ${input.personalInfo.email} · ${plan.name}`,
    applicationId: String(application._id),
  });

  return toApplicationDto(application);
}

/** The account's current application, or null when it never applied. */
export async function getMyApplication(userId: string) {
  const application: any = await VendorApplication.findOne({ userId }).sort({ createdAt: -1 }).lean();
  return toApplicationDto(application);
}

/**
 * The seller's own edit of their file.
 *
 * The vendor profile page shows the whole application — who applied, how the
 * shop presents itself, where the business sits, what was uploaded for
 * verification — filled or not, and lets it be corrected. One Save therefore
 * writes three places at once, because they are one answer kept in three rows:
 *
 * - the application row keeps the record the review desk read,
 * - the store row is what buyers actually see, so the storefront fields are
 *   copied onto it,
 * - the account keeps its display name and phone.
 *
 * What is deliberately not editable here: the slug, because every published link
 * to the shop is built from it, and the plan and billing cycle, because a plan
 * is a paid change and the subscription desk is the only place that may take
 * money for one. A closed shop stays closed — its owner fixing a phone number
 * must not quietly rewrite a storefront the store team switched off.
 *
 * The status never moves on this path: an edit is not a resubmission.
 */
export async function updateMyApplication(userId: string, input: UpdateMyApplicationInput) {
  const application: any = await VendorApplication.findOne({ userId }).sort({ createdAt: -1 });
  if (!application) throw new ApiError(404, "You have no vendor file to edit");

  const name = input.storeInfo?.name?.trim();
  if (name !== undefined && name.length > 0 && name.length < 2) {
    throw new ApiError(400, "Store name needs at least two characters");
  }

  // A renamed shop must not collide with someone else's. Asked before anything
  // is written, so a refused name leaves the file exactly as it was. The slug
  // the store was published under does not change, so the identity check the
  // submission uses can answer for the name alone.
  if (name && name !== application.storeInfo?.name) {
    await assertStoreIdentityFree(application.storeInfo?.slug || name, name, userId);
  }

  let changed = false;
  for (const section of APPLICATION_SECTIONS) {
    changed = applySection(application, section, input[section]) || changed;
  }

  if (changed) {
    application.history.push({
      status: application.status,
      at: new Date(),
      note: "Profile updated by the seller",
    });
    await application.save();
  }

  const store = await VendorStore.findOne({ userId });
  if (store && store.status !== "closed") {
    const patch: UpdateStoreInput = { ...(input.storeInfo || {}) };
    if (input.businessAddress) {
      // The storefront address keeps a value for every line, so an unfilled part
      // of the file is written as the empty string the store row already uses
      // rather than as `undefined`, which would leave the old text on screen.
      patch.address = {
        country: input.businessAddress.country || "Bangladesh",
        division: input.businessAddress.division || "",
        city: input.businessAddress.city || "",
        area: input.businessAddress.area || "",
        address: input.businessAddress.address || "",
        postalCode: input.businessAddress.postalCode || "",
        latitude: input.businessAddress.latitude ?? null,
        longitude: input.businessAddress.longitude ?? null,
      };
    }
    if (input.isVisible !== undefined) patch.isVisible = input.isVisible;
    if (Object.keys(patch).length > 0) await updateMyStore(userId, patch);
  }

  const mirror: Record<string, unknown> = {};
  if (input.personalInfo?.fullName) mirror.name = input.personalInfo.fullName;
  if (input.personalInfo?.phone !== undefined) mirror.phone = input.personalInfo.phone;
  if (Object.keys(mirror).length > 0) {
    await User.updateOne({ _id: userId }, { $set: mirror });
  }

  return toApplicationDto(application);
}

/** A pending applicant may withdraw before a decision is made. */
export async function cancelMyApplication(userId: string) {
  const application: any = await VendorApplication.findOne({
    userId,
    status: { $in: ["pending", "under_review"] },
  });
  if (!application) throw new ApiError(404, "You have no application to cancel");

  const now = new Date();
  application.status = "cancelled";
  application.history.push({ status: "cancelled", at: now, note: "Withdrawn by the applicant" });
  await application.save();

  await User.updateOne({ _id: userId }, { $set: { vendorStatus: "cancelled" } });

  return toApplicationDto(application);
}

/**
 * The status an applicant is allowed to see after proving who they are.
 *
 * The caller (the auth layer) has already checked the password; this function
 * only reads. It never returns a document for an email with no application,
 * and it never exposes anything else about the account.
 */
export async function getStatusForVerifiedEmail(email: string) {
  const user: any = await User.findOne({ email: email.toLowerCase() }).select("_id vendorStatus").lean();
  if (!user) return null;

  const application: any = await VendorApplication.findOne({ userId: user._id })
    .sort({ createdAt: -1 })
    .lean();
  if (!application) return null;

  return toApplicationDto(application);
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/** One page of applications, filtered the way the review table asks. */
export async function listApplications(query: VendorApplicationQuery) {
  const { status, search, page, limit } = query;
  const filter: Record<string, unknown> = {};

  if (status && status !== "all") filter.status = status;

  if (search?.trim()) {
    const match = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [
      { "storeInfo.name": match },
      { "personalInfo.fullName": match },
      { "personalInfo.email": match },
      { "personalInfo.phone": match },
      { reference: match },
    ];
  }

  const [rows, total, counts] = await Promise.all([
    VendorApplication.find(filter)
      .sort({ submittedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    VendorApplication.countDocuments(filter),
    VendorApplication.aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const typeCounts = counts.reduce<Record<string, number>>((all, row) => {
    all[String(row._id)] = Number(row.count) || 0;
    return all;
  }, {});

  return {
    applications: rows.map(toApplicationDto),
    total,
    typeCounts,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** One application with the owning account, for the detail page. */
export async function getApplication(applicationId: string) {
  if (!Types.ObjectId.isValid(applicationId)) throw new ApiError(404, "Application not found");

  const application: any = await VendorApplication.findById(applicationId).lean();
  if (!application) throw new ApiError(404, "Application not found");

  const user: any = await User.findById(application.userId)
    .select("name email image phone role status vendorStatus createdAt")
    .lean();

  const store: any = application.storeId
    ? await VendorStore.findById(application.storeId).lean()
    : null;

  return {
    application: toApplicationDto(application),
    applicant: user
      ? {
          _id: String(user._id),
          name: user.name || "",
          email: user.email || "",
          image: user.image || "",
          phone: user.phone || "",
          role: user.role || "customer",
          status: user.status || "active",
          createdAt: user.createdAt,
        }
      : null,
    store: store
      ? { _id: String(store._id), slug: store.slug, status: store.status, isVisible: store.isVisible }
      : null,
  };
}

/**
 * Moves an application through review.
 *
 * Approval is the only action that grants authority, and it does four writes as
 * one unit: the store is created, the account becomes a vendor, the application
 * is marked approved, and the Free period (or nothing, for a paid plan) is
 * recorded. A failure leaves the applicant exactly where they were.
 */
export async function reviewApplication(
  applicationId: string,
  input: ReviewApplicationInput,
  adminId?: string
) {
  if (!Types.ObjectId.isValid(applicationId)) throw new ApiError(404, "Application not found");

  const application: any = await VendorApplication.findById(applicationId);
  if (!application) throw new ApiError(404, "Application not found");

  if (input.action === "under_review") {
    if (!["pending", "under_review"].includes(application.status)) {
      throw new ApiError(400, `A ${application.status} application cannot be moved to review`);
    }

    application.status = "under_review";
    application.reviewNotes = input.notes || application.reviewNotes;
    application.history.push({
      status: "under_review",
      at: new Date(),
      by: adminId,
      note: input.notes || "Review started",
    });
    await application.save();

    await User.updateOne({ _id: application.userId }, { $set: { vendorStatus: "under_review" } });
    await notifyVendorApplication({
      userId: String(application.userId),
      title: "Your vendor application is being reviewed",
      detail: application.storeInfo?.name || "",
      applicationId,
    });

    return toApplicationDto(application);
  }

  if (input.action === "reject") {
    const reason = (input.reason || "").trim();
    if (!reason) throw new ApiError(400, "A rejection reason is required");

    if (!["pending", "under_review"].includes(application.status)) {
      throw new ApiError(400, `A ${application.status} application cannot be rejected`);
    }

    const now = new Date();
    application.status = "rejected";
    application.rejectionReason = reason;
    application.reviewNotes = input.notes || "";
    application.reviewedBy = adminId || null;
    application.reviewedAt = now;
    application.history.push({ status: "rejected", at: now, by: adminId, note: reason });
    await application.save();

    // The account goes back to being an ordinary customer; no vendor authority
    // is created at any point in this path.
    await User.updateOne(
      { _id: application.userId },
      { $set: { vendorStatus: "rejected" } }
    );

    await notifyVendorApplication({
      userId: String(application.userId),
      title: "Your vendor application was not approved",
      detail: reason,
      applicationId,
    });

    return toApplicationDto(application);
  }

  // ── Approve ────────────────────────────────────────────────────────────────
  if (application.status === "approved") {
    // A retry of the same approval is a no-op, not a second store.
    return toApplicationDto(application);
  }
  if (!["pending", "under_review"].includes(application.status)) {
    throw new ApiError(400, `A ${application.status} application cannot be approved`);
  }

  const plan = await getPlan(application.selectedPlan);
  const now = new Date();
  const days = billingDays(application.billingCycle);

  const storeId = await withTransaction(async (session) => {
    const fresh: any = await VendorApplication.findById(applicationId).session(session ?? null);
    if (!fresh) throw new ApiError(404, "Application not found");
    if (fresh.status === "approved" && fresh.storeId) return fresh.storeId;

    // One store per account: an existing row is reused, never duplicated.
    let store: any = await VendorStore.findOne({ userId: fresh.userId }).session(session ?? null);
    if (!store) {
      const clash = await VendorStore.findOne({ slug: fresh.storeInfo.slug })
        .select("_id")
        .session(session ?? null);
      if (clash) {
        throw new ApiError(
          409,
          "That store link was taken while this application was in review. Ask the applicant to choose another."
        );
      }

      const created = await VendorStore.create(
        [
          {
            userId: fresh.userId,
            applicationId: fresh._id,
            name: fresh.storeInfo.name,
            slug: fresh.storeInfo.slug,
            description: fresh.storeInfo.description || "",
            logo: fresh.storeInfo.logo || "",
            coverImage: fresh.storeInfo.coverImage || "",
            email: fresh.storeInfo.email || fresh.personalInfo.email,
            phone: fresh.storeInfo.phone || fresh.personalInfo.phone || "",
            category: fresh.storeInfo.category || "",
            website: fresh.storeInfo.website || "",
            socialLinks: fresh.storeInfo.socialLinks || {},
            address: fresh.businessAddress || {},
            status: "active",
            isVisible: true,
          },
        ],
        { session: session ?? undefined }
      );
      store = created[0];
    }

    // The conversion: the same user row gains vendor authority. Nothing else
    // about the account is touched, so orders, reviews, the wishlist, the
    // wallet and every address stay exactly as they were.
    //
    // `roles` is a set on purpose. An existing customer keeps the `customer`
    // entry, which is what continues to unlock their cart; a rider who is now
    // also a seller keeps both. The account's `activeRole` (and therefore the
    // `role` mirror) is deliberately left alone — an approval does not move
    // the person out of the dashboard they were already in.
    await User.updateOne(
      { _id: fresh.userId },
      {
        $addToSet: { roles: { $each: ["customer", "vendor"] } },
        $set: {
          vendorStatus: "approved",
          vendorStoreId: store._id,
          vendorApplicationId: fresh._id,
        },
      },
      { session: session ?? undefined }
    );

    fresh.status = "approved";
    fresh.storeId = store._id;
    fresh.reviewedBy = adminId || null;
    fresh.reviewedAt = now;
    fresh.reviewNotes = input.notes || "";
    fresh.rejectionReason = "";
    fresh.history.push({
      status: "approved",
      at: now,
      by: adminId,
      note: input.notes || "Approved",
    });
    await fresh.save({ session: session ?? undefined });

    // Free activates immediately. A paid plan waits for the demo checkout, so
    // no subscription row is written here at all.
    if (plan.monthlyPrice === 0) {
      const subscription = await VendorSubscription.create(
        [
          {
            vendorId: fresh.userId,
            storeId: store._id,
            plan: plan.id,
            billingCycle: fresh.billingCycle,
            status: "active",
            pricePaid: 0,
            startDate: now,
            endDate: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
            autoRenew: false,
            note: "Free plan activated on approval",
            history: [{ action: "started", at: now, toPlan: plan.id, note: "Free plan" }],
          },
        ],
        { session: session ?? undefined }
      );

      await SubscriptionTransaction.create(
        [
          {
            vendorId: fresh.userId,
            storeId: store._id,
            subscriptionId: subscription[0]._id,
            plan: plan.id,
            billingCycle: fresh.billingCycle,
            amount: 0,
            method: "wallet",
            status: "success",
            reference: `FREE-${String(subscription[0]._id).slice(-6).toUpperCase()}`,
            isDemo: true,
            purpose: "activation",
            periodStart: subscription[0].startDate,
            periodEnd: subscription[0].endDate,
            paidAt: now,
          },
        ],
        { session: session ?? undefined }
      );
    }

    return store._id;
  });

  await notifyVendorApplication({
    userId: String(application.userId),
    title: "Your vendor application was approved",
    detail:
      plan.monthlyPrice === 0
        ? `${application.storeInfo.name} · Free plan activated`
        : `${application.storeInfo.name} · Activate your ${plan.name} plan to start selling`,
    applicationId,
  });

  await notifyAdminVendorApplication({
    title: `Vendor approved: ${application.storeInfo.name}`,
    detail: `Reviewed by the store team · ${plan.name}`,
    applicationId,
  });

  const updated: any = await VendorApplication.findById(applicationId).lean();
  return { ...toApplicationDto(updated), storeId: String(storeId) };
}
