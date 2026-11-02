import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { ApiError } from "../../utils/apiError";
import { applySection } from "../../utils/profilePatch";
import { withTransaction } from "../../utils/transactions";
import { normalizeRoles } from "../../utils/roles";
import { User } from "../user/user.model";
import { RiderApplication } from "./rider-application.model";
import { PROFILE_SECTIONS } from "./rider-application.validator";
import { notifyAdminRiderApplication, notifyRiderApplication } from "./rider.notifications";
import type {
  CreateRiderApplicationInput,
  ReviewRiderApplicationInput,
  RiderApplicationQuery,
  UpdateMyRiderApplicationInput,
} from "./rider-application.validator";

/**
 * The rider application lifecycle.
 *
 * Mirrors the vendor flow: a submission never creates a second account, only
 * an admin approval adds the `rider` role onto the caller's existing `roles`
 * array, and a rejected applicant can reapply on the same row so their earlier
 * review stays in the history.
 */

/** "RID-4F9C21" — the reference an applicant quotes to support. */
function newReference(): string {
  return `RID-${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Loads the account behind an application and refuses the wrong rows. */
async function loadApplicant(userId: string) {
  const user: any = await User.findById(userId).lean();
  if (!user) throw new ApiError(404, "Account not found");
  return user;
}

/**
 * Whether this account may open a rider application.
 *
 * Admins never convert, and an account already approved as a rider has nothing
 * to apply for. A customer, or a customer who is also an approved vendor, may
 * apply — the multi-role design.
 */
function assertCanApply(user: any) {
  const pool = normalizeRoles(user.roles);
  const legacy = pool.length > 0 ? pool : normalizeRoles(user.role || "customer");
  if (legacy.includes("admin") || legacy.includes("demoadmin")) {
    throw new ApiError(403, "Administrator accounts cannot apply to become a rider");
  }
  if (legacy.includes("rider") || user.riderStoreId || user.riderStatus === "approved") {
    throw new ApiError(409, "This account is already an approved rider");
  }
}

/** The summary every screen shows, wherever the application is read from. */
export function toRiderApplicationDto(application: any) {
  if (!application) return null;
  return {
    _id: String(application._id),
    reference: application.reference,
    status: application.status,
    personalInfo: application.personalInfo,
    contactInfo: application.contactInfo,
    serviceAddress: application.serviceAddress,
    vehicle: application.vehicle,
    documents: application.documents,
    availability: application.availability,
    experience: application.experience,
    rejectionReason: application.rejectionReason || "",
    reviewNotes: application.reviewNotes || "",
    reviewedAt: application.reviewedAt || null,
    submittedAt: application.submittedAt,
    resubmissionCount: application.resubmissionCount || 0,
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
 * Creates or refreshes the application of one account.
 *
 * A rejected applicant who applies again updates that same row, which keeps
 * their reference stable and leaves the earlier review in `history`. A
 * resubmission is only allowed once the previous decision has been final, so
 * two pending applications can never exist for one user; the partial unique
 * index in the model is what actually enforces this on the database.
 */
export async function submitApplication(userId: string, input: CreateRiderApplicationInput) {
  const user = await loadApplicant(userId);
  assertCanApply(user);

  if (!input.confirm) {
    throw new ApiError(400, "Confirm the declaration before submitting your application");
  }

  const existing: any = await RiderApplication.findOne({
    userId,
    status: { $in: ["pending", "under_review", "approved"] },
  });

  if (existing) {
    throw new ApiError(
      409,
      existing.status === "approved"
        ? "Your rider application is already approved"
        : "You already have an application waiting for review"
    );
  }

  const rejected: any = await RiderApplication.findOne({
    userId,
    status: { $in: ["rejected", "cancelled"] },
  }).sort({ createdAt: -1 });

  const now = new Date();
  const payload = {
    personalInfo: input.personalInfo,
    contactInfo: input.contactInfo,
    serviceAddress: input.serviceAddress,
    vehicle: input.vehicle,
    documents: input.documents,
    availability: input.availability,
    experience: input.experience,
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
    application = await RiderApplication.create({
      ...payload,
      userId,
      reference: newReference(),
      history: [{ status: "pending", at: now, note: "Application submitted" }],
      // Zod has already validated every enum against the shared tuples; the
      // validator widens them to `string` to satisfy `z.enum`, so the model's
      // literal-union typing needs the cast back here.
    } as any);
  }

  // The account keeps its current roles; only its marketplace state changes.
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        riderStatus: "pending",
        riderApplicationId: application._id,
        name: user.name || input.personalInfo.fullName,
        phone: user.phone || input.personalInfo.phone || undefined,
      },
    }
  );

  await notifyRiderApplication({
    userId,
    title: rejected ? "Rider application resubmitted" : "Rider application received",
    detail: `${input.personalInfo.fullName} · ${application.reference}`,
    applicationId: String(application._id),
  });

  await notifyAdminRiderApplication({
    title: rejected
      ? `Rider application resubmitted: ${input.personalInfo.fullName}`
      : `New rider application: ${input.personalInfo.fullName}`,
    detail: `${input.personalInfo.email} · ${input.vehicle?.type || "motorcycle"}`,
    applicationId: String(application._id),
  });

  return toRiderApplicationDto(application);
}

/** The account's current application, or null when it never applied. */
export async function getMyApplication(userId: string) {
  const application: any = await RiderApplication.findOne({ userId })
    .sort({ createdAt: -1 })
    .lean();
  return toRiderApplicationDto(application);
}

/**
 * The rider's own edit of their file.
 *
 * The profile page is the rider's copy of everything the application wizard
 * collected, so an approved rider keeps editing it — a new plate, a renewed
 * licence, a better photo — without reopening the review. Two things happen in
 * one call: the application row keeps the record, and the identity and vehicle
 * fields are mirrored onto the account, because the rider dashboard, the
 * delivery job and the customer's tracking screen have always read them from
 * the user row.
 *
 * The service does not know which fields the form considers finished, so it
 * accepts a half-empty save. The application itself stays where it was: this
 * path never changes a status or reopens a decision.
 *
 * A rider whose account was handed the role without a wizard run has no file at
 * all. The profile page is then the only place those answers can live, so the
 * row is opened here rather than sent to a dead end.
 */
export async function updateMyApplication(
  userId: string,
  input: UpdateMyRiderApplicationInput
) {
  let application: any = await RiderApplication.findOne({ userId }).sort({ createdAt: -1 });
  let openedHere = false;

  if (!application) {
    // A rider approved at the review desk always has the file the wizard wrote.
    // An account handed the role another way — a courier added at a desk, a
    // legacy row — has none, and the profile page would have nowhere to save.
    // So the file is opened from the account here and the history says so.
    const user = await loadApplicant(userId);
    const held = normalizeRoles(user.roles);
    const pool = held.length > 0 ? held : normalizeRoles(user.role || "customer");
    if (!pool.includes("rider") && user.riderStatus !== "approved") {
      throw new ApiError(404, "You have no rider file yet. Apply from the rider page first.");
    }

    application = new RiderApplication({
      userId,
      reference: newReference(),
      status: "approved",
      personalInfo: { fullName: user.name || "Rider", email: user.email || "", phone: user.phone || "" },
      serviceAddress: {},
      vehicle: {},
      history: [
        { status: "approved", at: new Date(), note: "Opened from the rider profile page" },
      ],
    });
    openedHere = true;
  }

  let changed = false;
  for (const section of PROFILE_SECTIONS) {
    changed = applySection(application, section, input[section]) || changed;
  }

  if (changed && !openedHere) {
    application.history.push({
      status: application.status,
      at: new Date(),
      note: "Profile updated by the rider",
    });
  }

  if (changed || openedHere) await application.save();

  // The account mirror. Only the sections that were part of this save are
  // copied, and the login email is never written from here.
  const mirror: Record<string, unknown> = {};
  if (input.personalInfo) {
    if (input.personalInfo.fullName) mirror.name = input.personalInfo.fullName;
    if (input.personalInfo.photoUrl !== undefined) mirror.image = input.personalInfo.photoUrl;
    if (input.personalInfo.phone !== undefined) mirror.phone = input.personalInfo.phone;
  }
  if (input.vehicle) {
    if (input.vehicle.type !== undefined) mirror.vehicleType = input.vehicle.type;
    if (input.vehicle.number !== undefined) mirror.vehicleNumber = input.vehicle.number;
    if (input.vehicle.licenseNumber !== undefined) {
      mirror.licenseNumber = input.vehicle.licenseNumber;
    }
  }

  if (Object.keys(mirror).length > 0) {
    await User.updateOne({ _id: userId }, { $set: mirror });
  }

  return toRiderApplicationDto(application);
}

/** A pending applicant may withdraw before a decision is made. */
export async function cancelMyApplication(userId: string) {
  const application: any = await RiderApplication.findOne({
    userId,
    status: { $in: ["pending", "under_review"] },
  });
  if (!application) throw new ApiError(404, "You have no application to cancel");

  const now = new Date();
  application.status = "cancelled";
  application.history.push({ status: "cancelled", at: now, note: "Withdrawn by the applicant" });
  await application.save();

  await User.updateOne({ _id: userId }, { $set: { riderStatus: "cancelled" } });

  return toRiderApplicationDto(application);
}

/**
 * The status an applicant is allowed to see after proving who they are.
 *
 * The caller (the auth layer) has already checked the password; this function
 * only reads.
 */
export async function getStatusForVerifiedEmail(email: string) {
  const user: any = await User.findOne({ email: email.toLowerCase() }).select("_id riderStatus").lean();
  if (!user) return null;

  const application: any = await RiderApplication.findOne({ userId: user._id })
    .sort({ createdAt: -1 })
    .lean();
  if (!application) return null;

  return toRiderApplicationDto(application);
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/** One page of applications, filtered the way the review table asks. */
export async function listApplications(query: RiderApplicationQuery) {
  const { status, search, page, limit } = query;
  const filter: Record<string, unknown> = {};

  if (status && status !== "all") filter.status = status;

  if (search?.trim()) {
    const match = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [
      { "personalInfo.fullName": match },
      { "personalInfo.email": match },
      { "personalInfo.phone": match },
      { "vehicle.number": match },
      { "vehicle.licenseNumber": match },
      { reference: match },
    ];
  }

  const [rows, total, counts] = await Promise.all([
    RiderApplication.find(filter)
      .sort({ submittedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    RiderApplication.countDocuments(filter),
    RiderApplication.aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const typeCounts = counts.reduce<Record<string, number>>((all, row) => {
    all[String(row._id)] = Number(row.count) || 0;
    return all;
  }, {});

  return {
    applications: rows.map(toRiderApplicationDto),
    total,
    typeCounts,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** One application with the owning account, for the detail page. */
export async function getApplication(applicationId: string) {
  if (!Types.ObjectId.isValid(applicationId)) throw new ApiError(404, "Application not found");

  const application: any = await RiderApplication.findById(applicationId).lean();
  if (!application) throw new ApiError(404, "Application not found");

  const user: any = await User.findById(application.userId)
    .select("name email image phone role roles status riderStatus createdAt")
    .lean();

  return {
    application: toRiderApplicationDto(application),
    applicant: user
      ? {
          _id: String(user._id),
          name: user.name || "",
          email: user.email || "",
          image: user.image || "",
          phone: user.phone || "",
          role: user.activeRole || user.role || "customer",
          roles: normalizeRoles(user.roles),
          status: user.status || "active",
          riderStatus: user.riderStatus || "none",
          createdAt: user.createdAt,
        }
      : null,
  };
}

/**
 * Moves an application through review.
 *
 * Approval is the only action that grants authority. It writes as one unit:
 * the application is marked approved, the caller's `roles` array gains the
 * `rider` entry, and the vehicle details collected during the application are
 * copied onto the rider profile so the existing rider dashboard finds them
 * where it always looked.
 */
export async function reviewApplication(
  applicationId: string,
  input: ReviewRiderApplicationInput,
  adminId?: string
) {
  if (!Types.ObjectId.isValid(applicationId)) throw new ApiError(404, "Application not found");

  const application: any = await RiderApplication.findById(applicationId);
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

    await User.updateOne({ _id: application.userId }, { $set: { riderStatus: "under_review" } });
    await notifyRiderApplication({
      userId: String(application.userId),
      title: "Your rider application is being reviewed",
      detail: application.personalInfo?.fullName || "",
      applicationId,
    });

    return toRiderApplicationDto(application);
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

    // The account keeps its existing approved roles; nothing is stripped and
    // nothing is added. Rejection only changes the marketplace state.
    await User.updateOne({ _id: application.userId }, { $set: { riderStatus: "rejected" } });

    await notifyRiderApplication({
      userId: String(application.userId),
      title: "Your rider application was not approved",
      detail: reason,
      applicationId,
    });

    return toRiderApplicationDto(application);
  }

  // ── Approve ────────────────────────────────────────────────────────────────
  if (application.status === "approved") {
    // A retry of the same approval is a no-op, not a second write.
    return toRiderApplicationDto(application);
  }
  if (!["pending", "under_review"].includes(application.status)) {
    throw new ApiError(400, `A ${application.status} application cannot be approved`);
  }

  const now = new Date();
  await withTransaction(async (session) => {
    const fresh: any = await RiderApplication.findById(applicationId).session(session ?? null);
    if (!fresh) throw new ApiError(404, "Application not found");
    if (fresh.status === "approved") return;

    // The conversion: the account gains the rider role. `roles` keeps customer
    // too — and we re-add it defensively so a legacy row that somehow skipped
    // the migration does not lose its shopping rights the moment it is
    // approved. `activeRole` stays where the applicant had it, so a review
    // finishing never yanks somebody out of the dashboard they are looking at.
    await User.updateOne(
      { _id: fresh.userId },
      {
        $addToSet: { roles: { $each: ["customer", "rider"] } },
        $set: {
          riderStatus: "approved",
          riderApplicationId: fresh._id,
          // Copy the vehicle details across so the existing rider profile
          // screen finds them where it always looked.
          vehicleType: fresh.vehicle?.type || "motorcycle",
          vehicleNumber: fresh.vehicle?.number || "",
          licenseNumber: fresh.vehicle?.licenseNumber || "",
        },
      },
      { session: session ?? undefined }
    );

    fresh.status = "approved";
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
  });

  await notifyRiderApplication({
    userId: String(application.userId),
    title: "Your rider application was approved",
    detail: "You can switch to the rider dashboard from your profile menu.",
    applicationId,
  });

  await notifyAdminRiderApplication({
    title: `Rider approved: ${application.personalInfo?.fullName || "Account"}`,
    detail: `Reviewed by the store team · ${application.vehicle?.type || "motorcycle"}`,
    applicationId,
  });

  const updated: any = await RiderApplication.findById(applicationId).lean();
  return toRiderApplicationDto(updated);
}
