import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveGwsPath } from "../../packages/orbit-plugin/lib/gws-path.js";

describe("resolveGwsPath", () => {
  const origPath = process.env.PATH;
  beforeEach(() => {
    process.env.PATH = "";
  });
  afterEach(() => {
    process.env.PATH = origPath;
  });

  it("returns a known absolute path when PATH is empty and a candidate exists", () => {
    const found = resolveGwsPath({
      existsSync: (p) => p === "/usr/local/bin/gws",
      which: () => null,
    });
    expect(found).toBe("/usr/local/bin/gws");
  });

  it("returns null when no candidate exists and PATH is empty", () => {
    const found = resolveGwsPath({ existsSync: () => false, which: () => null });
    expect(found).toBeNull();
  });

  it("falls back to the which-stub when no fixed candidate hits", () => {
    const found = resolveGwsPath({
      existsSync: () => false,
      which: () => "/opt/custom/gws",
    });
    expect(found).toBe("/opt/custom/gws");
  });
});
