/**
 * A space is anonymous: a random 128-bit id in an HMAC-signed, HttpOnly cookie. No account, no password.
 *
 * Anonymous spaces expire after 7 days (their objects carry `space=anon`, and a tag-filtered rule deletes
 * them). "Keep my space" re-tags everything `space=kept` and shows a one-time recovery key; only an HMAC of
 * that key is stored, so the key itself exists nowhere but in the user's hands.
 * The calendar feed is addressed by `<uid>.<feed key>`; delete-all rotates the feed key, so an old
 * subscription URL answers 410.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "hearth_space";
export const ANON_DAYS = 7;

export interface SpaceDoc {
  version: 1;
  created: string;
  kept: boolean;
  feedKey: string;
  timeZone: string;
  judge?: boolean;
  consent?: {
    at: string;
    textVersion: string;
    deleteOriginals: boolean;
  };
  /** Per-space opt-in to send transcript text to Token Factory under its default retention (ZDR not on). */
  tfOptIn?: { at: string; textVersion: string } | null;
}

export function newId(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

function mac(secret: string, purpose: string, value: string): Buffer {
  return createHmac("sha256", secret).update(`${purpose}:${value}`).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signSpace(secret: string, uid: string): string {
  return `${uid}.${b64url(mac(secret, "space", uid)).slice(0, 32)}`;
}

/** The uid in a signed cookie value, or null when it is malformed or the signature does not match. */
export function verifySpace(secret: string, cookie: string | undefined | null): string | null {
  if (!cookie) return null;
  const [uid, sig] = cookie.split(".");
  if (!uid || !sig || !/^[a-f0-9]{32}$/.test(uid)) return null;
  const want = Buffer.from(b64url(mac(secret, "space", uid)).slice(0, 32));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? uid : null;
}

export function newSpace(timeZone: string, now = new Date()): SpaceDoc {
  return { version: 1, created: now.toISOString(), kept: false, feedKey: newId(16), timeZone: safeTimeZone(timeZone) };
}

export function safeTimeZone(tz: string | undefined | null): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** `<uid>.<feedKey>` -> the parts, or null. */
export function parseFeedKey(k: string | null): { uid: string; feedKey: string } | null {
  if (!k) return null;
  const m = /^([a-f0-9]{32})\.([a-f0-9]{32})$/.exec(k);
  return m ? { uid: m[1] as string, feedKey: m[2] as string } : null;
}

export function feedKeyMatches(doc: SpaceDoc, feedKey: string): boolean {
  const a = Buffer.from(doc.feedKey);
  const b = Buffer.from(feedKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A recovery key carries its uid (so it can be found without a lookup table) plus 128 random bits. */
export function newRecoveryKey(uid: string): string {
  return `${uid}-${newId(16)}`;
}

export function recoveryHash(secret: string, key: string): string {
  return mac(secret, "recovery", key.trim().toLowerCase()).toString("hex");
}

export function recoveryUid(key: string): string | null {
  const m = /^([a-f0-9]{32})-([a-f0-9]{32})$/.exec(key.trim().toLowerCase());
  return m ? (m[1] as string) : null;
}

export function hashesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Days left before an anonymous space expires (the lifecycle rule runs daily, so "within a day" after). */
export function daysLeft(doc: SpaceDoc, now = new Date()): number | null {
  if (doc.kept) return null;
  const age = (now.getTime() - new Date(doc.created).getTime()) / 86_400_000;
  return Math.max(0, Math.ceil(ANON_DAYS - age));
}
