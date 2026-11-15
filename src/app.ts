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
import addressRoutes from "./modules/address/address.route";
import orderRoutes from "./modules/order/order.route";
import slideRoutes from "./modules/slide/slide.route";
import orderStatusRoutes from "./modules/order-status/order-status.route";
import transactionRoutes from "./modules/transaction/transaction.route";
import siteSettingsRoutes from "./modules/site-settings/site-settings.route";
import promoRoutes from "./modules/promo/promo.route";
import couponRoutes from "./modules/coupon/coupon.route";
import warrantyRoutes from "./modules/warranty/warranty.route";
import contactRoutes from "./modules/contact/contact.route";
import messageRoutes from "./modules/message/message.route";
import mailRoutes from "./modules/mail/mail.route";
import activityRoutes from "./modules/activity/activity.route";
import deliveryRoutes from "./modules/delivery/delivery.route";
import vendorApplicationRoutes from "./modules/vendor/vendor-application.route";
import vendorPlanRoutes from "./modules/vendor/vendor-plan.route";
import vendorStoreRoutes from "./modules/vendor/vendor-store.route";
import vendorProductRoutes from "./modules/vendor/vendor-product.route";
import vendorSubscriptionRoutes from "./modules/vendor/vendor-subscription.route";
import vendorOrderRoutes from "./modules/vendor/vendor-order.route";
import vendorAnalyticsRoutes from "./modules/vendor/vendor-analytics.route";
import vendorCouponRoutes from "./modules/vendor/vendor-coupon.route";
import promotionRoutes from "./modules/vendor/featured-promotion.route";
import vendorPromotionRoutes from "./modules/vendor/vendor-promotion.route";
import riderApplicationRoutes from "./modules/rider/rider-application.route";
import fileRoutes from "./modules/file/file.route";
import { errorMiddleware } from "./middlewares/error.middleware";
import { notFound } from "./middlewares/notFound.middleware";

const app = express();

app.use(cors());

/**
 * Uploaded documents, mounted before the global body parser on purpose.
 *
 * A licence scan is megabytes where every other request is kilobytes, and
 * `express.json()` refuses anything over a hundred of them. This mount brings
 * its own parser, sized for one document plus the base64 overhead, so the limit
 * stays tight everywhere else. A parser that has already read the body is left
 * alone by the one below it.
 */
app.use("/api/files", express.json({ limit: "12mb" }), fileRoutes);

app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api", (_req, res) => {
  res.json({ success: true, message: "Sparq server is running✅" });
});


app.get("/", (_req, res) => {
  res.json({ success: true, message: "Sparq server API is running✅" });
});

app.use("/api/categories", categoryRoutes);
app.use("/api/subcategories", subCategoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/users", userRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/slides", slideRoutes);
app.use("/api/order-status", orderStatusRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/site-settings", siteSettingsRoutes);
app.use("/api/promos", promoRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/warranties", warrantyRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/mail", mailRoutes);
app.use("/api/activities", activityRoutes);
app.use("/api/deliveries", deliveryRoutes);
app.use("/api/vendor-applications", vendorApplicationRoutes);
app.use("/api/vendor-plans", vendorPlanRoutes);
app.use("/api/vendor-store", vendorStoreRoutes);
app.use("/api/vendor-products", vendorProductRoutes);
app.use("/api/vendor-subscription", vendorSubscriptionRoutes);
app.use("/api/vendor-orders", vendorOrderRoutes);
app.use("/api/vendor-analytics", vendorAnalyticsRoutes);
app.use("/api/vendor-coupons", vendorCouponRoutes);
app.use("/api/promotions", promotionRoutes);
app.use("/api/vendor-promotions", vendorPromotionRoutes);
app.use("/api/rider-applications", riderApplicationRoutes);
app.use("/api/demo", demoRoutes);

app.use(notFound);
app.use(errorMiddleware);

export default app;