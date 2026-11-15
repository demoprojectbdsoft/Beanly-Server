/**
 * What an application may attach, and how much of it.
 *
 * The list is deliberately short and explicit rather than "anything that is not
 * a video". These files are read by a human on a review desk, and every type
 * that can run script in a browser — HTML, SVG — is a way to attack the
 * reviewer rather than to prove who you are. A photograph and a PDF cover every
 * document a rider or a shop has ever needed.
 */

/** Eight megabytes: a phone photo of a licence, or a scanned multi-page PDF. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The types accepted on upload.
 *
 * HEIC is here because that is what an iPhone produces by default, and refusing
 * it means refusing the photograph most applicants actually have. Word documents
 * are here for a trade licence issued as one; they download rather than preview,
 * which is honest about what a browser can show.
 */
export const ALLOWED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export type AllowedFileType = (typeof ALLOWED_FILE_TYPES)[number];

export const isAllowedFileType = (mime: string): mime is AllowedFileType =>
  (ALLOWED_FILE_TYPES as readonly string[]).includes(mime);

/** The file kinds a browser can render itself, without downloading it first. */
export const isInlineFileType = (mime: string) =>
  mime.startsWith("image/") || mime === "application/pdf";

/** A human label for the size, used in error messages. */
export const describeSizeLimit = () => `${MAX_FILE_BYTES / (1024 * 1024)} MB`;
