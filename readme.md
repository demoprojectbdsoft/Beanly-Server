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

1. [Overview](#-overview)
2. [Quick Navigation](#-quick-navigation)
3. [Architecture](#️-architecture)
4. [API Modules](#-api-modules)
5. [Business Rules](#-business-rules)
   - [Catalog](#catalog)
   - [Cart & Wishlist](#cart--wishlist)
   - [Orders & Payments](#orders--payments)
   - [Loyalty & Membership](#loyalty--membership)
   - [Reviews & Ratings](#reviews--ratings)
   - [Slider & Pricing](#slider--pricing)
6. [Demo Admin Mode](#-demo-admin-mode)
   - [How it works](#how-it-works)
   - [Enable it](#enable-it)
   - [Test it](#test-it)
   - [Limitations](#limitations)
7. [Security](#-security)
8. [Tech Stack](#-tech-stack)
9. [Setup](#-setup)
   - [Environment Variables](#environment-variables)
   - [Run Locally](#run-locally)
10. [Future Roadmap](#️-future-roadmap)
11. [About This Project](#-about-this-project)

---

## 📖 Overview

Sparq-Server is the backend API for the [Sparq](https://github.com/demoprojectbdsoft/Sparq-Electronics-Store) electronics e-commerce platform. Every feature (categories, products, cart, wishlist, reviews, orders, transactions, users) lives in its own module, split into **model → validator → service → controller → route**.

Authentication is owned by the Next.js frontend (better-auth). This server verifies every protected request's JWT against the frontend's JWKS endpoint — no shared secret and no duplicated user table.

---

## 🧭 Quick Navigation

| I want to know about… | Go to |
|---|---|
| How the code is organised | [Architecture](#️-architecture) |
| What each module does | [API Modules](#-api-modules) |
| How orders, points, and ratings are handled | [Business Rules](#-business-rules) |
| How the demo admin's changes get reverted | [Demo Admin Mode](#-demo-admin-mode) |
| Required env variables | [Environment Variables](#environment-variables) |
| Running the server | [Run Locally](#run-locally) |

---

## 🏗️ Architecture

Every module flows through the same five layers:

```
HTTP Request → route.ts → validator.ts (Zod) → controller.ts → service.ts → model.ts → MongoDB Atlas
```

| Layer | Responsibility |
|---|---|
| `route` | Maps URLs to controllers and attaches auth/role middleware. |
| `validator` | Zod schema — every write endpoint validates its payload before it reaches a service. |
| `controller` | Reads the request and sends the response through `apiResponse`. |
| `service` | Business logic and database access. |
| `model` | Mongoose schema. |

Shared pieces:
- `middlewares/` — auth, authorization, and error formatting.
- `utils/` — `ApiError`, `apiResponse`, and `catchAsync`, used by every module for consistent responses and error handling.

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
| `order-status` | Status history log per order — every transition is its own document |
| `transaction` | Payment records linked to orders |
| `user` | Access to the better-auth-managed user collection |
| `site-settings` | Store-wide settings — branding, theme, shipping, contact, default shop browse mode, and the `maintenanceMode` flag. Read publicly by the storefront and its maintenance guard. |
| `demo` | Demo admin change tracking and the daily restore endpoint |

---

## 📋 Business Rules

### Catalog

```
Category ─► Subcategory ─► Product
```

- **Cascade delete** — deleting a category also deletes its subcategories.
- **Delete guard** — the whole delete is cancelled if the category or any of its subcategories still has products attached.
- **Sell count** — a product's `sellCount` is incremented by the ordered quantity whenever an order succeeds.

### Cart & Wishlist

- One row per item, with a compound unique index on `{ userId, productId }`.
- Cart subtotal is computed live.

### Orders & Payments

```
createOrder() ─► validate stock ─► compute totals ─► create order + linked transaction
              ─► log status ─► decrement stock ─► clear cart
```

- **One call** — `createOrder()` does all of the above in a single flow.
- **Order response** — once an order ships, admin records the customer's response (Order Received / Still Not Received / Order Cancel) with a description message. The order is then marked `delivered` or `cancelled` based on that response.
- **Cancellation** — marks the linked transaction as `failed`, regardless of payment method (COD or wallet).
- **Server-trusted money** — price, discount, shipping fee, totals, and points are computed from the database, never accepted from the client.

### Loyalty & Membership

- Points are credited, and the tier re-checked, **only when an admin marks the order `delivered`**.

### Reviews & Ratings

- A review holds a star rating, a message, and up to 5 images (image URLs, hosted on ImgBB).
- `recalculateProductRating()` re-aggregates a product's rating and review count on every create, update, and delete.

### Slider & Pricing

- Slides reference a real product by ID; price, image, and discount are read live.
- Once a slide's product countdown ends, its discount reverts to 0 and its price reverts to the original.

---

## 🧪 Demo Admin Mode

The shared demo admin can add, edit, and delete catalog data — **categories, subcategories, products, and slides**, and moderate reviews — and the server undoes all of it automatically every day. Real admin changes are never touched.

### How it works

```
Demo admin writes ─► original document saved to demo_undo  ─► change goes live
Real admin writes ─► nothing logged                        ─► change is permanent
                                   │
        Daily cron: GET /api/demo/restore
                                   ▼
   Added ─► deleted      Edited ─► original value restored      Deleted ─► brought back
```

| File (`src/modules/demo/`) | Role |
|---|---|
| `demo.context.ts` | Marks a request as coming from the demo admin (matched by the JWT email). |
| `demo.plugin.ts` | Mongoose plugin. Before a demo-admin write, saves the document's original state to `demo_undo`. The first write wins, so the true original is always kept. |
| `demo.service.ts` | Reads `demo_undo` and reverts everything. Safe to run twice. |
| `demo.route.ts` / `demo.controller.ts` | The `GET /api/demo/restore` endpoint, locked behind `CRON_SECRET`. |

**What is not restored:** users, orders, transactions, cart, wishlist, and auth collections. The demo admin is blocked from changing those in the first place.

### Enable it

**1. Register the plugin** — make it the very first import in `app.ts`, before any model loads, and mount the route:

```ts
import "./modules/demo/demo.plugin";          // first line of app.ts
// ...
import demoRoutes from "./modules/demo/demo.route";
app.use("/api/demo", demoRoutes);             // before notFound
```

**2. Mark demo requests** — at the end of `requireAuth`:

```ts
import { demoStore, isDemoAdmin } from "../modules/demo/demo.context";

if (isDemoAdmin(req.user.email)) {
  return demoStore.run({ demo: true }, () => next());
}
next();
```

**3. Schedule the cron** — in `vercel.json`:

```json
"crons": [{ "path": "/api/demo/restore", "schedule": "0 20 * * *" }]
```

**4. Set the env variables** — see [Environment Variables](#environment-variables), then redeploy.

> The schedule is UTC (about 2 AM Asia/Dhaka). On Vercel's free Hobby plan a cron runs once a day, with up to ±1 hour of timing drift.

### Test it

```bash
curl https://<your-api>/api/demo/restore -H "Authorization: Bearer <CRON_SECRET>"
```

| Response | Meaning |
|---|---|
| `200` — "Demo changes reverted" | Working. |
| `401` | `CRON_SECRET` is missing, wrong, or the app wasn't redeployed. |

To check end to end: log in as the demo admin, add a category and edit a product, then run the command above. Both changes should disappear.

### Limitations

- A demo-admin edit to a product is reverted whole, so a customer's order placed in between can have its stock count rolled back too.
- Write methods that bypass Mongoose documents and queries (`insertMany`, `bulkWrite`) are not tracked.

---

## 🔒 Security

| Protection | How it works |
|---|---|
| **Auth on every private route** | `requireAuth` verifies the bearer JWT via JWKS. |
| **Role gates** | `requireRole(...)` protects admin-only routes. |
| **Stateless auth** | No shared session state between frontend and backend. |
| **Validation** | Zod validates every write payload. |
| **Server-trusted money** | Price, discount, shipping fee, totals, and points come from the database, never the client. |
| **Cron endpoint** | `/api/demo/restore` only accepts `Authorization: Bearer <CRON_SECRET>` (sent automatically by Vercel Cron). With no secret configured, nobody gets in. |
| **Demo admin limits** | Catalog routes only. User roles/status, orders, transactions, cart, wishlist, account deletion, and password/email changes stay blocked. |

---

## 🧰 Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js, Express.js 5, TypeScript |
| Database | MongoDB Atlas via Mongoose |
| Validation | Zod |
| Auth | JWT verification via the frontend's better-auth JWKS endpoint (`jose-cjs`) |
| Hosting | Vercel Serverless Functions |

<details>
<summary><b>npm packages used</b></summary>

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

</details>

---

## 🚀 Setup

### Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | Yes | Port the server listens on. |
| `MONGODB_URI` | Yes | MongoDB Atlas connection string. |
| `NEXT_PUBLIC_CLIENT_URL` | Yes | Frontend URL — its `/api/auth/jwks` endpoint is used to verify JWTs. |
| `CRON_SECRET` | Yes, for demo restore | Long random string. Generate with `openssl rand -hex 24`. |
| `DEMO_ADMIN_EMAIL` | No | Email of the shared demo admin. Default: `admin@gmail.com`. |

```env
PORT=5000
MONGODB_URI=your_mongodb_atlas_connection_string
NEXT_PUBLIC_CLIENT_URL=your_frontend_app_url
CRON_SECRET=your_long_random_string
DEMO_ADMIN_EMAIL=admin@gmail.com
```

> ⚠️ Never commit `.env` to version control.

### Run Locally

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

- [ ] **Rider role & delivery module** — a courier role with assigned deliveries, order status updates, and live location tracking.
- [ ] **Multi-tenant architecture** — a `tenantId` on every collection so each store's data stays isolated, with per-store subdomains.
- [ ] **Store onboarding API** — self-serve creation of a new store and its first admin.
- [ ] **Subscription billing** — plans and billing per store.
- [ ] **"Lucky Box" rewards API** — redeeming loyalty points on a gamified reward.
- [ ] **Real-time store settings** — settings pushed to clients instantly, instead of being polled (the maintenance page currently re-checks every 4 seconds).
- [ ] **Chat module** — real-time messaging between customers and support/admin.
- [ ] **Coupons & promo codes** — discount codes validated and applied server-side.
- [ ] **Real payment gateway integration** — Stripe/SSLCommerz/bKash, replacing the simulated flow.
- [ ] **Rate limiting & request logging** — hardening for production traffic.
- [ ] **Automated tests** — unit/integration coverage per module.

---

## 🎓 About This Project

An internship project for learning and demonstration — not distributed under an open-source license. Feel free to explore the code, but please reach out before reusing or redistributing it.