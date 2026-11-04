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

// ── Brand Marquee Logo ───────────────────────────────────────────────────────
// The logos that scroll across the homepage. Each brand is one row, so the
// owner can add any number of them, with or without a link.
const brandLogoSchema = new Schema(
  {
    name: { type: String, default: "" },  // written as text when no logo is set
    logo: { type: String, default: "" },  // image URL
    href: { type: String, default: "" },  // blank means the logo is not a link
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

// ── About Page Content ───────────────────────────────────────────────────────
// Every line of text shown on /about is edited here, so the store owner never
// has to touch the code to change the story, the address note or the hours.
const aboutConfigSchema = new Schema(
  {
    headline: {
      type: String,
      default: "We Provide High Quality Products",
    },
    intro: { type: String, default: "" },
    headquartersNote: {
      type: String,
      default: "Official Storefront & Support Center",
    },
    openingHoursNote: {
      type: String,
      default: "Live helpline & in-store customer assistance",
    },
    ctaTitle: { type: String, default: "Ready to explore our latest arrivals?" },
    ctaDescription: {
      type: String,
      default:
        "Browse our wide selection of new arrivals, bestsellers, and everyday essentials today.",
    },
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
    // Line breaks are kept, so the owner can list one day per line.
    openingHours: { type: String, default: "Mon - Fri: 9:00 AM - 8:00 PM" },
    address: { type: String, default: "" },

    // ── About Page
    about: { type: aboutConfigSchema, default: () => ({}) },

    // ── SEO / Meta
    metaTitle: { type: String, default: "Sparq - Premium Online Store" },
    metaDescription: {
      type: String,
      default:
        "Sparq - Premium Worldwide Store with best deals, fast shipping, and top-quality products.",
    },

    // ── Top Bar
    topBarText: {
      type: String,
      default: "Welcome to our Worldwide Store • Free Express Shipping on $50+",
    },
    topBarEnabled: { type: Boolean, default: true },
    topBarItems: { type: [topBarItemSchema], default: [] },

    // ── Phone Navbar
    // Small screens carry one hamburger, and this says which panel it opens:
    // a drawer from the left edge, a drawer from the right edge, or the
    // full-screen panel that grows out of the middle. The menu inside is the
    // same either way, so the choice is about where it arrives, not what holds.
    mobileMenuPlacement: {
      type: String,
      enum: ["left", "right", "middle"],
      default: "middle",
    },

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

    // ── Homepage Brand Marquee
    brandLogos: { type: [brandLogoSchema], default: [] },

    // ── Misc
    currency: { type: String, default: "USD" },
    timezone: { type: String, default: "Asia/Dhaka" },
    maintenanceMode: { type: Boolean, default: false },
    footerCopyright: { type: String, default: "" },
  },
  { timestamps: true }
);

export const SiteSettings = model("SiteSettings", siteSettingsSchema);
