/**
 * The deletion fence. Delete-all writes the space's tombstone before it cancels or deletes anything; from then on
 * no reconcile, dispatch or memory pass may write into the space, and a Job that slips through is cancelled.
 * (Imports only keys and a type, so every module can use it without an import cycle.)
 */

import { keys } from "./keys";
import type { Store } from "./store";

export async function isDeleting(store: Store, uid: string): Promise<boolean> {
  return (await store.head(keys.reap(uid))).status === 200;
}
