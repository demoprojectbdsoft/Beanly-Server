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
  const file = await StoredFileModel.findById(id).lean();
  return (file as unknown as StoredFile) ?? null;
};
