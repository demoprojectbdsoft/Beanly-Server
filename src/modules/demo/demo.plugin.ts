import mongoose, { Schema } from "mongoose";
import { inDemoRequest } from "./demo.context";

// Only these collections are tracked (what the demo admin may change).
export const TRACKED = [
  "categories",
  "subcategories",
  "products",
  "slides",
  "productreviews",
  "orders",
  "orderstatuslogs",
  "sitesettings",
];
export const UNDO_COLLECTION = "demo_undo";

type UndoEntry = {
  _id: string;
  coll: string;
  docId: unknown;
  before: Record<string, unknown> | null;
  at: Date;
  atLocal: string;
  timezone: string;
};
const undoLog = () => mongoose.connection.collection<UndoEntry>(UNDO_COLLECTION);

// Helper to get current Date shifted to UTC+6 so BSON Date in MongoDB matches local time
function getUtc6Date(): Date {
  return new Date(Date.now() + 6 * 60 * 60 * 1000);
}

// Formatted ISO string with +06:00 offset: YYYY-MM-DDTHH:mm:ss.sss+06:00
function getUtc6String(): string {
  const d = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return d.toISOString().replace("Z", "+06:00");
}

// Remember what a document looked like BEFORE the demo admin touched it
// (`before: null` = it didn't exist). The first write wins, so we always keep
// the original state, however many times it's edited afterwards.
async function remember(coll: string, docId: unknown, before: Record<string, unknown> | null) {
  const at = getUtc6Date();
  const atLocal = getUtc6String();
  await undoLog().updateOne(
    { _id: `${coll}:${String(docId)}` },
    { $setOnInsert: { coll, docId, before, at, atLocal, timezone: "UTC+6" } },
    { upsert: true }
  );
}

async function rememberMatches(model: any, filter: object, limit?: number) {
  const coll = model.collection?.name;
  if (!coll || !TRACKED.includes(coll)) return;
  try {
    let query = model.find(filter).lean();
    if (limit) query = query.limit(limit);
    const docs = await query.exec();
    for (const doc of docs) {
      if (doc && doc._id) {
        await remember(coll, doc._id, doc);
      }
    }
  } catch (err) {
    console.error(`[demoUndoPlugin] Failed to remember matches for ${coll}:`, err);
  }
}

// Global plugin: must be registered BEFORE the models are created.
export function demoUndoPlugin(schema: Schema) {
  const single = ["findOneAndUpdate", "findOneAndDelete", "updateOne", "deleteOne"] as const;
  const many = ["updateMany", "deleteMany"] as const;

  for (const op of single) {
    schema.pre(op, async function (this: any) {
      if (!inDemoRequest() || !TRACKED.includes(this.model?.collection?.name)) return;
      await rememberMatches(this.model, this.getFilter(), 1);
    });
  }
  for (const op of many) {
    schema.pre(op, async function (this: any) {
      if (!inDemoRequest() || !TRACKED.includes(this.model?.collection?.name)) return;
      await rememberMatches(this.model, this.getFilter());
    });
  }

  schema.pre("save", async function (this: any) {
    const coll = this.constructor?.collection?.name;
    if (!inDemoRequest() || !TRACKED.includes(coll)) return;
    try {
      if (this.isNew) {
        await remember(coll, this._id, null);
      } else {
        const before = await this.constructor.findById(this._id).lean();
        if (before) await remember(coll, this._id, before);
      }
    } catch (err) {
      console.error(`[demoUndoPlugin] Failed to remember save for ${coll}:`, err);
    }
  });

  schema.post("insertMany", async function (docs: any) {
    if (!inDemoRequest()) return;
    try {
      const list = Array.isArray(docs) ? docs : [docs];
      for (const doc of list) {
        const coll = doc?.constructor?.collection?.name;
        if (coll && TRACKED.includes(coll)) {
          await remember(coll, doc._id, null);
        }
      }
    } catch (err) {
      console.error(`[demoUndoPlugin] Failed to remember insertMany:`, err);
    }
  });
}

// Register for every schema. Import this file FIRST in app.ts, before any model loads.
mongoose.plugin(demoUndoPlugin);