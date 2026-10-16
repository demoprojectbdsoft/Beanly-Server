<div align="center">

# ⚡ Sparq — Server

### *The API powering the Sparq electronics store.*

**A layered Express + MongoDB backend handling catalog, cart, orders, payments, reviews and users.**

[![Server Repo](https://img.shields.io/badge/Server-Repository-2ea44f?style=for-the-badge)](https://github.com/demoprojectbdsoft/Sparq-Server)
[![Client Repo](https://img.shields.io/badge/Client-Repository-blue?style=for-the-badge)](https://github.com/demoprojectbdsoft/Sparq-Electronics-Store)
[![Internship Project](https://img.shields.io/badge/Type-Internship%20Project-orange?style=for-the-badge)]()

</div>

---

## 📑 Table of Contents

- [📖 About](#-about)
- [🎯 Project Overview](#-project-overview)
  - [Platforms Used](#platforms-used)
- [🏗️ Architecture at a Glance](#️-architecture-at-a-glance)
- [✨ Features](#-features)
- [⚙️ Functionalities](#️-functionalities)
- [🔒 Security](#-security)
- [🧩 API Modules](#-api-modules)
- [📦 npm Packages Used](#-npm-packages-used)
- [🔑 Environment Variables](#-environment-variables)
- [🚀 Getting Started](#-getting-started)
- [🗺️ Future Roadmap](#️-future-roadmap)
- [🎓 About This Project](#-about-this-project)

---

## 📖 About

Sparq-Server is the backend API for the [Sparq](https://github.com/demoprojectbdsoft/Sparq-Electronics-Store) electronics e-commerce platform — a layered Express architecture where every feature (categories, products, cart, wishlist, reviews, orders, transactions, users) lives in its own module, split into **model → validator → service → controller → route**.

Authentication is owned by the Next.js frontend (better-auth); this server verifies every protected request's JWT against the frontend's JWKS endpoint, with no shared secret and no duplicated user table.

---

## 🎯 Project Overview

### Platforms Used

| Layer | Choice |
|---|---|
| Runtime | Node.js, Express.js 5, TypeScript |
| Database | MongoDB Atlas via Mongoose |
| Validation | Zod |
| Auth | JWT verification via the frontend's better-auth JWKS endpoint (`jose-cjs`) |
| Hosting | Vercel Serverless Functions |

---

## 🏗️ Architecture at a Glance

Every module flows through the same five layers:

```
HTTP Request → route.ts → validator.ts (Zod) → controller.ts → service.ts → model.ts → MongoDB Atlas
```

`middlewares/` handles auth, authorization, and error formatting. `utils/` holds the shared `ApiError`, `apiResponse`, and `catchAsync` helpers every module builds on.

---

## ✨ Features

- **Layered module architecture** — `category`, `subcategory`, `product`, `review`, `wishlist`, `cart`, `user`, `order`, `order-status`, `transaction`, `slide` — each following the same structure.
- **Full catalog hierarchy** — categories → subcategories → products. Deleting a category cascades to its subcategories, but the whole delete is cancelled if the category or any of its subcategories still has products attached.
- **Cart & Wishlist as one-row-per-item** — a compound unique index on `{ userId, productId }`; subtotal computed live.
- **Dynamic homepage slider** — slides reference a real product by ID; price, image, and discount are read live.
- **Order status history** — every status transition is logged as its own document.

---

## ⚙️ Functionalities

- **Full order lifecycle** — `createOrder()` validates stock, computes totals, creates the order and linked transaction, logs status, decrements stock, and clears the cart — in one call.
- **Order response & resolution** — once an order ships, admin records the customer's response (Order Received / Still Not Received / Order Cancel) along with a description message; the order is then marked `delivered` or `cancelled` based on that response.
- **Delivery-triggered loyalty points & membership tiers** — points are credited, and the tier re-checked, only when an admin marks the order `delivered`.
- **Cancellation fails the transaction** — cancelling an order marks its linked transaction as `failed`, regardless of payment method (COD or wallet).
- **Sell-count tracking** — a product's `sellCount` is incremented by the ordered quantity whenever an order succeeds.
- **Review-driven ratings** — `recalculateProductRating()` re-aggregates rating and review count on every create/update/delete.
- **Countdown-driven slider pricing** — once a slide's product countdown ends, its discount reverts to 0 and price reverts to original.
- **Consistent API responses & error handling** — a shared `apiResponse` helper and `errorMiddleware` + `ApiError` class.

---

## 🔒 Security

- **Every private route secured with auth + authorization middleware** — `requireAuth` verifies the bearer JWT via JWKS; `requireRole(...)` gates admin-only routes.
- **Zod validation everywhere** — every write endpoint validates its payload before it reaches a service.
- **Server-trusted money math, always** — price, discount, shipping fee, totals, and points are computed from the database, never accepted from the client.
- **Stateless, cross-service JWT auth** — no shared session state between frontend and backend.

---

## 🧩 API Modules

| Module | Responsibility |
|---|---|
| `category` | Top-level product categories |
| `subcategory` | Subcategories nested under a category |
| `product` | Product catalog — pricing, stock, images, specs, badges |
| `slide` | Admin-managed homepage hero slider |
| `review` | Per-product star ratings & written reviews |
| `wishlist` | Per-user saved products |
| `cart` | Per-user cart items with live-computed subtotal |
| `order` | Order placement and retrieval |
| `order-status` | Status history log per order |
| `transaction` | Payment records linked to orders |
| `user` | Access to the better-auth-managed user collection |

---

## 📦 npm Packages Used

| Package | Purpose |
|---|---|
| `express` | HTTP server & routing |
| `mongoose` / `mongodb` | MongoDB ODM / driver |
| `zod` | Request payload validation |
| `jose-cjs` | JWKS fetching & JWT verification |
| `cors` | Cross-origin requests from the frontend |
| `dotenv` | Environment variable loading |
| `typescript` / `tsx` | Type safety & dev-time execution |
| `tsconfig-paths` | `@/` path alias resolution |

---

## 🔑 Environment Variables

```env
PORT=5000
MONGODB_URI=your_mongodb_atlas_connection_string

# The frontend's /api/auth/jwks endpoint is used to verify JWTs
NEXT_PUBLIC_CLIENT_URL=your_frontend_app_url
```

> ⚠️ Never commit `.env` to version control.

---

## 🚀 Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/demoprojectbdsoft/Sparq-Server.git
cd Sparq-Server

# 2. Install dependencies
npm install

# 3. Start the development server (with live reload)
npm run dev
```

The API will be available at [http://localhost:5000](http://localhost:5000).

```bash
npm run build   # compile TypeScript to dist/
npm start       # run the compiled server
```

> 💡 The [Sparq-Electronics-Store](https://github.com/demoprojectbdsoft/Sparq-Electronics-Store) frontend must be running and reachable at `NEXT_PUBLIC_CLIENT_URL`.

---

## 🗺️ Future Roadmap

- [ ] **Rider / delivery module** — a courier role with live order tracking.
- [ ] **"Lucky Box" rewards API** — redeeming loyalty points on a gamified reward.
- [ ] **Real-time store settings** — a settings module pushed to clients instantly.
- [ ] **Chat module** — real-time messaging between customers and support/admin.
- [ ] **Coupons & promo codes** — discount codes validated and applied server-side.
- [ ] **Real payment gateway integration** — Stripe/SSLCommerz/bKash, replacing the simulated flow.
- [ ] **Rate limiting & request logging** — hardening for production traffic.
- [ ] **Automated tests** — unit/integration coverage per module.

---

## 🎓 About This Project

A project for learning and demonstration — not distributed under an open-source license. Feel free to explore the code, but please reach out before reusing or redistributing it.