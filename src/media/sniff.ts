export interface SniffResult { kind: "audio" | "image" | "video" | "pdf" | "unknown"; mime: string }

const ascii = (b: Uint8Array, start: number, len: number) =>
  new TextDecoder("ascii").decode(b.slice(start, start + len));

/**
 * What tracks does an MP4-family file actually carry? Every track declares its
 * type in an `hdlr` box: `vide` for video, `soun` for audio. The handler type
 * sits 12 bytes after the "hdlr" tag (version/flags then pre_defined), so a
 * linear scan for the tag is enough — no box-tree parsing, works whether moov
 * is at the front (faststart) or the end. A stray "hdlr" in compressed media
 * data is ~once per 4GB, and even then the +12 bytes must spell an exact
 * handler type, so false positives are not a real risk.
 */
function mp4Tracks(b: Uint8Array): { video: boolean; audio: boolean } {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  let video = false;
  let audio = false;
  for (let i = buf.indexOf("hdlr"); i !== -1; i = buf.indexOf("hdlr", i + 4)) {
    const handler = ascii(b, i + 12, 4);
    if (handler === "vide") video = true;
    else if (handler === "soun") audio = true;
  }
  return { video, audio };
}

export function sniff(b: Uint8Array): SniffResult {
  if (b.length >= 4) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
    if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return { kind: "image", mime: "image/png" };
    if (ascii(b, 0, 3) === "GIF") return { kind: "image", mime: "image/gif" };
    if (ascii(b, 0, 4) === "RIFF" && b.length >= 12) {
      const fmt = ascii(b, 8, 4);
      if (fmt === "WEBP") return { kind: "image", mime: "image/webp" };
      if (fmt === "WAVE") return { kind: "audio", mime: "audio/wav" };
    }
    if (ascii(b, 0, 4) === "OggS") return { kind: "audio", mime: "audio/ogg" };
    if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))
      return { kind: "audio", mime: "audio/mpeg" };
    if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
      // An ftyp container is any MP4-family file — voice memo OR camera video —
      // and the wrapper lies in both directions. Calling them all audio sent a
      // camera video to Gemini as a voice note; calling every non-M4A brand a
      // video misread Instagram VOICE NOTES, which arrive in a generic-brand
      // MP4 video container (GHL even renders them with a play button). The
      // track list is the truth: a file with no video track is audio no matter
      // what the container claims.
      const brand = ascii(b, 8, 4);
      if (brand === "M4A " || brand === "M4B " || brand === "M4P ")
        return { kind: "audio", mime: "audio/mp4" };
      const tracks = mp4Tracks(b);
      if (!tracks.video && tracks.audio) return { kind: "audio", mime: "audio/mp4" };
      // A video track present — or no readable hdlr at all (truncated moov):
      // fall back to the brand. Audio-only content mislabeled video still gets
      // its soundtrack transcribed; the reverse loses the visuals entirely.
      if (brand.startsWith("3g")) return { kind: "video", mime: "video/3gpp" };
      if (brand.startsWith("qt")) return { kind: "video", mime: "video/quicktime" };
      return { kind: "video", mime: "video/mp4" };
    }
    if (ascii(b, 0, 5) === "#!AMR") return { kind: "audio", mime: "audio/amr" };
    if (ascii(b, 0, 4) === "%PDF") return { kind: "pdf", mime: "application/pdf" };
  }
  return { kind: "unknown", mime: "application/octet-stream" };
}
