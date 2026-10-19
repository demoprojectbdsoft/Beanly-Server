import "./modules/demo/demo.plugin";
import demoRoutes from "./modules/demo/demo.route";

import express from "express";
import cors from "cors";
import categoryRoutes from "./modules/category/category.route";
import subCategoryRoutes from "./modules/subcategory/subcategory.route";
import productRoutes from "./modules/product/product.route";
import reviewRoutes from "./modules/review/review.route";
import wishlistRoutes from "./modules/wishlist/wishlist.route";
import cartRoutes from "./modules/cart/cart.route";
import userRoutes from "./modules/user/user.route";
import orderRoutes from "./modules/order/order.route";
import slideRoutes from "./modules/slide/slide.route";
import orderStatusRoutes from "./modules/order-status/order-status.route";
import transactionRoutes from "./modules/transaction/transaction.route";
import { errorMiddleware } from "./middlewares/error.middleware";
import { notFound } from "./middlewares/notFound.middleware";

const app = express();

app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api", (_req, res) => {
  res.json({ success: true, message: "Electro server is running✅" });
});


app.get("/", (_req, res) => {
  res.json({ success: true, message: "Electro server API is running✅" });
});

app.use("/api/categories", categoryRoutes);
app.use("/api/subcategories", subCategoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/users", userRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/slides", slideRoutes);
app.use("/api/order-status", orderStatusRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/demo", demoRoutes);

app.use(notFound);
app.use(errorMiddleware);

export default app;