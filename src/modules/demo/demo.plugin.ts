import mongoose, { Schema } from "mongoose";
import { inDemoRequest } from "./demo.context";

// Only these collections are tracked (what the demo admin may change).
export const TRACKED = ["categories", "subcategories", "products", "slides", "productreviews"];
export const UNDO_COLLECTION = "demo_undo";

type UndoEntry = { _id: string; coll: string; docId: unknown; before: Record<string, unknown> | null; at: Date };
const undoLog = () => mongoose.connection.collection<UndoEntry>(UNDO_COLLECTION);

// Remember what a document looked like BEFORE the demo admin touched it
// (`before: null` = it didn't exist). The first write wins, so we always keep
// the original state, however many times it's edited afterwards.
async function remember(coll: string, docId: unknown, before: Record<string, unknown> | null) {
  await undoLog().updateOne(
    { _id: `${coll}:${String(docId)}` },
    { $setOnInsert: { coll, docId, before, at: new Date() } },
    { upsert: true }
  );
}

async function rememberMatches(model: any, filter: object, limit?: number) {
  const coll = model.collection.name;
  let cursor = model.collection.find(filter);
  if (limit) cursor = cursor.limit(limit);
  for (const doc of await cursor.toArray()) await remember(coll, doc._id, doc);
}

// Global plugin: must be registered BEFORE the models are created.
export function demoUndoPlugin(schema: Schema) {
  const single = ["findOneAndUpdate", "findOneAndDelete", "updateOne", "deleteOne"] as const;
  const many = ["updateMany", "deleteMany"] as const;

  for (const op of single) {
    schema.pre(op, async function (this: any) {
      if (!inDemoRequest() || !TRACKED.includes(this.model.collection.name)) return;
      await rememberMatches(this.model, this.getFilter(), 1);
    });
  }
  for (const op of many) {
    schema.pre(op, async function (this: any) {
      if (!inDemoRequest() || !TRACKED.includes(this.model.collection.name)) return;
      await rememberMatches(this.model, this.getFilter());
    });
  }

  schema.pre("save", async function (this: any) {
    const coll = this.constructor.collection.name;
    if (!inDemoRequest() || !TRACKED.includes(coll)) return;
    if (this.isNew) {
      await remember(coll, this._id, null);
    } else {
      const before = await this.constructor.collection.findOne({ _id: this._id });
      if (before) await remember(coll, this._id, before);
    }
  });
}

// Register for every schema. Import this file FIRST in app.ts, before any model loads.
mongoose.plugin(demoUndoPlugin);