import { describe, expect, it } from "vitest";

import { bytesEqual, fromHex, isSha256Hex, sha256Hex, toHex, utf8 } from "../src/bytes.js";

describe("byte helpers", () => {
  it("sha256 matches the FIPS 180-2 'abc' vector", () => {
    expect(sha256Hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hex round-trips and accepts a 0x prefix", () => {
    const b = new Uint8Array([0, 1, 254, 255]);
    expect(toHex(b)).toBe("0001feff");
    expect(fromHex("0x0001FEFF")).toEqual(b);
  });

  it("rejects malformed hex instead of guessing", () => {
    expect(() => fromHex("abc")).toThrow("invalid hex");
    expect(() => fromHex("zz")).toThrow("invalid hex");
  });

  it("utf8 keeps multi-byte characters exact", () => {
    expect(toHex(utf8("€"))).toBe("e282ac");
  });

  it("recognises only lowercase 64-char hex as a sha256", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("a".repeat(63))).toBe(false);
  });

  it("compares bytes exactly", () => {
    expect(bytesEqual(utf8("ab"), utf8("ab"))).toBe(true);
    expect(bytesEqual(utf8("ab"), utf8("ac"))).toBe(false);
    expect(bytesEqual(utf8("ab"), utf8("abc"))).toBe(false);
  });
});
