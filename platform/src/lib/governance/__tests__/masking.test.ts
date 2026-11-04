import { describe, it, expect } from "vitest";
import { applyMask } from "../masking";

// SECURITY-CRITICAL: applyMask is the pure value-masking core used on query results.
// (The full maskRows() path also touches DynamoDB, so we unit-test the deterministic core
//  here; the end-to-end masking is covered by the Playwright suite.)
describe("applyMask", () => {
  it("passes through null/undefined/empty and strategy 'none'", () => {
    expect(applyMask(null, "full")).toBeNull();
    expect(applyMask(undefined, "full")).toBeUndefined();
    expect(applyMask("", "full")).toBe("");
    expect(applyMask("secret", "none")).toBe("secret");
  });

  it("full → fixed mask regardless of value", () => {
    expect(applyMask("anything", "full")).toBe("***");
    expect(applyMask(12345, "full")).toBe("***");
  });

  it("partial → keeps first & last char, stars the middle", () => {
    expect(applyMask("zhangsan", "partial")).toBe("z******n");
    // short values (<=2) are fully masked, never leaking a 1-2 char value
    expect(applyMask("ab", "partial")).toBe("***");
    expect(applyMask("a", "partial")).toBe("***");
  });

  it("email → first char + *** + domain", () => {
    expect(applyMask("alice@example.com", "email")).toBe("a***@example.com");
  });

  it("email without @ falls back to partial masking", () => {
    expect(applyMask("notanemail", "email")).toBe("n********l");
  });

  it("hash → stable sha256 prefix (deterministic, non-reversible)", () => {
    const a = applyMask("13800138000", "hash");
    const b = applyMask("13800138000", "hash");
    expect(a).toBe(b); // deterministic
    expect(String(a)).toMatch(/^sha256:[0-9a-f]{8}$/);
    // different inputs → different (overwhelmingly likely) hashes
    expect(applyMask("13800138001", "hash")).not.toBe(a);
  });

  it("numbers are coerced to string before masking", () => {
    expect(applyMask(98765, "partial")).toBe("9***5");
  });
});
