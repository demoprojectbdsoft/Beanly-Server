import { z } from "zod";

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ID");

const orderItemInputSchema = z.object({
  productId: objectId,
  quantity: z.number().int().min(1),
  image: z.string().optional(),
  title: z.string().optional(),
  price: z.number().optional(),
});

const shippingAddressSchema = z.object({
  fullName: z.string().min(1, "Full name is required"),
  phone: z.string().min(1, "Phone number is required"),
  address: z.string().min(1, "Address is required"),
  city: z.string().min(1, "City is required"),
  postalCode: z.string().min(1, "Postal code is required"),
});

export const createOrderSchema = z.object({
  userId: objectId,
  items: z.array(orderItemInputSchema).min(1, "Order must have at least one item"),
  shippingAddress: shippingAddressSchema,
  paymentMethod: z.enum(["cod", "bkash", "rocket", "nagad"]),
  transactionId: z.string().optional(),
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
  search: z.string().optional(),
  sort: z.enum(["newest", "oldest", "total_asc", "total_desc"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
export type CustomerResponseInput = z.infer<typeof customerResponseSchema>;
export type GetOrdersQuery = z.infer<typeof getOrdersQuerySchema>;