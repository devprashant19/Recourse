/**
 * Content-addressed artifact store on disk (Node only; separate entry point
 * `@recourse/receipts/file-store`). Files are named by their SHA-256, written
 * atomically, and re-hashed on every read, so a tampered file is never
 * served under a receipt's URI.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ARTIFACT_URI_PREFIX, artifactUri, checkArtifact } from "./completion.js";
import type { ArtifactStore } from "./types.js";

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(uri: string): string {
    if (!uri.startsWith(ARTIFACT_URI_PREFIX)) throw new Error(`not a content-addressed artifact uri: ${uri}`);
    const h = uri.slice(ARTIFACT_URI_PREFIX.length);
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`malformed artifact uri: ${uri}`);
    return join(this.dir, h);
  }

  async put(_name: string, bytes: Uint8Array): Promise<string> {
    const uri = artifactUri(bytes);
    const p = this.path(uri);
    if (!existsSync(p)) {
      writeFileSync(`${p}.tmp`, bytes);
      renameSync(`${p}.tmp`, p);
    }
    return uri;
  }

  async get(uri: string): Promise<Uint8Array> {
    const p = this.path(uri);
    if (!existsSync(p)) throw new Error(`artifact not found: ${uri}`);
    const b = new Uint8Array(readFileSync(p));
    checkArtifact(uri, b);
    return b;
  }
}
