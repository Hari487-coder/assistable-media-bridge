import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("config", () => {
  it("loads with defaults in mock mode", () => {
    process.env.MOCK_MODE = "1";
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    const c = loadConfig();
    expect(c.mock).toBe(true);
    expect(c.v3BaseUrl).toBe("https://api.assistable.ai");
    expect(c.encryptionKey.length).toBe(32);
  });
  it("normalizes the known-bad portal host to the API host", () => {
    // Blueprint instances deployed before de0e9f0 have app.assistable.ai
    // (the portal, no /v3 routes) frozen into their env — heal them in code.
    process.env.MOCK_MODE = "1";
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    process.env.V3_BASE_URL = "https://app.assistable.ai/";
    const c = loadConfig();
    expect(c.v3BaseUrl).toBe("https://api.assistable.ai");
  });
  it("throws on missing encryption key outside mock mode", () => {
    process.env.MOCK_MODE = "0";
    delete process.env.ENCRYPTION_KEY;
    expect(() => loadConfig()).toThrow(/ENCRYPTION_KEY/);
  });
});
