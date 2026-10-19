import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import * as siteSettingsService from "./site-settings.service";

export const getSiteSettings = catchAsync(async (_req, res) => {
  const settings = await siteSettingsService.getSiteSettings();
  apiResponse(res, 200, settings);
});

export const updateSiteSettings = catchAsync(async (req, res) => {
  const settings = await siteSettingsService.updateSiteSettings(req.body);
  apiResponse(res, 200, settings, "Site settings updated");
});
