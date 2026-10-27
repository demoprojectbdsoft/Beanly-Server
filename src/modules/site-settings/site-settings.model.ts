import { Schema, model } from "mongoose";

// ── Color Palette Token ───────────────────────────────────────────────────────
const colorPaletteSchema = new Schema(
  {
    primary: { type: String, default: "#0284c7" },       // sky-600
    primaryDark: { type: String, default: "#0369a1" },   // sky-700
    secondary: { type: String, default: "#6366f1" },     // indigo-500
    accent: { type: String, default: "#f59e0b" },        // amber-500
    background: { type: String, default: "#ffffff" },
    backgroundDark: { type: String, default: "#0b0f19" },
    surface: { type: String, default: "#f8fafc" },
    surfaceDark: { type: String, default: "#131d2e" },
    topBarFrom: { type: String, default: "#1d4ed8" },    // blue-700
    topBarVia: { type: String, default: "#0284c7" },     // sky-600
    topBarTo: { type: String, default: "#4338ca" },      // indigo-700
  },
  { _id: false }
);

// ── Logo Set ─────────────────────────────────────────────────────────────────
const logoSetSchema = new Schema(
  {
    light: { type: String, default: "" }, // URL for light theme
    dark: { type: String, default: "" },  // URL for dark theme
  },
  { _id: false }
);

// ── Social Link ───────────────────────────────────────────────────────────────
const socialLinkSchema = new Schema(
  {
    platform: { type: String },
    url: { type: String, default: "#" },
  },
  { _id: false }
);

// ── Top Bar Item ──────────────────────────────────────────────────────────────
const topBarItemSchema = new Schema(
  {
    label: { type: String },
    href: { type: String, default: "#" },
  },
  { _id: false }
);

// ── Shipping & Delivery Config ────────────────────────────────────────────────
const shippingConfigSchema = new Schema(
  {
    freeShippingEnabled: { type: Boolean, default: true },
    freeShippingThreshold: { type: Number, default: 50 },
    standardDeliveryFee: { type: Number, default: 15 },
    expressDeliveryFee: { type: Number, default: 25 },
    estimatedDeliveryDays: { type: String, default: "2-4 business days" },
  },
  { _id: false }
);

// ── Typography & Google Fonts Config ─────────────────────────────────────────
const typographySchema = new Schema(
  {
    primaryFont: { type: String, default: "Open Sans" },
    headingFont: { type: String, default: "Poppins" },
    baseFontSize: { type: String, default: "16px" },
  },
  { _id: false }
);

// ── Main Site Settings Schema ─────────────────────────────────────────────────
const siteSettingsSchema = new Schema(
  {
    // ── Identity
    siteName: { type: String, default: "Sparq" },
    siteTagline: { type: String, default: "Better products. A brighter you." },
    storeType: { type: String, default: "electronics" }, // e.g. electronics, coffee, clothing
    supportEmail: { type: String, default: "support@sparq.com" },
    contactEmail: { type: String, default: "contact@sparq.com" },
    supportPhone: { type: String, default: "(800) 8001-8588" },
    openingHours: { type: String, default: "Mon - Fri: 9:00 AM - 8:00 PM" },
    address: { type: String, default: "" },

    // ── SEO / Meta
    metaTitle: { type: String, default: "Sparq - Premium Electronics Store" },
    metaDescription: {
      type: String,
      default:
        "Sparq - Premium Worldwide Electronics Store with best deals, fast shipping, and top-tier tech products.",
    },

    // ── Top Bar
    topBarText: {
      type: String,
      default: "Welcome to Worldwide Electronics Store • Free Express Shipping on $50+",
    },
    topBarEnabled: { type: Boolean, default: true },
    topBarItems: { type: [topBarItemSchema], default: [] },

    // ── Logo
    logoType: {
      type: String,
      enum: ["both", "img", "text"],
      default: "both",
    },
    navbarLogo: { type: logoSetSchema, default: () => ({}) },
    footerLogo: { type: logoSetSchema, default: () => ({}) },
    faviconUrl: { type: String, default: "" },

    // ── Color Palette
    colorPalette: { type: colorPaletteSchema, default: () => ({}) },

    // ── Typography (Google Fonts)
    typography: { type: typographySchema, default: () => ({}) },

    // ── Shipping & Delivery
    shipping: { type: shippingConfigSchema, default: () => ({}) },

    // ── Social Media
    socialLinks: { type: [socialLinkSchema], default: [] },

    // ── Misc
    currency: { type: String, default: "USD" },
    timezone: { type: String, default: "Asia/Dhaka" },
    maintenanceMode: { type: Boolean, default: false },
    footerCopyright: { type: String, default: "" },
  },
  { timestamps: true }
);

export const SiteSettings = model("SiteSettings", siteSettingsSchema);
