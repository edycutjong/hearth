/**
 * Every sentence Hearth says about consent, processors and retention lives here, versioned, so the version the
 * user agreed to is stored with their consent. Hindi lines await a native reviewer's pass (stated in the UI).
 *
 * Token Factory retention follows its legal guide: by default, inputs and outputs may be kept for Speculative
 * Decoding, stored in Finland, never used for training. The Zero Data Retention wording appears ONLY when the
 * TF_ZDR_CONFIRMED flag is set (the organisation toggle plus support's written confirmation).
 */

export const CONSENT_VERSION = "v1-2026-10-15";

export const CONSENT = {
  en: "Everyone whose voice is in these notes has agreed to you saving them here.",
  hi: "इन वॉइस नोट्स में जिस-जिस की आवाज़ है, उन सभी ने इन्हें यहाँ रखने की सहमति दी है।",
};

/** A one-tap message the user can send to ask first. Hearth never sends anything itself. */
export const ASK_FIRST_HI =
  "माँ, मैं आपके वॉइस नोट्स एक ऐप (Hearth) में रखना चाहता हूँ, ताकि आपकी आवाज़ और आपकी कही ज़रूरी बातें मुझसे छूटें नहीं। क्या आप इसके लिए हाँ कहेंगी?";

export function tfRetentionSentence(zdrConfirmed: boolean): string {
  return zdrConfirmed
    ? "Token Factory runs with Zero Data Retention for our organisation: nothing is kept beyond processing. We send it transcript text only."
    : "Token Factory may keep prompts and outputs for Speculative Decoding (stored in Finland, never used for training); we send it transcript text only.";
}

export function processorsParagraph(zdrConfirmed: boolean): string[] {
  return [
    "Your audio is processed on Nebius AI Cloud compute in the eu-west1 region, by two NVIDIA open models: the ASR (nemotron-3.5-asr-streaming-0.6b) and NanoCodec.",
    `Transcript text — never audio — goes to Nebius Token Factory, where Nemotron 3 Super proposes reminders. ${tfRetentionSentence(zdrConfirmed)}`,
    "Requests pass through our Vercel functions in an EU region; we do not store or log what they carry.",
    "A temporary decoded copy of each note (about 159 MB per hour of voice) is kept for playback and deleted within 48 hours. What stays is the codec tokens and the transcript.",
    "Your original upload is deleted 24 hours after a verified round trip (or when you tap “Delete original now”), unless you turn that off.",
    "If you subscribe to the calendar feed, your calendar provider fetches neutral titles and dates only — no names, amounts, quotes or health words.",
    "Anonymous spaces are deleted after 7 days unless you tap “Keep my space”.",
  ];
}

export const TF_OPTIN = {
  title: "Turn on reminders for this space?",
  body: (zdrConfirmed: boolean) =>
    `Reminders need Nemotron 3 Super on Nebius Token Factory to read your transcripts (text only, never audio). ${tfRetentionSentence(zdrConfirmed)} You can delete everything at any time.`,
};

export const FLEURS_LABEL = "FLEURS read speech, not a family note";
export const FLEURS_ATTRIBUTION = "Google FLEURS (hi_in test split), CC BY 4.0";
export const KEPT_LABEL = "Kept — NanoCodec's reconstruction of the recording";
export const GATE_LIMIT =
  "The gates prove these words are in the transcript. They do not prove the speech recogniser heard them right — so every coupon says “as transcribed” and plays its source.";
