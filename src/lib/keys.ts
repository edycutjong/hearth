/**
 * Object key layout — one place, so no two writers drift apart.
 *
 * Top-level prefixes follow the DATA CLASS, because expiration rules match by prefix:
 *   raw/<uid>/…       uploads; deleted by the app after a verified round trip (rule: 7 days, a backstop only)
 *   cache/<uid>/…     Job-decoded playback copies (rule: 1 day), never counted as "stored"
 *   u/<uid>/…         the space: tokens, transcripts, meta, memory, job reports (rule: tag space=anon, 7 days)
 *   sample/…          the judge sample: permanent, read-only, no rule
 *   sys/…             queue entries and the uid-free daily counters and spend meter
 */

export const keys = {
  raw: (uid: string, note: string, ext: string) => `raw/${uid}/${note}.${ext}`,
  original: (uid: string, note: string, ext: string) => `u/${uid}/originals/${note}.${ext}`,
  cacheWav: (uid: string, note: string) => `cache/${uid}/${note}.wav`,
  hct: (uid: string, note: string) => `u/${uid}/notes/${note}.hct`,
  transcript: (uid: string, note: string) => `u/${uid}/notes/${note}.transcript.json`,
  meta: (uid: string, note: string) => `u/${uid}/notes/${note}.meta.json`,
  notesPrefix: (uid: string) => `u/${uid}/notes/`,
  space: (uid: string) => `u/${uid}/space.json`,
  memory: (uid: string) => `u/${uid}/memory.json`,
  recovery: (uid: string) => `u/${uid}/recovery.json`,
  spaceCaps: (uid: string) => `u/${uid}/caps.json`,
  job: (uid: string, job: string) => `u/${uid}/jobs/${job}.json`,
  jobManifest: (uid: string, job: string) => `u/${uid}/jobs/${job}.manifest.json`,
  jobResult: (uid: string, job: string) => `u/${uid}/jobs/${job}.result.json`,
  jobStatus: (uid: string, job: string) => `u/${uid}/jobs/${job}.status.json`,
  noteResult: (uid: string, job: string, note: string) => `u/${uid}/jobs/${job}/${note}.result.json`,
  jobsPrefix: (uid: string) => `u/${uid}/jobs/`,
  queueEntry: (stamp: string, uid: string) => `sys/queue/${stamp}-${uid}.json`,
  queuePrefix: () => "sys/queue/",
  claim: (entry: string) => `sys/claims/${entry}.json`,
  active: (job: string) => `sys/active/${job}.json`,
  activePrefix: () => "sys/active/",
  dailyCaps: (day: string) => `sys/caps/${day}.json`,
  spend: () => "sys/caps/spend.json",
  sample: (rest: string) => `sample/${rest}`,
  spacePrefixes: (uid: string) => [`raw/${uid}/`, `cache/${uid}/`, `u/${uid}/`],
} as const;

/** The tag every object of a space carries; Keep my space re-tags anon -> kept. */
export function spaceTag(kept: boolean): string {
  return kept ? "space=kept" : "space=anon";
}

const ID = /^[a-f0-9]{8,64}$/;
export function isId(v: unknown): v is string {
  return typeof v === "string" && ID.test(v);
}

export const AUDIO_EXTS = ["opus", "ogg", "m4a", "mp3", "wav", "aac", "amr", "flac", "webm", "mp4"] as const;
export type AudioExt = (typeof AUDIO_EXTS)[number];
export function audioExt(name: string): AudioExt | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (AUDIO_EXTS as readonly string[]).includes(ext) ? (ext as AudioExt) : null;
}
