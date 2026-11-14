import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, lstat, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class DiskStore {
  constructor(readonly root: string, readonly maxBytes: number) {}
  private async directory(workspaceId: string): Promise<string> {
    if (!UUID.test(workspaceId)) throw new Error("Invalid workspace storage ID");
    await mkdir(this.root, { recursive: true });
    const root = await realpath(this.root), dir = path.join(root, workspaceId);
    await mkdir(dir, { recursive: true });
    if ((await lstat(dir)).isSymbolicLink() || path.dirname(await realpath(dir)) !== root) throw new Error("Invalid storage directory");
    return dir;
  }
  async put(workspaceId: string, stream: Readable, candidateId: string = randomUUID()): Promise<{ key: string; bytes: number; sha256: string }> {
    if (!UUID.test(candidateId)) throw new Error("Invalid storage candidate ID");
    const dir = await this.directory(workspaceId), id = candidateId, temp = path.join(dir, `${id}.partial`), target = path.join(dir, id);
    let bytes = 0;
    const hash = createHash("sha256"), limit = this.maxBytes;
    const meter = new Transform({ transform(chunk: Buffer, _enc, callback) {
      bytes += chunk.length;
      if (bytes > limit) callback(new Error("Upload exceeds configured limit"));
      else { hash.update(chunk); callback(null, chunk); }
    } });
    try {
      await pipeline(stream, meter, createWriteStream(temp, { flags: "wx", mode: 0o600 }));
      if (!bytes) throw new Error("Empty media is not supported");
      await rename(temp, target);
      return { key: `${workspaceId}/${id}`, bytes, sha256: hash.digest("hex") };
    } catch (e) { await unlink(temp).catch(() => {}); throw e; }
  }
  async file(workspaceId: string, key: string): Promise<string> {
    const parts = key.split("/");
    if (parts.length !== 2 || parts[0] !== workspaceId || !UUID.test(parts[1])) throw new Error("Invalid asset storage key");
    const file = path.join(await this.directory(workspaceId), parts[1]);
    if ((await lstat(file)).isSymbolicLink()) throw new Error("Invalid asset storage file");
    return file;
  }
  async read(workspaceId: string, key: string) { return createReadStream(await this.file(workspaceId, key)); }
  async remove(workspaceId: string, key: string) { await unlink(await this.file(workspaceId, key)); }
  async discardCandidate(workspaceId: string, candidateId: string) {
    if (!UUID.test(candidateId)) throw new Error("Invalid storage candidate ID");
    const dir = await this.directory(workspaceId);
    for (const file of [path.join(dir, `${candidateId}.partial`), path.join(dir, candidateId)]) {
      try { await unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
