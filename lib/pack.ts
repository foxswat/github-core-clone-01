import { inflateSync } from 'node:zlib';
import { compressedObject, digest, hashObject, makeObject, type GitObject, type Objects } from './objects.ts';

export function writePack(repo: Objects, ids: Set<string>) {
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(ids.size, 8);
  const parts = [header];
  for (const sha of ids) {
    const object = repo.objects.get(sha)!;
    let remainingSize = object.data.length;
    const entryHeader = [(object.type << 4) | (remainingSize & 15)];
    remainingSize >>>= 4;
    while (remainingSize) {
      entryHeader[entryHeader.length - 1] |= 128;
      entryHeader.push(remainingSize & 127);
      remainingSize >>>= 7;
    }
    parts.push(Buffer.from(entryHeader), compressedObject(object));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, digest(body)]);
}

function expandDelta(base: Buffer, delta: Buffer) {
  let cursor = 0;
  const readByte = () => {
    if (cursor >= delta.length) throw new Error('Truncated delta');
    return delta[cursor++];
  };
  const readSize = () => {
    let value = 0;
    for (let factor = 1; factor <= 2 ** 28; factor *= 128) {
      const digit = readByte();
      value += (digit & 127) * factor;
      if (!(digit & 128)) return value;
    }
    throw new Error('Invalid delta size');
  };
  if (readSize() !== base.length) throw new Error('Wrong delta base size');
  const length = readSize();
  if (length > 64 * 1024 * 1024) throw new Error('Delta too large');
  const result = Buffer.allocUnsafe(length);
  let written = 0;
  while (cursor < delta.length) {
    const instruction = readByte();
    if (instruction & 128) {
      let start = 0;
      let copyLength = 0;
      for (let i = 0; i < 4; i++) if (instruction & (1 << i)) start += readByte() * 256 ** i;
      for (let i = 0; i < 3; i++) if (instruction & (16 << i)) copyLength += readByte() * 256 ** i;
      copyLength ||= 65536;
      if (start + copyLength > base.length || written + copyLength > length) throw new Error('Invalid delta copy');
      base.copy(result, written, start, start + copyLength);
      written += copyLength;
    } else {
      if (!instruction || cursor + instruction > delta.length || written + instruction > length) {
        throw new Error('Invalid delta insert');
      }
      delta.copy(result, written, cursor, cursor + instruction);
      written += instruction;
      cursor += instruction;
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
  const byId = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const unresolved: { start: number; base: string | number; data: Buffer }[] = [];
  let offset = 12;
  const readByte = () => {
    if (offset >= end) throw new Error('Truncated pack');
    return pack[offset++];
  };
  const remember = (start: number, object: GitObject) => {
    const sha = hashObject(object.type, object.data);
    byOffset.set(start, object);
    byId.set(sha, object);
  };
  const count = pack.readUInt32BE(8);
  for (let i = 0; i < count; i++) {
    const start = offset;
    let digit = readByte();
    const type = (digit >> 4) & 7;
    let size = digit & 15;
    for (let factor = 16; digit & 128; factor *= 128) {
      if (factor > 2 ** 28) throw new Error('Invalid object size');
      digit = readByte();
      size += (digit & 127) * factor;
    }
    let base: string | number | undefined;
    if (type === 6) {
      digit = readByte();
      let distance = digit & 127;
      while (digit & 128) {
        digit = readByte();
        distance = (distance + 1) * 128 + (digit & 127);
        if (distance > start) throw new Error('Invalid delta offset');
      }
      base = start - distance;
    } else if (type === 7) {
      base = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (type < 1 || type > 4) throw new Error('Invalid object type');
    if (size > 64 * 1024 * 1024) throw new Error('Object too large');
    const compressedStart = offset;
    // Size inflation from the entry header, retaining zlib's minimum chunk size.
    const { buffer: data, engine } = inflateSync(pack.subarray(offset, end), {
      info: true, maxOutputLength: Math.max(1, size),
      chunkSize: Math.max(64, Math.min(16 * 1024, size + 1)),
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    offset += engine.bytesWritten;
    if (data.length !== size) throw new Error('Wrong object size');
    if (base === undefined) remember(start, makeObject(type, data, pack.subarray(compressedStart, offset)));
    else unresolved.push({ start, base, data });
  }
  if (offset !== end) throw new Error('Unexpected pack data');
  // Keep pass order: resolving one entry can unlock a later entry in the same pass.
  while (unresolved.length) {
    const remaining = [];
    for (const item of unresolved) {
      const base = typeof item.base === 'number' ? byOffset.get(item.base) :
        byId.get(item.base) ?? repo.objects.get(item.base);
      if (base) remember(item.start, makeObject(base.type, expandDelta(base.data, item.data)));
      else remaining.push(item);
    }
    if (remaining.length === unresolved.length) throw new Error('Missing delta base');
    unresolved.splice(0, unresolved.length);
    for (const item of remaining) unresolved.push(item);
  }
  for (const [sha, object] of byId) if (!repo.objects.has(sha)) repo.objects.set(sha, object);
}
