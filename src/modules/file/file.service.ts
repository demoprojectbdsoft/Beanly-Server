import { StoredFileModel, type StoredFile } from "./file.model";

/**
 * Trims a name to something safe in a URL and in a download header.
 *
 * The name is the applicant's, so it can hold anything: a Windows path, a slash
 * that would split the route, a quote that would break the `Content-Disposition`
 * header, or two hundred characters of a scanner's default title. Keeping the
 * extension matters — that is what the browser uses to decide how to open it.
 */
function safeName(input: string): string {
  const base = input.split(/[\\/]/).pop() || "document";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 120) || "document";
}

export interface StoreFileInput {
  name: string;
  mime: string;
  data: Buffer;
  uploadedBy?: string;
}

/** Keeps one uploaded file and returns its id and the name it was stored under. */
export const storeFile = async ({ name, mime, data, uploadedBy }: StoreFileInput) => {
  const stored = await StoredFileModel.create({
    name: safeName(name),
    mime,
    size: data.length,
    data,
    uploadedBy: uploadedBy ?? "",
  });

  return { id: String(stored._id), name: stored.name };
};

/** One file, or null when it was never stored or has since been removed. */
export const findStoredFile = async (id: string): Promise<StoredFile | null> => {
  /*
   * Read through the hydrated document rather than `.lean()`.
   *
   * A lean read hands back the driver's binary wrapper instead of a node Buffer,
   * and that wrapper serialises to base64 text the moment it reaches the
   * response writer — a PDF that arrives as a page of letters. Mongoose turns a
   * Buffer path back into a real Buffer on hydration, so the few fields that are
   * needed are read off the document explicitly.
   */
  const file = await StoredFileModel.findById(id);
  if (!file) return null;

  const data = file.get("data") as Buffer;

  return {
    _id: file._id,
    name: String(file.get("name")),
    mime: String(file.get("mime")),
    size: data.length,
    data,
  };
};
