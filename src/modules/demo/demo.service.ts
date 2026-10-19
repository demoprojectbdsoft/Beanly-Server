import mongoose from "mongoose";
import { UNDO_COLLECTION } from "./demo.plugin";

// Undo everything the demo admin did: delete what they added, put back what
// they edited or deleted. Real admin changes are never in the log, so they stay.
// Safe to run twice — the log is cleared as it is applied.
export async function restoreDemoChanges() {
  const log = mongoose.connection.collection(UNDO_COLLECTION);
  const entries = await log.find().toArray();

  const counts = { removed: 0, restored: 0 };
  if (!entries || entries.length === 0) {
    return { restoredAt: new Date(), ...counts };
  }

  const toObjectId = (id: any) => {
    if (id instanceof mongoose.Types.ObjectId) return id;
    if (typeof id === "string" && mongoose.Types.ObjectId.isValid(id)) {
      return new mongoose.Types.ObjectId(id);
    }
    return id;
  };

  // 1) delete what the demo admin created (first, so unique slugs can't clash)
  for (const entry of entries.filter((e) => e.before === null)) {
    const rawId = entry.docId;
    const objectId = toObjectId(rawId);
    await mongoose.connection
      .collection(entry.coll)
      .deleteOne({ _id: { $in: [rawId, objectId] } });
    counts.removed++;
  }

  // 2) put back what the demo admin edited or deleted
  for (const entry of entries.filter((e) => e.before !== null)) {
    const rawId = entry.docId;
    const objectId = toObjectId(rawId);
    const targetId = entry.before._id ? toObjectId(entry.before._id) : objectId;

    await mongoose.connection
      .collection(entry.coll)
      .replaceOne({ _id: targetId }, entry.before, { upsert: true });
    counts.restored++;
  }

  await log.deleteMany({ _id: { $in: entries.map((e) => e._id) } });
  return { restoredAt: new Date(), ...counts };
}