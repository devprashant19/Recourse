import { describe, expect, it } from "vitest";

import { bidCommitment, newBidSalt } from "../src/index.js";

describe("bidCommitment", () => {
  it("matches the contract's vector (computed independently)", () => {
    // sha256((250).to_bytes(4,'big') + bytes([0x11]*32) + b'uw.near')
    expect(bidCommitment(250, "11".repeat(32), "uw.near")).toBe(
      "8ddf1aea65d0c185d361b3cd563565aa021179ae04343cb5c88503db554cd952",
    );
    expect(bidCommitment(250, "11".repeat(32), "uw2.near")).toBe(
      "7f2b382e7aaf6564c5f2aec5ccf3154bf6422a10d0d25f6bd0474e9ad2392530",
    );
  });

  it("rejects bad inputs instead of hashing something else", () => {
    expect(() => bidCommitment(1.5, "11".repeat(32), "uw.near")).toThrow(/u32/);
    expect(() => bidCommitment(-1, "11".repeat(32), "uw.near")).toThrow(/u32/);
    expect(() => bidCommitment(250, "11".repeat(31), "uw.near")).toThrow(/32 bytes/);
  });

  it("draws fresh 32-byte salts", () => {
    const a = newBidSalt();
    const b = newBidSalt();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
