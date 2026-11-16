import { z } from "zod";
import { objectIdSchema } from "../../utils/ids";

const objectId = objectIdSchema("Invalid ID");

const orderItemInputSchema = z.object({
  productId: objectId,
  quantity: z.number().int().min(1),
  image: z.string().optional(),
  title: z.string().optional(),
  price: z.number().optional(),
});

const shippingAddressSchema = z.object({
  fullName: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  postalCode: z.string().optional(),
});

export const createOrderSchema = z
  .object({
    // The buyer is the caller: the id comes from the token, not the body.
    items: z.array(orderItemInputSchema).min(1, "Order must have at least one item"),
    shippingAddress: shippingAddressSchema.optional(),
    paymentMethod: z.enum(["cod", "bkash", "rocket", "nagad"]),
    transactionId: z.string().optional(),
    /** Optional explicit shipping choice from checkout ("free" | "standard" | "express").
     *  When omitted the backend resolves it from the live site settings. */
    shippingMethod: z.enum(["free", "standard", "express"]).optional(),
    /** Loyalty points the customer chose to spend on this order (100 pts = 1 unit). */
    pointsToRedeem: z.number().int().min(0).optional(),
    /**
     * A discount code typed at checkout. It is only a name: what it is worth is
     * worked out again from the database, never taken from the request.
     */
    couponCode: z
      .string()
      .trim()
      .min(3, "A coupon code needs at least 3 characters")
      .max(32, "A coupon code is too long")
      .transform((value) => value.toUpperCase())
      .optional(),
  })
  .superRefine((data, ctx) => {
    const sa = data.shippingAddress;
    if (
      !sa ||
      !sa.fullName?.trim() ||
      !sa.phone?.trim() ||
      !sa.address?.trim() ||
      !sa.city?.trim() ||
      !sa.postalCode?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Shipping address (full name, phone, address, city, postal code) is required for all payment methods",
        path: ["shippingAddress"],
      });
    }
  });

export const updateOrderStatusSchema = z.object({
  orderStatus: z.enum(["confirmed", "processing", "shipped", "delivered", "cancelled"]),
});

export const customerResponseSchema = z.object({
  response: z.enum(["received", "not_received", "cancelled"]),
  note: z.string().optional(),
});

export const getOrdersQuerySchema = z.object({
  userId: z.string().optional(),
  status: z.string().optional(),
  /**
   * The seller's answer, for the store's board: `accepted` is the queue the
   * store has to put a rider on, `pending` is a seller still deciding.
   */
  vendor: z.enum(["all", "pending", "accepted", "rejected"]).optional(),
  search: z.string().optional(),
  sort: z.enum(["newest", "oldest", "total_asc", "total_desc"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type CustomerResponseInput = z.infer<typeof customerResponseSchema>;
export type GetOrdersQuery = z.infer<typeof getOrdersQuerySchema>;