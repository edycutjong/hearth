/**
 * A WhatsApp "export chat" zip, parsed IN THE BROWSER. Only three things per voice note ever leave the device:
 * the audio file, its date, and a sender LABEL the user picks once per chat (Maa, Me, …) — never the raw
 * contact name, and never the chat's text. `uploadsFor` builds exactly that, and a test asserts it.
 *
 * Android exports name voice notes `PTT-YYYYMMDD-WA0003.opus` and write lines like
 *   "12/10/26, 8:14 pm - Maa: PTT-20261012-WA0003.opus (file attached)"
 * iOS exports name them `00000012-AUDIO-2026-10-12-20-14-07.opus` and write
 *   "[12/10/26, 8:14:07 PM] Maa: <attached: 00000012-AUDIO-2026-10-12-20-14-07.opus>"
 */

import { anchorFromFilename } from "./dates";
import { audioExt } from "./keys";

export interface ChatAudio {
  name: string;
  anchor: string | null;
  sender: string | null;
  size: number;
}

const ANDROID = /^.+? - (.+?): (?:‎)?(\S+\.(?:opus|ogg|m4a|mp3|aac|amr|wav)) \(file attached\)/i;
const IOS = /^‎?\[[^\]]+\] (.+?): .*<attached: (\S+\.(?:opus|ogg|m4a|mp3|aac|amr|wav))>/i;

/** attachment file name -> sender name, from the chat text (which itself never leaves the browser). */
export function sendersFromChat(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^‎/, "");
    const m = ANDROID.exec(line) ?? IOS.exec(line);
    if (m && m[1] && m[2]) out.set(m[2].trim(), m[1].trim());
  }
  return out;
}

export function audiosFromEntries(entries: Array<{ name: string; size: number }>, senders: Map<string, string>): ChatAudio[] {
  return entries
    .filter((e) => audioExt(e.name) !== null)
    .map((e) => {
      const base = e.name.split("/").pop() ?? e.name;
      return { name: base, anchor: anchorFromFilename(base), sender: senders.get(base) ?? null, size: e.size };
    })
    .sort((a, b) => (a.anchor ?? "").localeCompare(b.anchor ?? "") || a.name.localeCompare(b.name));
}

export interface UploadSpec {
  name: string;
  size: number;
  anchor: string | null;
  anchorSource: "filename" | "chat" | "upload";
  label: string;
}

/** What is sent to the server for each note. Nothing else: no sender name, no chat text. */
export function uploadsFor(audios: ChatAudio[], labelFor: (sender: string | null) => string): UploadSpec[] {
  return audios.map((a) => ({
    name: a.name,
    size: a.size,
    anchor: a.anchor,
    anchorSource: a.anchor ? "filename" : "upload",
    label: labelFor(a.sender).slice(0, 40),
  }));
}

/** Read a zip in the browser with JSZip; returns the audio blobs and the sender map. */
export async function readChatZip(file: Blob): Promise<{ audios: Array<ChatAudio & { blob: Blob }>; senders: string[] }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(file);
  const files = Object.values(zip.files).filter((f) => !f.dir);
  const chat = files.find((f) => /\.txt$/i.test(f.name));
  const senders = chat ? sendersFromChat(await chat.async("string")) : new Map<string, string>();
  const blobs = new Map<string, Blob>();
  const entries: Array<{ name: string; size: number }> = [];
  for (const f of files) {
    if (audioExt(f.name) === null) continue;
    const blob = await f.async("blob");
    const base = f.name.split("/").pop() ?? f.name;
    blobs.set(base, blob);
    entries.push({ name: base, size: blob.size });
  }
  const audios = audiosFromEntries(entries, senders).map((a) => ({ ...a, blob: blobs.get(a.name) as Blob }));
  return { audios, senders: [...new Set(audios.map((a) => a.sender).filter((s): s is string => !!s))] };
}
