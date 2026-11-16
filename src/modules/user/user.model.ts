import { Schema, model } from "mongoose";
import { warehouseSchema } from "../../utils/warehouse";

/**
 * Roles the platform recognises. `demoadmin` is admin authority with a
 * sandboxed undo layer, so it is a peer of `admin` in every check.
 */
export const USER_ROLES = ["admin", "demoadmin", "customer", "rider", "vendor"] as const;

export type UserRoleName = (typeof USER_ROLES)[number];

const userSchema = new Schema(
  {
    name: { type: String },
    email: { type: String },
    emailVerified: { type: Boolean },
    image: { type: String },
    /**
     * The account's active dashboard.
     *
     * Kept as a single string so every existing check (`user.role === "vendor"`)
     * keeps reading the same value it always did. It is a mirror of
     * `activeRole`: writes go through the helpers in `user.service` so the two
     * fields can never disagree.
     */
    role: { type: String },
    /**
     * Every role an admin has approved on this account.
     *
     * The array is the authority — a session's `activeRole` only decides which
     * dashboard the person is looking at right now, and never grants access by
     * itself. A brand-new account holds `["customer"]` and only ever grows when
     * an application is approved; nothing a client sends can write into it.
     */
    roles: {
      type: [
        {
          type: String,
          enum: USER_ROLES as unknown as string[],
        },
      ],
      default: ["customer"],
    },
    /** Which dashboard the account is currently using. Always present inside `roles`. */
    activeRole: {
      type: String,
      enum: USER_ROLES as unknown as string[],
      default: "customer",
    },
    /**
     * Roles parked by the store team without closing the account.
     *
     * A suspension lives here per role, so a rider with a lapsed licence loses
     * the rider dashboard while the same person keeps shopping as a customer.
     * The whole account is still a separate decision — that one lives in
     * `status`. A suspended entry remains inside `roles`: revoking and
     * suspending are different tools, and an un-suspend must not need a fresh
     * application.
     */
    roleSuspensions: {
      type: [
        {
          role: { type: String, enum: USER_ROLES as unknown as string[] },
          reason: { type: String, default: "" },
          suspendedAt: { type: Date },
        },
      ],
      default: [],
    },
    plan: { type: String },
    status: { type: String },
    member: { type: String },
    points: { type: Number },
    phone: { type: String },
    bio: { type: String },
    department: { type: String },
    /**
     * Where the store team hands parcels over.
     *
     * Filled in from the admin profile. It is the fallback pickup point for an
     * order whose seller has no warehouse of their own, so a rider is never sent
     * to a shop counter for stock that is not kept there.
     */
    warehouse: { type: warehouseSchema, default: () => ({}) },
    /** Rider-only details, filled in from the rider profile page. */
    vehicleType: { type: String },
    vehicleNumber: { type: String },
    licenseNumber: { type: String },
    /** Riders go offline to stop receiving new delivery requests. */
    availability: { type: String, enum: ["online", "offline"], default: "online" },
    /**
     * The marketplace state of this account.
     *
     * It is kept apart from `role` on purpose: an applicant is still a customer
     * until an admin approves, and a rejected applicant goes back to being one
     * without ever gaining vendor authority. "none" means no application.
     */
    vendorStatus: {
      type: String,
      enum: ["none", "pending", "under_review", "approved", "rejected", "cancelled"],
      default: "none",
    },
    /** The application behind `vendorStatus`, so the account can always find it. */
    vendorApplicationId: { type: Schema.Types.ObjectId, ref: "VendorApplication", default: null },
    /** The shop this account owns. One account, at most one store. */
    vendorStoreId: { type: Schema.Types.ObjectId, ref: "VendorStore", default: null },
    /** Same contract as the vendor fields, for the rider pipeline. */
    riderStatus: {
      type: String,
      enum: ["none", "pending", "under_review", "approved", "rejected", "cancelled"],
      default: "none",
    },
    riderApplicationId: { type: Schema.Types.ObjectId, ref: "RiderApplication", default: null },
  },
  { timestamps: true, collection: "user" }
);

/**
 * Keeps `role` and `activeRole` in lockstep.
 *
 * Older readers still compare on `role`, so every write to `activeRole` mirrors
 * into it before the document is saved. The service layer also does this on
 * `updateOne` because those bypass middleware, but this catches direct
 * `save()` calls on a hydrated document.
 */
userSchema.pre("save", async function syncActiveRole() {
  const changed = this.isModified("activeRole") || this.isModified("role");
  if (changed && this.activeRole) {
    this.role = this.activeRole;
  } else if (changed && this.role) {
    this.activeRole = this.role;
  }
  // An approved role must always exist in the array; the reverse is not enforced
  // here so an admin revoke can leave the row consistent while the migration
  // catches up.
  const roles = (this.roles as string[] | undefined) || [];
  if (roles.length === 0) {
    this.roles = ["customer"];
    if (!this.activeRole) this.activeRole = "customer";
  }
});

export const User = model("User", userSchema);
