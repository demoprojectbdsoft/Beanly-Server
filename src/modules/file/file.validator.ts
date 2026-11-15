import { z } from "zod";

/**
 * An upload arrives as JSON with the bytes base64-encoded.
 *
 * A multipart parser would mean another dependency and another way for a request
 * to be half-read; base64 costs a third more bytes and works through the same
 * `express.json` pipeline as everything else. At the eight megabyte cap that is
 * a shape the server already knows how to reject cleanly.
 */
export const uploadFileSchema = z.object({
  name: z.string().trim().max(160).optional(),
  mime: z.string().trim().min(1, "A file type is required."),
  data: z.string().min(1, "A file is required."),
  /** Filled in by the storefront, which is the side holding the session. */
  uploadedBy: z.string().trim().max(64).optional(),
});
