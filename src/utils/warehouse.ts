import { Schema } from "mongoose";
import { z } from "zod";

/**
 * Where a parcel is collected.
 *
 * The same small record is kept in three places — a seller's store, the vendor
 * application it came from, and the store team's own profile — because the
 * rider asks one question ("where is the box?") and the answer has to read the
 * same whichever record it came out of. It is deliberately not the storefront
 * address: a shop can sell from a counter downtown while its stock sits in a
 * warehouse across town, and the rider needs the second one.
 */

export interface WarehouseAddress {
  /** What the rider should look for, e.g. "Uttara warehouse". */
  label?: string;
  address?: string;
  city?: string;
  area?: string;
  postalCode?: string;
  /** Whom to call when the gate is locked. */
  phone?: string;
}

export const warehouseSchema = new Schema(
  {
    label: { type: String, default: "" },
    address: { type: String, default: "" },
    city: { type: String, default: "" },
    area: { type: String, default: "" },
    postalCode: { type: String, default: "" },
    phone: { type: String, default: "" },
  },
  { _id: false }
);

/** The body a form sends; every line is optional so a patch can fill one. */
export const warehouseInputSchema = z.object({
  label: z.string().trim().max(120).optional(),
  address: z.string().trim().max(400).optional(),
  city: z.string().trim().max(120).optional(),
  area: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(30).optional(),
});

/** A warehouse with a street line is one a rider can actually be sent to. */
export function hasWarehouse(warehouse?: WarehouseAddress | null): boolean {
  return Boolean(warehouse?.address && warehouse.address.trim());
}

/** The lines one address reads as, skipping the parts nobody filled in. */
export function warehouseLines(warehouse?: WarehouseAddress | null): string[] {
  if (!warehouse) return [];
  return [warehouse.address, warehouse.area, warehouse.city, warehouse.postalCode]
    .map((line) => (line || "").trim())
    .filter(Boolean);
}
