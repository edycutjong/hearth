/**
 * Read a .hct file in the browser (or Node): the header written by worker/worker.py `pack_hct` and the codes,
 * unpacked from 11 bits each. The token strip on screen is drawn from these real codes, never decoration.
 *
 * Layout (little-endian): "HCT1", u8 version (2), u8 codebooks, u16 codebook size, u32 sample rate,
 * u16 samples per frame, u16 bits per code, u32 frames, u32 samples, u16 windows, u16 lead frames,
 * u16 context frames, i16 gain (centi-dB, applied before encoding; decoding divides it out), u32 x windows
 * (frames per window), 32-byte sha256 of the payload, payload.
 */

export interface HctHeader {
  version: number;
  codebooks: number;
  codebookSize: number;
  sampleRate: number;
  samplesPerFrame: number;
  bits: number;
  frames: number;
  samples: number;
  windows: number[];
  leadFrames: number;
  contextFrames: number;
  gainDb: number;
  headerBytes: number;
  payloadBytes: number;
}

const FIXED = 4 + 1 + 1 + 2 + 4 + 2 + 2 + 4 + 4 + 2 + 2 + 2 + 2;

export function readHctHeader(buf: ArrayBuffer): HctHeader {
  const v = new DataView(buf);
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  if (magic !== "HCT1") throw new Error("not a Hearth .hct file");
  let o = 4;
  const version = v.getUint8(o++);
  const codebooks = v.getUint8(o++);
  const codebookSize = v.getUint16(o, true); o += 2;
  const sampleRate = v.getUint32(o, true); o += 4;
  const samplesPerFrame = v.getUint16(o, true); o += 2;
  const bits = v.getUint16(o, true); o += 2;
  const frames = v.getUint32(o, true); o += 4;
  const samples = v.getUint32(o, true); o += 4;
  const nWin = v.getUint16(o, true); o += 2;
  const leadFrames = v.getUint16(o, true); o += 2;
  const contextFrames = v.getUint16(o, true); o += 2;
  const gainDb = v.getInt16(o, true) / 100; o += 2;
  if (version !== 2 || bits !== 11 || o !== FIXED) throw new Error("unsupported .hct version");
  const windows: number[] = [];
  for (let i = 0; i < nWin; i += 1) {
    windows.push(v.getUint32(o, true));
    o += 4;
  }
  const headerBytes = o + 32;
  return { version, codebooks, codebookSize, sampleRate, samplesPerFrame, bits, frames, samples, windows, leadFrames, contextFrames, gainDb, headerBytes, payloadBytes: buf.byteLength - headerBytes };
}

/** Codes as rows: result[codebook][frame]. Frame-major in the file, 11 bits each, little-endian bit order. */
export function readHctCodes(buf: ArrayBuffer): { header: HctHeader; codes: Uint16Array[] } {
  const header = readHctHeader(buf);
  const bytes = new Uint8Array(buf, header.headerBytes);
  const rows = Array.from({ length: header.codebooks }, () => new Uint16Array(header.frames));
  let bit = 0;
  for (let f = 0; f < header.frames; f += 1) {
    for (let c = 0; c < header.codebooks; c += 1) {
      let value = 0;
      for (let b = 0; b < 11; b += 1, bit += 1) {
        if ((bytes[bit >> 3] ?? 0) & (1 << (bit & 7))) value |= 1 << b;
      }
      (rows[c] as Uint16Array)[f] = value;
    }
  }
  return { header, codes: rows };
}

/** Seconds of the note's own audio (the lead-in excluded). */
export function hctSeconds(h: HctHeader): number {
  return h.samples / h.sampleRate;
}
