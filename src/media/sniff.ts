export interface SniffResult { kind: "audio" | "image" | "video" | "pdf" | "unknown"; mime: string }

const ascii = (b: Uint8Array, start: number, len: number) =>
  new TextDecoder("ascii").decode(b.slice(start, start + len));

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
      // An ftyp container is any MP4-family file — voice memo OR camera video.
      // Calling them all audio sent a live tester's video to Gemini as a voice
      // note: at best it transcribed the soundtrack, and the assistant asked
      // the contact what was in their own video. The major brand separates
      // them: M4A/M4B/M4P are the audio-only brands; everything else (isom,
      // mp42, avc1, qt, 3gp…) can carry video, and mislabeling audio-only
      // content as video is harmless — the model still hears the track.
      const brand = ascii(b, 8, 4);
      if (brand === "M4A " || brand === "M4B " || brand === "M4P ")
        return { kind: "audio", mime: "audio/mp4" };
      if (brand.startsWith("3g")) return { kind: "video", mime: "video/3gpp" };
      if (brand.startsWith("qt")) return { kind: "video", mime: "video/quicktime" };
      return { kind: "video", mime: "video/mp4" };
    }
    if (ascii(b, 0, 5) === "#!AMR") return { kind: "audio", mime: "audio/amr" };
    if (ascii(b, 0, 4) === "%PDF") return { kind: "pdf", mime: "application/pdf" };
  }
  return { kind: "unknown", mime: "application/octet-stream" };
}
