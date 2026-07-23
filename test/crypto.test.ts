import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto";

const key = Buffer.alloc(32, 7);

describe("crypto", () => {
  it("round-trips a secret", () => {
    const enc = encryptSecret("sk-test-123", key);
    expect(enc).not.toContain("sk-test-123");
    expect(decryptSecret(enc, key)).toBe("sk-test-123");
  });
  it("produces distinct ciphertexts per call (fresh IV)", () => {
    expect(encryptSecret("a", key)).not.toBe(encryptSecret("a", key));
  });
  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("secret", key);
    const parts = enc.split(":");
    parts[2] = Buffer.from("tampered!").toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();
  });
});
