import { SiteSettings } from "./site-settings.model";

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
