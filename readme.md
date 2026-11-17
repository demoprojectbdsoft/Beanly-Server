<div align="center">

# ⚡ Sparq — Backend API

### *REST API for a full-stack e-commerce platform*

**Express 5 + MongoDB backend powering catalog, orders, delivery & rider operations, multi-vendor marketplace, loyalty, and comprehensive CMS**

[![Live API](https://img.shields.io/badge/API-Live-success?style=for-the-badge)](https://sparq-api.vercel.app/api)
[![Backend Repo](https://img.shields.io/badge/Backend-Repository-2ea44f?style=for-the-badge)](https://github.com/demoprojectbdsoft/Sparq-Server)
[![Frontend Repo](https://img.shields.io/badge/Frontend-Repository-blue?style=for-the-badge)](https://github.com/demoprojectbdsoft/Sparq-Electronics-Store)

</div>

---

## 📑 Table of Contents

1. [Overview](#-overview)
2. [Architecture](#️-architecture)
3. [API Documentation](#-api-documentation)
4. [Business Rules](#-business-rules)
5. [Security](#-security)
6. [Tech Stack](#-tech-stack)
7. [Project Structure](#-project-structure)
8. [Setup & Installation](#-setup--installation)
9. [Environment Variables](#-environment-variables)
10. [Development](#-development)
11. [Deployment](#-deployment)
12. [Project Status](#-project-status)
13. [Contributing](#-contributing)
14. [License](#-license)

---

## 📖 Overview

Sparq-Server is the backend API for the [Sparq](https://github.com/demoprojectbdsoft/Sparq-Electronics-Store) e-commerce platform. It handles all business logic, data persistence, and authorization while the Next.js frontend owns authentication.

### Core Responsibilities

**✅ What This Server Owns**

| Responsibility | Description |
|---------------|-------------|
| **Business Logic** | All pricing, discounts, shipping, points, and totals computed server-side |
| **Authorization** | JWT verification, role guards, ownership checks on every request |
| **Data Integrity** | Transactional order processing, atomic points operations, stock management |
| **Delivery & Riders** | Rider offers, accept/decline, hand-over codes, payouts, live location |
| **Scheduled Jobs** | Demo restore, unanswered-offer sweep, subscription, placement and product-offer expiry |
| **Email Delivery** | Transactional emails via SMTP (order and delivery updates, password resets, admin replies) |

**❌ What This Server Does NOT Own**

- **Authentication**: Sign-up, login, sessions, and JWTs handled by better-auth in frontend
- **Session Storage**: Frontend stores sessions in MongoDB; backend only verifies tokens

### System Architecture

```mermaid
graph TB
    subgraph "Frontend (Next.js)"
        A[User Request]
        B[better-auth]
        C[JWT Token]
    end
    
    subgraph "Backend (Express)"
        D[Auth Middleware]
        E[Route Handler]
        F[Validator Zod]
        G[Controller]
        H[Service Layer]
        I[Model Layer]
    end
    
    subgraph "Database"
        J[(MongoDB Atlas)]
    end
    
    subgraph "External"
        K[SMTP Server]
    end
    
    A --> B
    B --> C
    C --> D
    D -->|Valid| E
    D -->|Invalid| M[401/403]
    E --> F
    F -->|Valid| G
    F -->|Invalid| N[400]
    G --> H
    H --> I
    I --> J
    H --> K
    
    style D fill:#f59e0b
    style H fill:#60a5fa
    style J fill:#10b981
```

### Request Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant M as Middleware
    participant V as Validator
    participant Ctrl as Controller
    participant Svc as Service
    participant DB as MongoDB
    
    C->>M: POST /api/orders + JWT
    M->>M: Verify JWT via JWKS
    alt Invalid Token
        M-->>C: 401 Unauthorized
    end
    M->>M: Extract userId & role
    M->>V: Validate request body
    alt Invalid Data
        V-->>C: 400 Bad Request
    end
    V->>Ctrl: Pass validated data
    Ctrl->>Svc: Call business logic
    
    Svc->>DB: Start transaction
    Svc->>DB: Check stock
    Svc->>DB: Create order
    Svc->>DB: Create transaction
    Svc->>DB: Update stock
    Svc->>DB: Clear cart
    Svc->>DB: Commit transaction
    
    Svc-->>Ctrl: Return order
    Ctrl-->>C: 201 { success, data }
```

---

## 🏗️ Architecture

### Layered Architecture

Every module follows the same five-layer pattern for consistency:

```
┌─────────────────────────────────────┐
│         route.ts                    │  Maps URLs to controllers
│  - Defines HTTP methods & paths    │  Attaches auth/role middleware
│  - Mounts validators               │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│       validator.ts                  │  Zod schemas
│  - Validates request body/params   │  Rejects invalid input early
│  - Type-safe validation            │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│      controller.ts                  │  HTTP layer
│  - Reads request                   │  Calls service
│  - Sends response (apiResponse)    │  Error handling
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│       service.ts                    │  Business logic
│  - Computes prices, totals         │  Database operations
│  - Enforces business rules         │  Calls other services
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│        model.ts                     │  Mongoose schema
│  - Defines data structure          │  Indexes, virtuals
│  - Validation rules                │
└─────────────────────────────────────┘
```

### Module Organization

```
src/modules/
├── product/
│   ├── product.model.ts          # Mongoose schema
│   ├── product.service.ts        # Business logic
│   ├── product.controller.ts     # HTTP handlers
│   ├── product.validator.ts      # Zod schemas
│   ├── product.route.ts          # Express routes
│   └── product.types.ts          # TypeScript types
│
├── order/                        # Order processing
├── delivery/                     # Rider offers, tracking, hand-over codes
├── rider/                        # Rider applications
├── user/                         # User management
├── vendor/                       # Vendor marketplace, plans, analytics
├── file/                         # Application documents
└── ...
```

### Middleware Pipeline

```mermaid
graph LR
    A[Request] --> B{Auth Required?}
    B -->|Yes| C[requireAuth]
    B -->|No| D[Public Route]
    
    C --> E{Token Valid?}
    E -->|No| F[401]
    E -->|Yes| G{Role Check?}
    
    G -->|Yes| H[requireRole]
    G -->|No| I[Controller]
    
    H --> J{Has Role?}
    J -->|No| K[403]
    J -->|Yes| I
    
    D --> I
    I --> L[Response]
    
    style C fill:#fbbf24
    style H fill:#f59e0b
    style I fill:#60a5fa
```

### Database Schema Overview

```mermaid
erDiagram
    User ||--o{ Order : places
    User ||--o{ Review : writes
    User ||--o{ CartItem : has
    User ||--o{ WishlistItem : saves
    User ||--|| VendorStore : owns
    
    Order ||--|{ OrderItem : contains
    Order ||--|| Transaction : has
    Order ||--o{ VendorOrder : splits_into
    Order ||--o{ Delivery : ships_via
    
    Product ||--o{ OrderItem : ordered_in
    Product ||--o{ Review : has
    Product ||--o{ CartItem : in
    Product }o--|| Category : belongs_to
    Product }o--|| Subcategory : belongs_to
    Product }o--|| VendorStore : sold_by
    
    VendorStore ||--o{ Product : sells
    VendorStore ||--o{ VendorOrder : fulfills
    VendorStore ||--|| Subscription : has
    VendorStore ||--o{ Coupon : creates
    
    Coupon ||--o{ Order : applied_to
    
    Delivery ||--|| DeliveryCode : hands_over_with
    User ||--o{ Delivery : rides
    User ||--o{ RiderApplication : applies
    User ||--o{ Activity : receives
    
    Review ||--|| Product : reviews
    Review ||--|| User : by
```

---

## 📚 API Documentation

Base URL: `/api`  
All responses: `{ success: boolean, message: string, data?: any }`

### Access Levels

| Icon | Access Level | Description |
|------|-------------|-------------|
| 🌐 | **Public** | No authentication required |
| 🔐 | **Bearer** | Valid JWT token required |
| 👑 | **Admin** | Admin or demo admin role required |
| ⏰ | **Cron** | CRON_SECRET or Vercel cron header required |
| 🛵 | **Rider** | Approved rider role required |
| 🔑 | **Internal** | `x-internal-key` matching INTERNAL_API_KEY (storefront only) |

### Authentication & Users

#### Users

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/users` | 👑 | List all users (paginated, searchable) |
| `GET` | `/users/me/roles` | 🔐 | Get current user's roles and status |
| `GET` | `/users/me/export` | 🔐 | Export user data as JSON |
| `PATCH` | `/users/me/active-role` | 🔐 | Switch active dashboard role |
| `GET` | `/users/:id` | 🔐 | Get user by ID (owner or admin) |
| `PATCH` | `/users/:id` | 🔐 | Update user (owner limited, admin full) |
| `POST` | `/users/:id/roles` | 👑 | Set user's approved roles |
| `PATCH` | `/users/:id/roles/revoke` | 👑 | Revoke a single role |
| `PATCH` | `/users/:id/roles/suspension` | 👑 | Suspend/unsuspend a role |
| `DELETE` | `/users/:id` | 👑 | Delete user account |

#### Saved Addresses

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/addresses` | 🔐 | List user's saved addresses |
| `POST` | `/addresses` | 🔐 | Add new address |
| `PATCH` | `/addresses/:id` | 🔐 | Update address |
| `PATCH` | `/addresses/:id/default` | 🔐 | Set as default |
| `DELETE` | `/addresses/:id` | 🔐 | Delete address |

### Catalog

#### Categories

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/categories` | 🌐 | List all categories |
| `POST` | `/categories` | 👑 | Create category |
| `PATCH` | `/categories/:id` | 👑 | Update category |
| `DELETE` | `/categories/:id` | 👑 | Delete category (cascades to subcategories) |

#### Subcategories

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/subcategories` | 🌐 | List all subcategories |
| `POST` | `/subcategories` | 👑 | Create subcategory |
| `PATCH` | `/subcategories/:id` | 👑 | Update subcategory |
| `DELETE` | `/subcategories/:id` | 👑 | Delete subcategory |

#### Products

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/products` | 🌐 | Search & filter products |
| `GET` | `/products/:slug` | 🌐 | Get single product |
| `POST` | `/products` | 👑 | Create product |
| `PATCH` | `/products/:id` | 👑 | Update product |
| `DELETE` | `/products/:id` | 👑 | Delete product |

**Query Parameters for `/products`:**
```
?search=          # Search in title, brand, description
?category=        # Filter by category ID
?subcategory=     # Filter by subcategory ID
?minPrice=        # Minimum price
?maxPrice=        # Maximum price
?hasOffer=true    # Only products with discounts
?storeSlug=       # Filter by vendor store
?sort=            # newest | price-asc | price-desc | rating | popular
?page=1           # Page number
?limit=12         # Items per page
?minDiscount=     # Minimum discount percentage
?maxDiscount=     # Maximum discount percentage
?badge=           # Products carrying a badge
?minRating=       # Minimum rating
```

#### Product Engagement

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `POST` | `/engagement/products/:productId` | 🌐 | Record a view, a cart add or a purchase |
| `GET` | `/engagement/products` | 👑 | Views versus sales per product (admin desk) |

A visitor's view is counted without a session; `attachUser` only lets the API recognise a seller looking at their own listing, so the seller's dashboard can subtract those views from its numbers.

#### Homepage Content

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/slides` | 🌐 | Get hero slider slides |
| `POST` | `/slides` | 👑 | Create slide |
| `PATCH` | `/slides/:id` | 👑 | Update slide |
| `DELETE` | `/slides/:id` | 👑 | Delete slide |
| `GET` | `/promos` | 🌐 | Get promo banners |
| `POST` | `/promos` | 👑 | Create promo banner |
| `PATCH` | `/promos/:id` | 👑 | Update promo banner |
| `DELETE` | `/promos/:id` | 👑 | Delete promo banner |

### Shopping

#### Cart

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/cart` | 🔐 | Get user's cart |
| `GET` | `/cart/is-carted?productId=` | 🔐 | Check if product in cart |
| `POST` | `/cart` | 🔐 | Add item to cart |
| `PATCH` | `/cart/:productId` | 🔐 | Update quantity |
| `DELETE` | `/cart` | 🔐 | Clear cart |
| `DELETE` | `/cart/:productId` | 🔐 | Remove item |

#### Wishlist

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/wishlist` | 🔐 | Get user's wishlist |
| `GET` | `/wishlist/is-wishlisted?productId=` | 🔐 | Check if product wishlisted |
| `POST` | `/wishlist` | 🔐 | Add to wishlist |
| `DELETE` | `/wishlist/:productId` | 🔐 | Remove from wishlist |

#### Orders

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/orders` | 🔐 | List orders (customer: own, admin: all) |
| `GET` | `/orders/:id` | 🔐 | Get order details (owner or admin) |
| `POST` | `/orders` | 🔐 | Place new order |
| `PATCH` | `/orders/:id/status` | 👑 | Update order status |
| `PATCH` | `/orders/:id/customer-response` | 🔐 | Report delivery outcome |
| `GET` | `/order-status?orderId=` | 🔐 | Get status history |

**Place Order Request:**
```json
{
  "items": [
    { "productId": "...", "quantity": 2 }
  ],
  "shippingAddress": {
    "fullName": "John Doe",
    "phone": "+1234567890",
    "address": "123 Main St",
    "city": "New York",
    "postalCode": "10001"
  },
  "paymentMethod": "cod" | "bkash" | "rocket" | "nagad",
  "transactionId": "TXN123",  // for mobile wallets
  "useRewardPoints": true,
  "couponCode": "SAVE10",
  "shippingMethod": "standard" | "express"
}
```

#### Delivery & Tracking

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/deliveries/admin` | 👑 | Every delivery (status, rider, date filters) |
| `GET` | `/deliveries/admin/overview` | 👑 | Counters for the delivery board |
| `GET` | `/deliveries/admin/riders` | 👑 | Approved riders with availability and load |
| `GET` | `/deliveries/admin/payouts` | 👑 | What each delivered job paid the rider |
| `GET` | `/deliveries/admin/order/:orderId` | 👑 | Every attempt made for one order |
| `POST` | `/deliveries` | 👑 | Offer an order to a rider (fee, distance, note) |
| `PATCH` | `/deliveries/:id/reassign` | 👑 | Hand the job to another rider |
| `PATCH` | `/deliveries/:id/cancel` | 👑 | Stop an offer or a running job |
| `GET` | `/deliveries/tracking/:orderId` | 🔐 | Customer view: rider, steps, last position |
| `GET` | `/deliveries/tracking/:orderId/code` | 🔐 | Buyer's hand-over code and its expiry |
| `POST` | `/deliveries/tracking/:orderId/code` | 🔐 | Regenerate the hand-over code |
| `GET` | `/deliveries` | 🛵 | Rider's own jobs |
| `GET` | `/deliveries/stats` | 🛵 | Rider's counters and earnings |
| `GET` | `/deliveries/:id` | 🛵 | One of the rider's own jobs |
| `GET` | `/deliveries/:id/invoice` | 🛵 | Payout invoice for a delivered job |
| `POST` | `/deliveries/:id/accept` | 🛵 | Accept the offer |
| `POST` | `/deliveries/:id/decline` | 🛵 | Decline with a reason |
| `PATCH` | `/deliveries/:id/status` | 🛵 | `picked_up` → `out_for_delivery` |
| `POST` | `/deliveries/:id/complete` | 🛵 | Hand over by entering the buyer's code |
| `POST` | `/deliveries/:id/location` | 🛵 | Push the rider's position for the live map |
| `GET` | `/deliveries/expire` | ⏰ | Sweep offers nobody answered |

**Tracking payload:** rider name, phone and vehicle, the ordered steps with a timestamp for each, the shop's pick-up location, and the last shared position — the map the tracking page draws.

#### Transactions

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/transactions` | 🔐 | Payment records (customer: own, admin: all) |
| `GET` | `/transactions/vendor` | Vendor | Payments for the seller's own rows |

### Marketing

#### Coupons (Store-Wide)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/coupons` | 👑 | List all coupons (admin & vendor) |
| `GET` | `/coupons/:id` | 👑 | Get single coupon |
| `POST` | `/coupons` | 👑 | Create store coupon |
| `PATCH` | `/coupons/:id` | 👑 | Update store coupon |
| `DELETE` | `/coupons/:id` | 👑 | Delete store coupon |
| `POST` | `/coupons/validate` | 🔐 | Validate coupon code |

**Coupon Types:**
- **Percentage**: 1-100% discount
- **Fixed**: Flat amount discount

**Scope:**
- `productIds`: Specific products
- `categoryIds`: Product categories
- Empty: All products (admin) or vendor's products

#### Featured Promotions (Admin)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/promotions` | 👑 | List all featured placements |
| `POST` | `/promotions` | 👑 | Grant featured placement |
| `DELETE` | `/promotions/:id` | 👑 | End placement early |
| `GET` | `/promotions/expire` | ⏰ | Daily sweep (close expired) |

### Multi-Vendor

#### Vendor Applications

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `POST` | `/vendor-applications/status` | 🔑 | Auth-layer lookup after the password check |
| `POST` | `/vendor-applications` | 🔐 | Submit application |
| `GET` | `/vendor-applications/mine` | 🔐 | Get own applications |
| `POST` | `/vendor-applications/mine/cancel` | 🔐 | Withdraw application |
| `GET` | `/vendor-applications` | 👑 | List all applications |
| `GET` | `/vendor-applications/:id` | 👑 | Get application details |
| `PATCH` | `/vendor-applications/:id/review` | 👑 | Approve/reject application |

#### Vendor Stores

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/vendor-store/public` | 🌐 | List trading stores |
| `GET` | `/vendor-store/public/:slug` | 🌐 | Get store by slug |
| `GET` | `/vendor-store` | 👑 | List all stores (admin) |
| `GET` | `/vendor-store/mine` | Vendor | Get own store |
| `PATCH` | `/vendor-store/mine` | Vendor | Update own store |

#### Vendor Products

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/vendor-products` | Vendor | List own products |
| `GET` | `/vendor-products/:id` | Vendor | Get own product |
| `POST` | `/vendor-products` | Vendor | Create product |
| `PATCH` | `/vendor-products/:id` | Vendor | Update product |
| `DELETE` | `/vendor-products/:id` | Vendor | Archive product |

#### Vendor Orders

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/vendor-orders` | Vendor | List fulfillment groups |
| `GET` | `/vendor-orders/summary` | Vendor | Order counts by status |
| `GET` | `/vendor-orders/:id` | Vendor | Get group details |
| `PATCH` | `/vendor-orders/:id/status` | Vendor | Update fulfillment status |

**Vendor Order Stages:**
```
pending → accepted → processing → ready_for_shipment
  ↓
rejected
```

#### Vendor Plans (Price List)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/vendor-plans` | 🌐 | Public price list (pricing cards, seller's plan desk) |
| `POST` | `/vendor-plans` | 👑 | Add a plan |
| `PATCH` | `/vendor-plans/:planId` | 👑 | Edit a plan |
| `DELETE` | `/vendor-plans/:planId` | 👑 | Remove a plan |

#### Vendor Subscription

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/vendor-subscription/mine` | Vendor | Get active subscription |
| `POST` | `/vendor-subscription/checkout` | Vendor | Subscribe to plan |
| `POST` | `/vendor-subscription/cancel-renewal` | Vendor | Turn off auto-renew |
| `GET` | `/vendor-subscription/expire` | ⏰ | Daily sweep (close expired) |

#### Vendor Coupons

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/vendor-coupons` | Vendor | List own coupons |
| `GET` | `/vendor-coupons/:id` | Vendor | Get own coupon |
| `POST` | `/vendor-coupons` | Vendor | Create coupon |
| `PATCH` | `/vendor-coupons/:id` | Vendor | Update coupon |
| `DELETE` | `/vendor-coupons/:id` | Vendor | Delete coupon |

#### Vendor Promotions

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/vendor-promotions` | Vendor | List own placements |
| `POST` | `/vendor-promotions` | Vendor | Buy featured slot |
| `DELETE` | `/vendor-promotions/:id` | Vendor | End placement early |

#### Vendor Analytics

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/vendor-analytics?range=` | Vendor | Sales report (7/30/90/365 days) |

#### Vendor Desk (Platform Earnings)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/vendor-desk?months=` | 👑 | Subscriptions, commission and sales trend (3-12 months) |

### Rider Onboarding

#### Rider Applications

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `POST` | `/rider-applications/status` | 🔑 | Auth-layer lookup after the password check |
| `POST` | `/rider-applications` | 🔐 | Submit or resubmit an application |
| `GET` | `/rider-applications/mine` | 🔐 | Get own application |
| `PATCH` | `/rider-applications/mine` | 🔐 | Update own application (licence, vehicle, availability) |
| `POST` | `/rider-applications/mine/cancel` | 🔐 | Withdraw the application |
| `GET` | `/rider-applications` | 👑 | List applications |
| `GET` | `/rider-applications/:id` | 👑 | Application with its uploaded documents |
| `PATCH` | `/rider-applications/:id/review` | 👑 | Approve (grants the rider role) or reject |

**Application contents:** personal details, emergency contact, service area with coordinates, vehicle and licence, uploaded documents (licence, national ID, vehicle papers), availability (days, time slots, maximum distance) and experience. A rejection keeps the same row so a resubmission updates it and the review history stays in one place.

### Support

#### Reviews

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/reviews` | 🌐 | List reviews (filterable) |
| `POST` | `/reviews` | 🔐 | Create review |
| `PATCH` | `/reviews/:id` | 🔐 | Update own review |
| `DELETE` | `/reviews/:id` | 🔐 | Delete review (owner or admin) |
| `GET` | `/reviews/vendor` | Vendor | Reviews on the seller's own products |

#### Product Warranty Fields

A warranty is a property of the listing, not a workflow of its own. The product document carries `warrantyPeriodMonths` (0-120), `warrantyType` and `warrantyTerms`; the admin and vendor product forms write them and the product page and admin product view read them. There is no claim API: nothing is issued at delivery, and no warranty record, dashboard or customer claim endpoint exists.

#### Contact & Messages

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `POST` | `/contact` | 🌐 | Submit contact form |
| `GET` | `/messages` | 👑 | List contact messages |
| `POST` | `/messages/:id/reply` | 👑 | Reply to message |
| `DELETE` | `/messages/:id` | 👑 | Delete message |

#### Notifications

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/activities/mine` | 🔐 | Get notification feed |
| `GET` | `/activities/mine/unread-count` | 🔐 | Get unread count |
| `PATCH` | `/activities/mine/read-all` | 🔐 | Mark all as read |
| `PATCH` | `/activities/mine/:id/read` | 🔐 | Mark one as read |

### System

#### Site Settings

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET` | `/site-settings` | 🌐 | Get store configuration |
| `PATCH` | `/site-settings` | 👑 | Update settings |

#### Demo Admin

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `GET/POST` | `/demo/restore` | ⏰ | Restore demo changes |

#### Files (Application Documents)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `POST` | `/files` | 🔑 | Store one document (JSON body, 12 MB cap) |
| `GET` | `/files/:id` | 🌐 | Read a stored document |
| `GET` | `/files/:id/:name` | 🌐 | Read it with the original filename in the URL |

The bytes are kept in MongoDB beside the application that used them, so a licence or a scanned certificate survives as long as the application does. Reading is open because a browser preview is a plain request with no header to attach a key to; writing requires the storefront's internal key.

#### Mail (Internal)

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| `POST` | `/mail/reset-password` | 🔑 | Send password reset email |

---

## 📋 Business Rules

### Multi-Role Accounts

One user can hold multiple roles simultaneously:

```mermaid
graph TD
    A[User Account] --> B[Approved Roles Array]
    B --> C[customer]
    B --> D[vendor]
    B --> E[rider]
    B --> F[admin]
    
    A --> G[Active Role]
    G --> H{Current Dashboard}
    
    A --> I[Role Suspensions]
    I --> J[Suspended: rider]
    
    style C fill:#60a5fa
    style D fill:#8b5cf6
    style E fill:#f59e0b
    style F fill:#ef4444
    style J fill:#6b7280
```

**Rules:**
- `roles[]`: Approved roles (source of truth)
- `activeRole`: Current dashboard
- `roleSuspensions[]`: Temporarily blocked roles
- Admin authority never shares with other roles
- Customer role always included (except admin)
- Suspended roles block dashboard access but remain approved

### Order Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Confirmed: Place Order
    
    Confirmed --> Processing: Admin/Vendor Accepts
    Processing --> Shipped: Dispatch
    Shipped --> Delivered: Customer Confirms
    Delivered --> [*]
    
    Confirmed --> Cancelled: Cancel
    Processing --> Cancelled: Cancel
    Shipped --> Cancelled: Return
    Delivered --> Cancelled: Return
    
    Cancelled --> [*]
    
    note right of Confirmed
        Stock decremented
        Payment initiated
        Points redeemed
        Cart cleared
    end note
    
    note right of Delivered
        Payment confirmed
        Points credited
        Sell count updated
    end note
    
    note right of Cancelled
        Stock restored
        Points refunded
        Transaction failed
    end note
```

**Placing an Order (Atomic Transaction):**

```typescript
async function placeOrder() {
  const session = await mongoose.startSession();
  await session.withTransaction(async () => {
    // 1. Validate stock
    await checkStock(items);
    
    // 2. Redeem points (atomic update)
    await User.findOneAndUpdate(
      { _id: userId, points: { $gte: pointsToSpend } },
      { $inc: { points: -pointsToSpend } },
      { session }
    );
    
    // 3. Create order & transaction
    const order = await Order.create([orderData], { session });
    await Transaction.create([transactionData], { session });
    
    // 4. Decrement stock
    await decrementStock(items, session);
    
    // 5. Log status history
    await OrderStatus.create([{ orderId, status: 'confirmed' }], { session });
    
    // 6. Clear cart
    await Cart.deleteMany({ userId }, { session });
    
    // 7. Create vendor groups (if multi-vendor)
    await createVendorOrders(order, session);
  });
}
```

**On Delivery:**
```typescript
async function applyDelivery(orderId) {
  // 1. Mark payments successful
  await Transaction.updateMany(
    { orderId },
    { status: 'success' }
  );
  
  // 2. Update sell counts
  for (const item of order.items) {
    await Product.findByIdAndUpdate(
      item.productId,
      { $inc: { sellCount: item.quantity } }
    );
  }
  
  // 3. Credit loyalty points
  await User.findByIdAndUpdate(
    order.userId,
    { $inc: { points: order.pointsEarned } }
  );
  
  // 4. Update membership tier
  await updateMembershipTier(order.userId);
}
```

### Multi-Vendor Order Splitting

One customer checkout with items from multiple vendors creates:
- **1 Order document** (customer, payment, delivery, total)
- **N VendorOrder documents** (one per vendor with their items)

```mermaid
graph TB
    A[Customer Checkout] --> B[Single Order]
    B --> C[VendorOrder: Seller A]
    B --> D[VendorOrder: Seller B]
    B --> E[VendorOrder: Platform]
    
    B --> F[One Payment]
    B --> G[One Delivery]
    
    C --> H[Items from A]
    D --> I[Items from B]
    E --> J[Platform Items]
    
    H --> K[Seller A Fulfillment]
    I --> L[Seller B Fulfillment]
    J --> M[Platform Fulfillment]
    
    K --> N[Ready for Pickup]
    L --> N
    M --> N
    
    N --> O[Rider Assignment]
    O --> P[Delivery]
    
    style B fill:#60a5fa
    style C fill:#8b5cf6
    style D fill:#8b5cf6
    style E fill:#10b981
```

**Vendor Order Stages:**
```
pending → accepted → processing → ready_for_shipment
  ↓
rejected (with reason)
```

**Parent Order Stages:**
```
confirmed → processing → shipped → delivered
```

**Synchronization:**
- Vendor marks `ready_for_shipment` → notification to admin
- Admin assigns rider → `deliveryId` and `riderId` copied to all groups
- Parent order `shipped`/`delivered`/`cancelled` → cascades to vendor groups

### Loyalty Points System

**Earning:**
```
Points Earned = floor(Discounted Subtotal)
Example: $147.50 order → 147 points
```

**Redemption:**
```
100 points = 1 currency unit
Minimum: 100 points
Maximum: Product total (shipping always paid in cash)
```

**Atomic Redemption:**
```javascript
// Two concurrent checkouts cannot double-spend
await User.findOneAndUpdate(
  {
    _id: userId,
    points: { $gte: pointsToSpend }  // Conditional check
  },
  {
    $inc: { points: -pointsToSpend }  // Atomic decrement
  }
);
// Returns null if balance insufficient
```

**Membership Tiers:**
- 🥈 **Silver**: 0 - 999 points
- 🥇 **Gold**: 1,000 - 3,999 points
- 💎 **Platinum**: 4,000 - 9,999 points
- 💎 **Diamond**: 10,000+ points

### Product Warranty Fields

A warranty is a property of the listing, not a workflow of its own.

**5 Warranty Types:**

| Type | Covered By |
|------|-----------|
| `manufacturer-warranty` | The brand's own service centre |
| `seller-warranty` | The store that sold the item |
| `extended-warranty` | The store, past the usual period |
| `other` | Per the terms written on the listing |
| `none` | Nobody |

**Rules:**
- `warrantyPeriodMonths` (0-120), `warrantyType` and `warrantyTerms` sit on the product document
- The admin product form and the vendor product form write them; the product page, the compare table and the admin product view read them
- `warrantyPeriodMonths: 0` or `warrantyType: "none"` means the item is sold without cover
- Nothing is issued at delivery and there is no claim record, dashboard page, cron job or claim endpoint — the customer's warranty is the promise printed on the product page, and a claim reaches the shop through the support desk like any other message

### Delivery & Rider Operations

```mermaid
stateDiagram-v2
    [*] --> assigned: Store offers the order
    assigned --> accepted: Rider accepts
    assigned --> declined: Rider declines (reason)
    assigned --> cancelled: Store cancels or the offer lapses
    accepted --> picked_up: Rider collects the parcel
    picked_up --> out_for_delivery: Rider leaves for the address
    out_for_delivery --> delivered: Buyer's code entered
    out_for_delivery --> delivered: Buyer confirms on the tracking page
    delivered --> [*]
```

**Rules:**
- **One rider per order**: an order holds one live offer, and another rider cannot be offered it until the first declines, the offer lapses or the store cancels
- **Offer window**: an offer carries a fee (the order's shipping fee, or the store's default) plus an expiry; `GET /deliveries/expire` closes unanswered offers so the order is free again
- **Forward only**: the rider moves `picked_up` → `out_for_delivery` → `delivered`; a step cannot be skipped or rewound
- **Hand-over code**: six digits, stored only as `sha256(deliveryId:code)` with an expiry and a wrong-attempt budget. Only the buyer's tracking page is given the code — never a rider endpoint and never a list
- **Delivery pays the rider**: reaching `delivered` books the fee (`feePaidVia: "code"` or `"customer"`), and the rider's earnings are the sum of delivered fees. There is no separate payout step
- **Live position**: while a job is live the rider pushes a position, and the customer's tracking map reads the last one
- **Reassignment**: cancelling and offering again is how a job changes hands, so every attempt stays in the order's history

### Vendor Subscription Plans

The price list is data, not code:

- Plans live in the `SubscriptionPlan` collection and the store team edits them: name, monthly and yearly price, product cap, featured slots and duration, active-coupon cap, analytics tier, report depth, export level (`none` / `csv` / `csv+pdf`), store customisation, campaign priority, support tier, commission percent, grace days, billing cycles and sort order
- `planId` is a slug derived from the name, so a plan added later needs no deploy
- A plan may run a time-boxed price offer (`offerPercent` + `offerEndsAt`) without touching its real price
- Entitlements gate the seller's screens, so a plan that does not sell a report cannot open it
- `GET /vendor-subscription/expire` closes lapsed periods after the grace days; a closed subscription ends the seller's featured placements

### Scheduled Jobs

| Job | Route | Local cron | What it does |
|-----|-------|-----------|--------------|
| Demo restore | `GET/POST /demo/restore` | 12:00 AM | Puts the demo store back to its seed state |
| Delivery sweep | `GET /deliveries/expire` | Every 10 minutes | Closes rider offers nobody answered |
| Vendor periods | `GET /vendor-subscription/expire` | 12:45 AM | Ends lapsed subscriptions after their grace days |
| Featured placements | `GET /promotions/expire` | 1:00 AM | Ends placements whose `endsAt` has passed |
| Product offers | `GET /products/expire` | Vercel Cron only | Flags products whose offer window closed |

Local schedules run on `node-cron` in `src/index.ts` on `CRON_TIMEZONE`; the same routes are listed in `vercel.json` for the serverless deployment.

### Discount Coupons

**One Engine, Two Owners:**

```mermaid
graph TB
    A[Coupon Code] --> B{ownerType}
    B -->|admin| C[Store-Wide]
    B -->|vendor| D[Vendor-Specific]
    
    C --> E[Any Product/Category]
    D --> F[Only Vendor's Products]
    
    E --> G[Checkout Validation]
    F --> G
    
    G --> H{Valid?}
    H -->|Yes| I[Apply Discount]
    H -->|No| J[Error Message]
    
    style C fill:#ef4444
    style D fill:#8b5cf6
```

**Coupon Rules:**
- `code` stored uppercase (unique index)
- Admin coupons: Any product/category
- Vendor coupons: Only own products
- Discount types: `percentage` (1-100%) or `fixed` amount
- Optional: `productIds`, `categoryIds`, `minOrderAmount`, `maxDiscountAmount`
- Usage limits: `usageLimit`, `usagePerCustomer`
- Date range: `startDate`, `endDate`

**Redemption Ledger:**
```javascript
coupon.redemptions.push({
  orderId,
  customerId,
  amount: discountApplied,
  at: new Date()
});
coupon.usedCount++;
coupon.discountGiven += discountApplied;
```

**Cancellation Reversal:**
```javascript
// Find unreversed redemption
const redemption = coupon.redemptions.find(
  r => r.orderId.equals(orderId) && !r.reversedAt
);
if (redemption) {
  redemption.reversedAt = new Date();
  coupon.usedCount--;
  coupon.discountGiven -= redemption.amount;
}
```

### Featured Promotions

**Two Kinds:**
- **Product**: Feature one listing
- **Store**: Feature entire vendor storefront

**Rules:**
- Only one module writes `Product.isFeatured` and `VendorStore.isFeatured`
- Vendor can buy product slots (plan determines duration/limit)
- Admin can grant product OR store placements (1-365 days)
- State derived from `endsAt` + status (always accurate)
- Daily sweep closes expired placements
- Unpublishing/archiving product ends its placement
- Expired subscription ends all vendor's placements

**Placement States:**
```typescript
type PlacementStatus = 'live' | 'ended' | 'cancelled';

function getPlacementStatus(placement: Placement): PlacementStatus {
  if (placement.status === 'cancelled') return 'cancelled';
  if (new Date() > placement.endsAt) return 'ended';
  return 'live';
}
```

---

## 🔒 Security

### Authentication Architecture

```mermaid
sequenceDiagram
    participant C as Client
    participant F as Frontend
    participant BA as better-auth
    participant B as Backend
    participant DB as MongoDB
    
    C->>F: Login
    F->>BA: Authenticate
    BA->>DB: Verify Credentials
    DB-->>BA: User
    BA->>BA: Generate JWT
    BA-->>F: JWT + Session
    
    F->>B: API Request + JWT
    B->>F: GET /api/auth/jwks (JWKS endpoint)
    F-->>B: Public Key
    B->>B: Verify JWT Signature
    B->>B: Check Expiry
    B->>DB: Read Fresh Roles
    DB-->>B: User Roles
    B->>B: Authorize Request
    B-->>C: Response
```

### Security Layers

**1. JWT Verification (Every Request)**
```javascript
// middlewares/auth.middleware.ts
const token = req.headers.authorization?.replace('Bearer ', '');
const jwks = await fetchJWKS(`${process.env.NEXT_PUBLIC_CLIENT_URL}/api/auth/jwks`);
const { payload } = await jwtVerify(token, jwks);
req.userId = payload.sub;  // User ID from token
```

**2. Role Authorization**
```javascript
// middlewares/role.middleware.ts
export const requireRole = (role: string) => {
  return async (req, res, next) => {
    const user = await User.findById(req.userId).select('roles roleSuspensions');
    
    // Check if role is approved
    if (!user.roles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }
    
    // Check if role is suspended
    const isSuspended = user.roleSuspensions.some(s => s.role === role);
    if (isSuspended) {
      return res.status(403).json({
        success: false,
        message: 'This role has been suspended'
      });
    }
    
    next();
  };
};
```

**3. Ownership Checks**
```javascript
// utils/authz.ts

// Owner or admin can access
export function assertOwnerOrAdmin(
  resourceUserId: string,
  requestUserId: string,
  requestUserRole: string
) {
  const isOwner = resourceUserId === requestUserId;
  const isAdmin = isAdminRole(requestUserRole);
  
  if (!isOwner && !isAdmin) {
    throw new ApiError(403, 'You can only access your own resources');
  }
}

// Example usage
const order = await Order.findById(orderId);
assertOwnerOrAdmin(order.userId, req.userId, req.userRole);
```

**4. Server-Side Price Calculation**
```javascript
// services/order.service.ts
async function calculateOrderTotals(items: CartItem[]) {
  // Fetch current prices from database (never trust client)
  const products = await Product.find({
    _id: { $in: items.map(i => i.productId) }
  });
  
  let subtotal = 0;
  for (const item of items) {
    const product = products.find(p => p._id.equals(item.productId));
    const price = product.sellingPrice || product.originalPrice;
    subtotal += price * item.quantity;
  }
  
  // Apply coupon (if valid)
  const discount = await evaluateCoupon(couponCode, items);
  
  // Apply points (atomic redemption)
  const pointsDiscount = Math.floor(pointsToSpend / 100);
  
  // Calculate shipping
  const shipping = calculateShipping(subtotal, shippingMethod);
  
  const total = subtotal - discount - pointsDiscount + shipping;
  
  return { subtotal, discount, pointsDiscount, shipping, total };
}
```

**5. Internal Key on Store-Backed Endpoints**
```javascript
// middlewares/internal.middleware.ts
// POST /mail/reset-password and POST /files are called by the storefront on
// its own behalf, never by a browser.
const expected = process.env.INTERNAL_API_KEY;
if (!expected) throw new ApiError(500, "INTERNAL_API_KEY is not configured");
if (req.headers["x-internal-key"] !== expected) {
  throw new ApiError(401, "Unauthorized: a valid internal key is required");
}
```

**6. Scheduled Job Guard**
```javascript
// middlewares/cron.middleware.ts
// Vercel sends `Authorization: Bearer <CRON_SECRET>` (and always x-vercel-cron).
// Anything else must be a signed-in store admin, so a sweep can be re-run by hand
// without opening the route to the public.
if (req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`) return next();
if (req.headers["x-vercel-cron"] === "1") return next();
// ...otherwise requireAuth + role === "admin"
```

**7. Hand-Over Code**
```javascript
// modules/delivery/delivery.otp.ts
// The code is never stored in the clear, and it is bound to one delivery,
// so two jobs with the same six digits never share a hash.
function hashCode(deliveryId, code) {
  return crypto.createHash("sha256").update(`${deliveryId}:${code}`).digest("hex");
}
// Each row carries { code, codeHash, expiresAt, attempts }; a wrong attempt is
// spent from the budget, and an expired row is never accepted.
```

### Security Best Practices

✅ **Implemented:**
- JWT verification via JWKS (no shared secret)
- Role-based access control with per-role suspension
- Ownership checks on private resources
- Role-scoped reads (a customer sees their own payments, a seller only their own rows)
- Server-side price/total calculation
- Atomic points operations (no double-spend)
- Transactional order processing
- Input validation (Zod schemas)
- MongoDB injection protection (Mongoose)
- Password reset with one-time tokens
- Internal key on store-backed endpoints (`x-internal-key`)
- Cron guard (CRON_SECRET, Vercel cron header, or a signed-in admin)
- Delivery hand-over codes hashed per delivery, with expiry and an attempt budget
- Document uploads checked by MIME type and size (8 MB at the storefront door, 12 MB body at the API)
- Account data export for the signed-in user only
- HTTPS in production (Vercel)
- Environment variable secrets
- Demo admin sandboxing
- Email header sanitization (Nodemailer)

⚠️ **Known Gaps:**
- No rate limiting
- No request logging/audit trail (the activity feed records domain events, not HTTP calls)
- CORS currently wide open
- No CSP or security headers are set by this API or the storefront

---

## 🧰 Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Runtime** | Node.js | 20+ |
| **Framework** | Express | 5.2 |
| **Language** | TypeScript | 5.x (CommonJS) |
| **Database** | MongoDB | 7.x |
| **ODM** | Mongoose | 9.x |
| **Validation** | Zod | 4.x |
| **Auth** | jose-cjs (JWKS) | Latest |
| **Email** | Nodemailer | Latest |
| **Scheduler** | node-cron | Latest |
| **Deployment** | Vercel Serverless | — |

### Key Dependencies

```json
{
  "express": "^5.2.0",
  "mongoose": "^9.0.0",
  "zod": "^4.0.0",
  "jose-cjs": "^4.0.0",
  "nodemailer": "^6.9.0",
  "node-cron": "^3.0.3",
  "dotenv": "^16.4.0"
}
```

---

## 📁 Project Structure

```
sparq-server/
├── src/
│   ├── app.ts                        # Express app setup
│   ├── index.ts                      # Server entry + cron jobs
│   │
│   ├── config/
│   │   ├── db.ts                     # MongoDB connection
│   │   └── env.ts                    # Environment validation
│   │
│   ├── middlewares/
│   │   ├── auth.middleware.ts        # JWT verification
│   │   ├── role.middleware.ts        # Role guards
│   │   ├── internal.middleware.ts    # Internal API key
│   │   ├── cron.middleware.ts        # Cron job guard
│   │   ├── error.middleware.ts       # Error handler
│   │   └── notFound.middleware.ts    # 404 handler
│   │
│   ├── modules/
│   │   ├── user/                     # User accounts
│   │   │   ├── user.model.ts
│   │   │   ├── user.service.ts
│   │   │   ├── user.controller.ts
│   │   │   ├── user.validator.ts
│   │   │   ├── user.route.ts
│   │   │   └── user.types.ts
│   │   │
│   │   ├── product/                  # Product catalog
│   │   ├── category/                 # Categories
│   │   ├── subcategory/              # Subcategories
│   │   ├── cart/                     # Shopping cart
│   │   ├── wishlist/                 # Wishlist
│   │   ├── order/                    # Order processing
│   │   ├── order-status/             # Status history
│   │   ├── delivery/                 # Rider offers, tracking, hand-over codes
│   │   ├── rider/                    # Rider applications
│   │   ├── transaction/              # Payments
│   │   ├── review/                   # Product reviews
│   │   ├── product-engagement/       # Views versus sales counters
│   │   ├── file/                     # Application documents
│   │   ├── coupon/                   # Discount coupons
│   │   ├── promo/                    # Promo banners
│   │   ├── slide/                    # Hero slider
│   │   ├── address/                  # Saved addresses
│   │   ├── contact/                  # Contact form
│   │   ├── message/                  # Stored messages
│   │   ├── activity/                 # Notifications
│   │   ├── site-settings/            # Store config
│   │   ├── demo/                     # Demo admin
│   │   ├── mail/                     # Email internal
│   │   │
│   │   └── vendor/                   # Multi-vendor
│   │       ├── vendor-application/
│   │       ├── vendor-store/
│   │       ├── vendor-product/
│   │       ├── vendor-order/
│   │       ├── vendor-subscription/
│   │       ├── vendor-plan/          # Editable price list
│   │       ├── vendor-coupon/
│   │       ├── vendor-promotion/
│   │       ├── vendor-analytics/
│   │       └── vendor-desk/          # Platform earnings report
│   │
│   └── utils/
│       ├── apiError.ts               # Error class
│       ├── apiResponse.ts            # Response formatter
│       ├── catchAsync.ts             # Async error wrapper
│       ├── validate.ts               # Zod middleware
│       ├── authz.ts                  # Authorization helpers
│       ├── transactions.ts           # DB transaction wrapper
│       ├── roles.ts                  # Role utilities
│       ├── ids.ts                    # ObjectId helpers
│       ├── mailer.ts                 # SMTP email
│       ├── emailTemplates.ts         # Email HTML
│       ├── profilePatch.ts           # Field-level profile rules
│       └── warehouse.ts              # Pick-up point a stock item sits in
│
├── api/
│   └── index.ts                      # Vercel serverless entry
│
├── vercel.json                       # Vercel config + cron jobs
├── .env.local                        # Environment (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🚀 Setup & Installation

### Prerequisites

- **Node.js** 20+ and npm
- **MongoDB** 7+ (local or Atlas)
- **SMTP credentials** for emails
- **Frontend running** (for JWKS endpoint)

### Installation

1. **Clone repository**
```bash
git clone https://github.com/demoprojectbdsoft/Sparq-Server.git
cd Sparq-Server
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment**

Create `.env.local`:

```env
# Database
MONGODB_URI=mongodb://localhost:27017
DATABASE=sparq

# Server
PORT=5000
NEXT_PUBLIC_CLIENT_URL=http://localhost:3000

# Auth
INTERNAL_API_KEY=your_internal_key_here
CRON_SECRET=your_cron_secret_here

# SMTP (Gmail example)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
MAIL_FROM=your-email@gmail.com

# Demo Admin
DEMO_ADMIN_EMAIL=demoadmin@example.com

# System
CRON_TIMEZONE=Asia/Dhaka
NODE_ENV=development
```

4. **Start server**
```bash
# Development
npm run dev

# Production build
npm run build
npm start
```

Server runs at `http://localhost:5000`

---

## 🔐 Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `DATABASE` | Database name | `sparq` |
| `PORT` | Server port | `5000` |
| `NEXT_PUBLIC_CLIENT_URL` | Frontend URL (for JWKS) | `http://localhost:3000` |
| `INTERNAL_API_KEY` | Shared with frontend | Random string |
| `CRON_SECRET` | Protects cron endpoints | Random string |

### Email Configuration (Required for Full Functionality)

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP port (587 for TLS) |
| `SMTP_SECURE` | Use SSL? (false for TLS) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `MAIL_FROM` | From address |

**Gmail Setup:**
1. Enable 2FA on Google account
2. Generate app password at https://myaccount.google.com/apppasswords
3. Use app password as `SMTP_PASS`

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEMO_ADMIN_EMAIL` | Demo admin account email | — |
| `STORE_NAME` | Store name in outbound mail (only used when Site Settings has no `siteName`) | `Sparq` |
| `STORE_INBOX` | Inbox for order notifications (only when Site Settings has no `supportEmail`) | Falls back to the settings value |
| `CONTACT_INBOX` | Inbox for contact-form mail (only when Site Settings has no `contactEmail`) | Falls back to `supportEmail` |
| `CRON_TIMEZONE` | Timezone for the in-process cron jobs | `UTC` |
| `NODE_ENV` | Environment | `development` |

### Security Notes

- **Never commit `.env.local`**
- **Rotate secrets regularly** in production
- **`INTERNAL_API_KEY` must match frontend** exactly
- **Use strong random strings** for secrets (32+ characters)

---

## 💻 Development

### Available Scripts

```bash
# Development (tsx watch, restarts on save)
npm run dev

# Compile TypeScript to dist/
npm run build

# Start the compiled server
npm start

# One-off maintenance: drop duplicate review rows
npm run dedupe:reviews

# Type checking (tsc is a dev dependency)
npx tsc --noEmit
```

### Development Workflow

1. **Start MongoDB** (local or Atlas)
2. **Start frontend** first (backend needs JWKS endpoint)
3. **Start backend** at `http://localhost:5000`
4. **Test with Postman/Thunder Client**

### Adding a New Module

1. **Create module directory**
```bash
mkdir src/modules/feature
```

2. **Create files**
```
feature/
├── feature.model.ts       # Mongoose schema
├── feature.service.ts     # Business logic
├── feature.controller.ts  # HTTP handlers
├── feature.validator.ts   # Zod schemas
├── feature.route.ts       # Express routes
└── feature.types.ts       # TypeScript types
```

3. **Define model**
```typescript
// feature.model.ts
import { Schema, model } from 'mongoose';

const featureSchema = new Schema({
  name: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

export const Feature = model('Feature', featureSchema);
```

4. **Create service**
```typescript
// feature.service.ts
import { Feature } from './feature.model';

export async function createFeature(data: any) {
  return await Feature.create(data);
}
```

5. **Create controller**
```typescript
// feature.controller.ts
import { catchAsync } from '../../utils/catchAsync';
import { apiResponse } from '../../utils/apiResponse';
import * as service from './feature.service';

export const create = catchAsync(async (req, res) => {
  const feature = await service.createFeature(req.body);
  res.status(201).json(apiResponse(true, 'Created', feature));
});
```

6. **Create validator**
```typescript
// feature.validator.ts
import { z } from 'zod';

export const createSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100)
  })
});
```

7. **Create routes**
```typescript
// feature.route.ts
import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.middleware';
import { validate } from '../../utils/validate';
import * as controller from './feature.controller';
import * as validator from './feature.validator';

const router = Router();

router.post(
  '/',
  requireAuth,
  validate(validator.createSchema),
  controller.create
);

export default router;
```

8. **Mount in app.ts**
```typescript
// app.ts
import featureRoutes from './modules/feature/feature.route';
app.use('/api/features', featureRoutes);
```

### Testing with Sample Data

There is no seed script. `src/data/` holds the starter catalogue (`categories.json`, `subCategories.json`, `products.json`, `reviews.json`); import those into MongoDB Compass, or create rows through the admin dashboard.

---

## 🚀 Deployment

### Vercel Deployment

1. **Push to GitHub**
```bash
git push origin main
```

2. **Import to Vercel**
- Go to vercel.com
- Import repository
- Select "Other" framework

3. **Configure**

**Build Settings:**
```
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

**Environment Variables:**
Add all variables from `.env.local`

4. **Deploy**

### Vercel Cron Jobs

Configured in `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/demo/restore", "schedule": "0 18 * * *" },
    { "path": "/api/deliveries/expire", "schedule": "0 18 * * *" },
    { "path": "/api/vendor-subscription/expire", "schedule": "15 19 * * *" },
    { "path": "/api/promotions/expire", "schedule": "30 19 * * *" },
    { "path": "/api/products/expire", "schedule": "45 19 * * *" }
  ]
}
```

**Cron Schedule (UTC, as Vercel runs it):**
- Demo restore: 18:00
- Delivery offer sweep: 18:00
- Subscription expiry: 19:15
- Featured placement expiry: 19:30
- Product offer expiry: 19:45

On a long-running host the same routes run in-process through `node-cron` on `CRON_TIMEZONE` (demo 12:00 AM, deliveries every 10 minutes, subscriptions 12:45 AM, placements 1:00 AM); product offers are swept by Vercel Cron only.

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure MongoDB Atlas IP whitelist
- [ ] Set strong `CRON_SECRET` and `INTERNAL_API_KEY`
- [ ] Configure production SMTP credentials
- [ ] Update `NEXT_PUBLIC_CLIENT_URL` to production frontend
- [ ] Enable MongoDB Atlas backups
- [ ] Set up error monitoring (Sentry, etc.)
- [ ] Configure rate limiting
- [ ] Test all cron jobs
- [ ] Verify email delivery
- [ ] Check CORS settings

---

## 📊 Project Status

| Feature | Status |
|---------|--------|
| **Core API** | ✅ Complete |
| **Authentication** | ✅ Complete (JWT via JWKS) |
| **Product Catalog** | ✅ Complete |
| **Order Processing** | ✅ Complete (Transactional) |
| **Multi-Vendor** | ✅ Complete |
| **Delivery & Riders** | ✅ Complete (offers, tracking, codes, payouts) |
| **Rider Onboarding** | ✅ Complete (application + review desk) |
| **Vendor Plans & Billing** | ✅ Complete (editable price list) |
| **Loyalty System** | ✅ Complete (Atomic) |
| **Product Warranty Fields** | ✅ Complete (listing metadata, no claim flow) |
| **Product Engagement** | ✅ Complete (views versus sales) |
| **Document Uploads** | ✅ Complete (MIME + size checked) |
| **Account Data Export** | ✅ Complete (JSON, self only) |
| **Coupon System** | ✅ Complete |
| **Notifications** | ✅ Complete |
| **Email Delivery** | ✅ Complete (SMTP) |
| **Scheduled Jobs** | ✅ Complete (Cron) |
| **Demo Admin** | ✅ Complete (Auto-restore) |
| **Rate Limiting** | ⏳ Planned |
| **Request Logging** | ⏳ Planned |
| **Real Payment Gateway** | 📋 Planned |

---

## 🤝 Contributing

Contributions welcome! Please follow the existing code structure.

### Contribution Guidelines

1. Fork repository
2. Create feature branch
3. Follow TypeScript best practices
4. Write Zod validators for new endpoints
5. Test thoroughly
6. Submit pull request

---

## 📄 License

MIT License - see [LICENSE](LICENSE)

---

## 🙏 Acknowledgments

**Built by:** [BD Soft](https://github.com/demoprojectbdsoft)

**Technologies:**
- [Express](https://expressjs.com/) - Web framework
- [MongoDB](https://www.mongodb.com/) - Database
- [Mongoose](https://mongoosejs.com/) - ODM
- [Zod](https://zod.dev/) - Validation
- [Nodemailer](https://nodemailer.com/) - Emails
- [Vercel](https://vercel.com/) - Hosting

---

## 📞 Support

- **Frontend Docs**: [Sparq README](https://github.com/demoprojectbdsoft/Sparq-Electronics-Store)
- **Issues**: [GitHub Issues](https://github.com/demoprojectbdsoft/Sparq-Server/issues)
- **Email**: dev@bdsoft.com

---

<div align="center">

**⚡ Sparq Backend — Powering modern e-commerce**

Made with ❤️ by [BD Soft](https://github.com/demoprojectbdsoft)

[⬆ Back to Top](#-sparq--backend-api)

</div>
