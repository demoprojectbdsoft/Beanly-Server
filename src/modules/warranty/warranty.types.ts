/**
 * The five warranty types a product can be sold with.
 *
 * This is product vocabulary, not a claim workflow: the product form and the
 * product page both read from it, so a type can never mean one thing on the
 * shop and another in the catalogue. `sparq/src/lib/warranty.ts` mirrors it for
 * the UI.
 */
export const WARRANTY_TYPE_VALUES = [
  "manufacturer-warranty",
  "seller-warranty",
  "extended-warranty",
  "other",
  "none",
] as const;

export type WarrantyType = (typeof WARRANTY_TYPE_VALUES)[number];
