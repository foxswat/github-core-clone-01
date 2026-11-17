import { zero, type Objects } from './objects.ts';
import { readPack, writePack } from './pack.ts';

const flush = Buffer.from('0000');
const delimiter = Buffer.from('0001');
const receiveCapabilities = 'report-status side-band-64k delete-refs ofs-delta object-format=sha1';

function packet(payload: string | Buffer) {
  const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
  const prefix = (bytes + 4).toString(16).padStart(4, '0');
  const framed = Buffer.allocUnsafe(prefix.length + bytes);
  framed.write(prefix, 'ascii');
  if (typeof payload === 'string') framed.write(payload, prefix.length);
  else payload.copy(framed, prefix.length);
  return framed;
}

function sideband(payload: Buffer) {
  const frames: Buffer[] = [];
  for (let start = 0; start < payload.length; start += 65515) {
    const part = payload.subarray(start, start + 65515);
    frames.push(packet(Buffer.concat([Buffer.from([1]), part])));
  }
  frames.push(flush);
  return frames;
}

function readLines(data: Buffer, stopAtFlush: boolean) {
  const lines: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const prefix = data.toString('ascii', offset, offset + 4);
    if (!/^[\da-f]{4}$/.test(prefix)) throw new Error('Invalid packet');
    const length = parseInt(prefix, 16);
    if (length <= 2) {
      offset += 4;
      if (length === 0 && stopAtFlush) break;
      continue;
    }
    if (length < 4 || offset + length > data.length) throw new Error('Truncated packet');
    lines.push(data.toString('utf8', offset + 4, offset + length).replace(/\n$/, ''));
    offset += length;
  }
  return { lines, offset };
}

function sortedRefs(repo: Objects) {
  return [...repo.refs.keys()].sort();
}

const uploadAdvertisement = Buffer.concat([
  ...['version 2', 'agent=makefun-forge', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1']
    .map(feature => packet(feature + '\n')),
  flush,
]);

export function advertise(repo: Objects, service: string, v2: boolean) {
  if (v2) return uploadAdvertisement;
  const upload = service === 'git-upload-pack';
  const capabilities = upload ? 'side-band-64k shallow ofs-delta symref=HEAD:' + repo.head : receiveCapabilities;
  const refs = sortedRefs(repo).map(name => [name, repo.refs.get(name)!]);
  if (upload && repo.refs.has(repo.head)) refs.unshift(['HEAD', repo.refs.get(repo.head)!]);
  if (!upload && !refs.length) refs.push(['capabilities^{}', zero]);
  const packets = [packet('# service=' + service + '\n'), flush];
  for (const [index, [name, sha]] of refs.entries()) {
    const suffix = index === 0 ? '\0' + capabilities : '';
    packets.push(packet(sha + ' ' + name + suffix + '\n'));
    const peeled = upload ? repo.peel(sha) : sha;
    if (peeled !== sha) packets.push(packet(peeled + ' ' + name + '^{}\n'));
  }
  return Buffer.concat([...packets, flush]);
}

function lsRefs(repo: Objects, lines: string[]) {
  const prefixes = lines.filter(line => line.startsWith('ref-prefix ')).map(line => line.slice(11));
  const packets = [];
  for (const name of ['HEAD', ...sortedRefs(repo)]) {
    if (prefixes.length && !prefixes.some(prefix => name.startsWith(prefix))) continue;
    const sha = repo.refs.get(name === 'HEAD' ? repo.head : name);
    const fields: string[] = [];
    if (name === 'HEAD' && (lines.includes('symrefs') || !sha)) fields.push('symref-target:' + repo.head);
    if (!sha && !lines.includes('unborn')) continue;
    if (sha && lines.includes('peel')) {
      const peeled = repo.peel(sha);
      if (peeled !== sha) fields.push('peeled:' + peeled);
    }
    packets.push(packet([sha ?? 'unborn', name, ...fields].join(' ') + '\n'));
  }
  return Buffer.concat([...packets, flush]);
}

function history(repo: Objects, tips: string[], depth: number, stops: Set<string>) {
  const seen = new Set<string>();
  const boundary = new Set<string>();
  const pending = tips.map(sha => ({ sha, level: 1 }));
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const { sha, level } = pending[cursor];
    if (seen.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (!object) continue;
    seen.add(sha);
    if (object.type === 4) pending.push({ sha: repo.peel(sha), level });
    const commit = repo.readCommit(sha);
    if (!commit || stops.has(sha)) continue;
    if (level >= depth) {
      if (commit.parents.length) boundary.add(sha);
    } else {
      for (const parent of commit.parents) pending.push({ sha: parent, level: level + 1 });
    }
  }
  return { seen, boundary };
}

function reachable(repo: Objects, commits: Set<string>, excluded = new Set<string>()) {
  const collected = new Set<string>();
  const pending = [...commits];
  while (pending.length) {
    const sha = pending.pop()!;
    if (collected.has(sha) || excluded.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (!object) continue;
    collected.add(sha);
    const commit = repo.readCommit(sha);
    if (commit) pending.push(commit.tree);
    if (object.type === 2) {
      for (const entry of repo.entries(sha)) {
        if (entry.mode !== '160000') pending.push(entry.sha);
      }
    }
  }
  return collected;
}

// An added object may supply an edge that was absent during an earlier fetch.
// Refs do not change ID-based fetch results; advertisements read them directly.
const lastFetch = new WeakMap<Objects, {
  objectCount: number; request: Buffer; response: Buffer; v2: boolean;
}>();

export function upload(repo: Objects, data: Buffer, v2: boolean) {
  const cached = lastFetch.get(repo);
  if (cached?.objectCount === repo.objects.size && cached.v2 === v2 && cached.request.equals(data)) {
    return cached.response;
  }
  const { lines } = readLines(data, false);
  if (lines.includes('command=ls-refs')) return lsRefs(repo, lines);
  if (v2 && !lines.includes('command=fetch')) throw new Error('Unknown upload command');
  const args = (prefix: string) => lines.filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length).split(' ')[0]);
  const wants = args('want ');
  if (wants.some(sha => !repo.objects.has(sha))) return packet('ERR not our ref\n');
  const haves = args('have ').filter(sha => repo.objects.has(sha));
  const shallow = new Set(args('shallow '));
  const depth = Number(args('deepen ')[0]) || Infinity;
  const known = reachable(repo, history(repo, haves, Infinity, shallow).seen);
  const wanted = history(repo, wants, depth, Number.isFinite(depth) ? new Set() : shallow);
  const boundaries = [...wanted.boundary].filter(sha => !shallow.has(sha)).map(sha => packet('shallow ' + sha + '\n'));
  if (Number.isFinite(depth)) {
    for (const sha of shallow) {
      if (wanted.seen.has(sha) && !wanted.boundary.has(sha)) boundaries.push(packet('unshallow ' + sha + '\n'));
    }
  }
  const response: Buffer[] = [];
  if (v2 && !lines.includes('done')) {
    response.push(packet('acknowledgments\n'));
    response.push(...(haves.length ? haves.map(sha => packet('ACK ' + sha + '\n')) : [packet('NAK\n')]));
    if (!haves.length) return Buffer.concat([...response, flush]);
    response.push(packet('ready\n'), delimiter);
  }
  if (v2) {
    if (boundaries.length || Number.isFinite(depth)) response.push(packet('shallow-info\n'), ...boundaries, delimiter);
    response.push(packet('packfile\n'));
  } else {
    if (Number.isFinite(depth)) response.push(...boundaries, flush);
    if (!lines.includes('done') && !haves.length) {
      return Buffer.concat(response.length ? response : [packet('NAK\n')]);
    }
    response.push(packet(haves.length ? 'ACK ' + haves[0] + '\n' : 'NAK\n'));
  }
  const pack = writePack(repo, reachable(repo, wanted.seen, known));
  const packFrames = v2 || /side-band-64k/.test(lines[0] ?? '') ? sideband(pack) : [pack];
  const result = Buffer.concat([...response, ...packFrames]);
  if (data.length <= 64 * 1024 && result.length <= 1024 * 1024) {
    lastFetch.set(repo, { objectCount: repo.objects.size, request: Buffer.from(data), response: result, v2 });
  }
  return result;
}

