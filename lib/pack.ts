import { inflateSync } from 'node:zlib';
import { compressedObject, digest, hashObject, makeObject, type GitObject, type Objects } from './objects.ts';

export function writePack(repo: Objects, ids: Set<string>) {
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(ids.size, 8);
  const chunks = [header];
  for (const sha of ids) {
    const object = repo.objects.get(sha)!;
    let size = object.data.length;
    const bytes = [(object.type << 4) | (size & 15)];
    size >>>= 4;
    while (size) {
      bytes[bytes.length - 1] |= 128;
      bytes.push(size & 127);
      size >>>= 7;
    }
    chunks.push(Buffer.from(bytes), compressedObject(object));
  }
  const raw = Buffer.concat(chunks);
  return Buffer.concat([raw, digest(raw)]);
}

function applyDelta(base: Buffer, delta: Buffer) {
  let offset = 0;
  const byte = () => {
    if (offset >= delta.length) throw new Error('Truncated delta');
    return delta[offset++];
  };
  const size = () => {
    let value = 0;
    for (let factor = 1; factor <= 2 ** 28; factor *= 128) {
      const digit = byte();
      value += (digit & 127) * factor;
      if (!(digit & 128)) return value;
    }
    throw new Error('Invalid delta size');
  };
  if (size() !== base.length) throw new Error('Wrong delta base size');
  const length = size();
  if (length > 64 * 1024 * 1024) throw new Error('Delta too large');
  const result = Buffer.allocUnsafe(length);
  let written = 0;
  while (offset < delta.length) {
    const code = byte();
    if (code & 128) {
      let start = 0;
      let count = 0;
      for (let i = 0; i < 4; i++) if (code & (1 << i)) start += byte() * 256 ** i;
      for (let i = 0; i < 3; i++) if (code & (16 << i)) count += byte() * 256 ** i;
      count ||= 65536;
      if (start + count > base.length || written + count > length) throw new Error('Invalid delta copy');
      base.copy(result, written, start, start + count);
      written += count;
    } else {
      if (!code || offset + code > delta.length || written + code > length) throw new Error('Invalid delta insert');
      delta.copy(result, written, offset, offset + code);
      written += code;
      offset += code;
    }
  }
  if (written !== length) throw new Error('Wrong delta result size');
  return result;
}

export function readPack(repo: Objects, pack: Buffer) {
  const end = pack.length - 20;
  if (end < 12 || pack.toString('ascii', 0, 4) !== 'PACK' ||
      pack.readUInt32BE(4) !== 2 || !digest(pack.subarray(0, end)).equals(pack.subarray(end))) {
    throw new Error('Invalid pack');
  }
  const objects = new Map<string, GitObject>();
  const offsets = new Map<number, GitObject>();
  const pending: { start: number; base: string | number; data: Buffer }[] = [];
  let offset = 12;
  const byte = () => {
    if (offset >= end) throw new Error('Truncated pack');
    return pack[offset++];
  };
  const save = (start: number, object: GitObject) => {
    const sha = hashObject(object.type, object.data);
    offsets.set(start, object);
    objects.set(sha, object);
  };
  const count = pack.readUInt32BE(8);
  for (let i = 0; i < count; i++) {
    const start = offset;
    let digit = byte();
    const type = (digit >> 4) & 7;
    let size = digit & 15;
    for (let factor = 16; digit & 128; factor *= 128) {
      if (factor > 2 ** 28) throw new Error('Invalid object size');
      digit = byte();
      size += (digit & 127) * factor;
    }
    let base: string | number | undefined;
    if (type === 6) {
      digit = byte();
      let distance = digit & 127;
      while (digit & 128) {
        digit = byte();
        distance = (distance + 1) * 128 + (digit & 127);
        if (distance > start) throw new Error('Invalid delta offset');
      }
      base = start - distance;
    } else if (type === 7) {
      base = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (type < 1 || type > 4) throw new Error('Invalid object type');
    if (size > 64 * 1024 * 1024) throw new Error('Object too large');
    const packedAt = offset;
    const { buffer: data, engine } = inflateSync(pack.subarray(offset, end), {
      info: true, maxOutputLength: Math.max(1, size),
      chunkSize: Math.max(64, Math.min(16 * 1024, size + 1)),
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    offset += engine.bytesWritten;
    if (data.length !== size) throw new Error('Wrong object size');
    if (base === undefined) save(start, makeObject(type, data, pack.subarray(packedAt, offset)));
    else pending.push({ start, base, data });
  }
  if (offset !== end) throw new Error('Unexpected pack data');
  while (pending.length) {
    const remaining = [];
    for (const item of pending) {
      const base = typeof item.base === 'number' ? offsets.get(item.base) :
        objects.get(item.base) ?? repo.objects.get(item.base);
      if (base) save(item.start, makeObject(base.type, applyDelta(base.data, item.data)));
      else remaining.push(item);
    }
    if (remaining.length === pending.length) throw new Error('Missing delta base');
    pending.splice(0, pending.length);
    for (const item of remaining) pending.push(item);
  }
  for (const [sha, object] of objects) if (!repo.objects.has(sha)) repo.objects.set(sha, object);
}
