import { SiteSettings } from "./site-settings.model";
import { ENV } from "../../config/env";
import { DEFAULT_BRAND, MailBrand } from "../../utils/emailTemplates";

/**
 * Returns the singleton site settings document (creates defaults on first call).
 */
export const getSiteSettings = async () => {
  let settings = await SiteSettings.findOne().lean();
  if (!settings) {
    settings = (await SiteSettings.create({})).toObject();
  }
  return settings;
};

/** First non-empty value, so a blank field in the dashboard falls through. */
function firstAddress(...values: (string | undefined | null)[]): string {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Who the store is, for the emails the API sends: the name, the two inboxes the
 * order notifications and the contact page deliver to, and the look of the
 * message itself.
 *
 * The dashboard owns these values, so the owner can change them without a
 * redeploy. The environment variables only fill a gap when a field is empty.
 */
export async function getMailIdentity() {
  const settings: any = await getSiteSettings().catch(() => null);

  const supportInbox = firstAddress(settings?.supportEmail, process.env.STORE_INBOX);
  const contactInbox = firstAddress(
    settings?.contactEmail,
    process.env.CONTACT_INBOX,
    settings?.supportEmail,
    process.env.STORE_INBOX
  );
  const storeName = firstAddress(settings?.siteName, process.env.STORE_NAME, "Sparq");

  return {
    storeName,
    supportInbox,
    contactInbox,
    // The same palette and logo the shop draws itself with, so an email looks
    // like the site it came from.
    brand: buildBrand(settings, storeName, supportInbox),
  };
}

/**
 * Turns Site Settings into the handful of values an email needs.
 *
 * Every field falls back to `DEFAULT_BRAND`, so a half-filled settings record
 * still produces a finished-looking message instead of a broken one.
 */
function buildBrand(settings: any, storeName: string, supportInbox: string): MailBrand {
  const palette = settings?.colorPalette || {};
  const logo = settings?.navbarLogo || settings?.footerLogo || {};

  // The light logo is the one designed to sit on a white card.
  const logoUrl = firstAddress(logo.light, logo.dark);

  // A web font is not installed in a mail client, so the stack starts with the
  // chosen family and ends with fonts every device has.
  const font = firstAddress(settings?.typography?.primaryFont);

  return {
    storeName,
    logoUrl: logoUrl || undefined,
    primary: firstAddress(palette.primary, DEFAULT_BRAND.primary),
    primaryDark: firstAddress(palette.primaryDark, palette.primary, DEFAULT_BRAND.primaryDark),
    accent: firstAddress(palette.accent, DEFAULT_BRAND.accent),
    surface: firstAddress(palette.surface, DEFAULT_BRAND.surface),
    fontFamily: font
      ? `${font}, Helvetica, Arial, sans-serif`
      : DEFAULT_BRAND.fontFamily,
    supportEmail: supportInbox || undefined,
    supportPhone: firstAddress(settings?.supportPhone) || undefined,
    siteUrl: firstAddress(ENV.NEXT_PUBLIC_CLIENT_URL) || undefined,
  };
}

/**
 * Merges partial update into the singleton site settings document.
 */
export const updateSiteSettings = async (updates: Record<string, unknown>) => {
  const settings = await SiteSettings.findOneAndUpdate(
    {},
    { $set: updates },
    { new: true, upsert: true, runValidators: true }
  ).lean();
  return settings;
};
