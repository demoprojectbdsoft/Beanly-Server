import { Schema, model, type Types } from "mongoose";

/**
 * One uploaded file, held in the store's own database.
 *
 * Documents had been going to a free image host, which works for a photograph
 * of a licence and not at all for a PDF, a scanned certificate or a Word file —
 * the reviewer got a broken thumbnail and the applicant got no way forward. So
 * the bytes are kept here instead: an application's papers now live wherever
 * the application lives, and the review screen can open them without a third
 * party being up.
 *
 * The binary sits in the document itself. These are things like a driving
 * licence photographed in a kitchen — a few hundred kilobytes — and keeping the
 * bytes beside the row means one read, no second service to configure, and no
 * credentials to lose. Anything larger belongs in object storage, and the size
 * cap in `file.types` makes sure it cannot quietly become that.
 */
const storedFileSchema = new Schema(
  {
    /** The name the applicant's file had, kept so a reviewer can recognise it. */
    name: { type: String, required: true, trim: true },
    mime: { type: String, required: true, trim: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },
    /** The account that sent it, for an audit trail. */
    uploadedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

export interface StoredFile {
  _id: Types.ObjectId;
  name: string;
  mime: string;
  size: number;
  data: Buffer;
  uploadedBy?: string;
  createdAt?: Date;
}

export const StoredFileModel = model<StoredFile>("StoredFile", storedFileSchema);
