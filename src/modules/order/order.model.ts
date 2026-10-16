import { Schema, model } from "mongoose";

const orderItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    title: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    image: { type: String },
  },
  { _id: false }
);

const shippingAddressSchema = new Schema(
  {
    fullName: { type: String, required: false },
    phone: { type: String, required: false },
    address: { type: String, required: false },
    city: { type: String, required: false },
    postalCode: { type: String, required: false },
  },
  { _id: false }
);

const orderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    items: [orderItemSchema],
    shippingAddress: { type: shippingAddressSchema, required: false },
    paymentMethod: { type: String, enum: ["cod", "bkash", "rocket", "nagad"], required: true },
    subtotal: { type: Number, required: true },
    shippingFee: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    orderStatus: {
      type: String,
      enum: ["confirmed", "processing", "shipped", "delivered", "cancelled"],
      default: "processing",
    },
    customerResponse: {
      type: String,
      enum: ["received", "not_received", "cancelled"],
      default: null,
    },
    customerResponseNote: {
      type: String,
      default: "",
    },
    customerResponseAt: {
      type: Date,
      default: null,
    },
    pointsEarned: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Order = model("Order", orderSchema);