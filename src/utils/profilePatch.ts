/**
 * Merging one section of a form into a document.
 *
 * The profile screens — the rider's and the vendor's — show every field the
 * application wizard once collected, including the ones nobody ever filled. A
 * Save from one of those forms therefore carries a handful of sections, each
 * with a handful of keys, and the rules that matter are the ones a form forces:
 *
 * - A key the caller never sent is not touched. Fixing a licence number must
 *   not blank the emergency contact on the same document.
 * - A key whose value already matches is not an edit. Comparing `15` from an
 *   input box with `15` in the file as "different" would rewrite the row, stamp
 *   `updatedAt` and add a history line for nothing that happened.
 *
 * Both sides of those rules live here rather than in either module, because the
 * rider file and the vendor file are read by their own services and have to
 * answer a Save the same way.
 */

/**
 * Whether a field really moved.
 *
 * Dates compare as instants, lists compare item by item in order, and anything
 * else compares as text — which is what lets `"15"`, `15` and an untouched
 * empty string all read as the same answer.
 */
export function sameValue(before: unknown, after: unknown): boolean {
  if (before instanceof Date && after instanceof Date) return before.getTime() === after.getTime();
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.length === after.length && before.every((item, index) => item === after[index]);
  }
  if (before === after) return true;
  if (before === null || before === undefined) return after === "" || after === null;
  return String(before) === String(after);
}

/**
 * Writes one section of a patch into a hydrated document.
 *
 * Returns whether anything was set, so the caller can decide whether the save
 * deserves a history line. `undefined` values are skipped — "this field was not
 * part of the form" — while `null` and `""` are written, because those are the
 * picker and the text box saying the person cleared the field.
 */
export function applySection(
  doc: any,
  section: string,
  patch?: Record<string, unknown>
): boolean {
  if (!patch) return false;
  const current: Record<string, any> = doc.get(section) || {};
  let changed = false;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (sameValue(current[key], value)) continue;
    doc.set(`${section}.${key}`, value);
    changed = true;
  }

  return changed;
}