export function receive(repo: Objects, data: Buffer) {
  const { lines, offset } = readLines(data, true);
  const capabilities = (lines[0]?.split('\0')[1] ?? '').split(' ');
  const commands = lines.map(line => line.split('\0')[0].split(' '));
  let unpackError = '';
  try {
    if (offset < data.length) readPack(repo, data.subarray(offset));
  } catch {
    unpackError = 'invalid pack';
  }
  const report = [packet('unpack ' + (unpackError || 'ok') + '\n')];
  for (const [old, next, ref] of commands) {
    let reason = unpackError;
    const objectIdPattern = /^[0-9a-f]{40}$/;
    if (!reason && (!objectIdPattern.test(old) || !objectIdPattern.test(next) || !/^refs\/(heads|tags)\/[^\s\x00-\x1f~^:?*\[\\]+$/.test(ref ?? '') ||
        ref.includes('..') || ref.includes('@{') || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')))) {
      reason = 'invalid ref';
    }
    if (!reason && next !== zero && !repo.objects.has(next)) reason = 'missing object';
    if (!reason && next !== zero && ref.startsWith('refs/heads/') && repo.objects.get(next)?.type !== 1) reason = 'not a commit';
    if (!reason && (repo.refs.get(ref) ?? zero) !== old) reason = 'stale ref';
    if (!reason && old !== zero && next !== zero && !repo.fastForward(old, next)) reason = 'non-fast-forward';
    if (!reason) {
      if (next === zero) repo.refs.delete(ref);
      else repo.refs.set(ref, next);
    }
    report.push(packet(reason ? 'ng ' + ref + ' ' + reason + '\n' : 'ok ' + ref + '\n'));
  }
  const inner = Buffer.concat([...report, flush]);
  return capabilities.includes('side-band-64k') ? Buffer.concat(sideband(inner)) : inner;
}
