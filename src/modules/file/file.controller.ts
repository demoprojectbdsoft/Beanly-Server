import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import { ApiError } from "../../utils/apiError";
import * as fileService from "./file.service";
import { uploadFileSchema } from "./file.validator";
import {
  describeSizeLimit,
  isAllowedFileType,
  isInlineFileType,
  MAX_FILE_BYTES,
} from "./file.types";

/**
 * Stores one application document and answers with a link to it.
 *
 * The link carries the filename, because the browser needs the extension to
 * decide whether to show a PDF in its own reader or hand a Word file to the
 * download folder — and because a reviewer hovering a link should see
 * "licence.jpg", not a row of hex.
 */
export const uploadFile = catchAsync(async (req, res, next) => {
  const parsed = uploadFileSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues[0].message));
  }

  const { name, mime, data } = parsed.data;

  if (!isAllowedFileType(mime)) {
    return next(
      new ApiError(415, "That file type cannot be attached. Use a photo, a PDF or a Word document.")
    );
  }

  // Base64 inflates by a third, so the cap is checked on the real bytes rather
  // than on the length of the string that arrived.
  const buffer = Buffer.from(data, "base64");

  if (buffer.length === 0) {
    return next(new ApiError(400, "That file arrived empty. Try choosing it again."));
  }

  if (buffer.length > MAX_FILE_BYTES) {
    return next(new ApiError(413, `That file is larger than ${describeSizeLimit()}.`));
  }

  const stored = await fileService.storeFile({
    name: name || "document",
    mime,
    data: buffer,
    uploadedBy: parsed.data.uploadedBy ?? req.user?.id ?? "",
  });

  const origin = `${req.protocol}://${req.get("host")}`;
  const url = `${origin}/api/files/${stored.id}/${encodeURIComponent(stored.name)}`;

  return apiResponse(
    res,
    201,
    { id: stored.id, name: stored.name, mime, size: buffer.length, url },
    "File stored"
  );
});

/**
 * Serves one stored document.
 *
 * Open to anyone holding the link, on purpose: an image in a review screen and a
 * PDF in the browser's viewer are plain GETs that carry no token, and an admin
 * sharing a link with a colleague is a normal thing to do. The id is a random
 * object id, so the link is not guessable, and nothing else about the applicant
 * is exposed by it.
 */
export const getFile = catchAsync(async (req, res, next) => {
  // Express types a route parameter as string or string[]; the id is always one
  // segment, so anything else is a link that was never ours.
  const id = typeof req.params.id === "string" ? req.params.id : "";

  if (!/^[a-f\d]{24}$/i.test(id)) {
    return next(new ApiError(404, "That file is not here."));
  }

  const file = await fileService.findStoredFile(id);
  if (!file) {
    return next(new ApiError(404, "That file is not here."));
  }

  const inline = isInlineFileType(file.mime);

  res.setHeader("Content-Type", file.mime);
  res.setHeader("Content-Length", String(file.size));
  // The bytes never change under an id, so a browser may keep them.
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  // Never let the browser second-guess the declared type: a document is a
  // document, whatever is inside it.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`
  );

  return res.send(file.data);
});
