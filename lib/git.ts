import { zero, type Objects } from './objects.ts';
import { readPack, writePack } from './pack.ts';

const flush = Buffer.from('0000');
const delimiter = Buffer.from('0001');
const receiveCapabilities = 'report-status side-band-64k delete-refs ofs-delta object-format=sha1';
function packet(data: string | Buffer) {
  const body = typeof data === 'string' ? Buffer.from(data) : data;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}
function sideband(data: Buffer) {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += 65515) {
    chunks.push(packet(Buffer.concat([Buffer.from([1]), data.subarray(i, i + 65515)])));
  }
  chunks.push(flush);
  return chunks;
}
function readLines(data: Buffer, stopAtFlush: boolean) {
  let offset = 0;
  const lines: string[] = [];
  while (offset < data.length) {
    const header = data.toString('ascii', offset, offset + 4);
    if (!/^[\da-f]{4}$/.test(header)) throw new Error('Invalid packet');
    const size = parseInt(header, 16);
    if (size <= 2) {
      offset += 4;
      if (!size && stopAtFlush) break;
    } else {
      if (size < 4 || offset + size > data.length) throw new Error('Truncated packet');
      lines.push(data.toString('utf8', offset + 4, offset + size).replace(/\n$/, ''));
      offset += size;
    }
  }
  return { lines, offset };
}
const sortedRefs = (repo: Objects) => [...repo.refs.keys()].sort();
export function advertise(repo: Objects, service: string, v2: boolean) {
  if (v2) return Buffer.concat([
    ...['version 2', 'agent=makefun-forge', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1']
      .map(line => packet(line + '\n')), flush,
  ]);
  const upload = service === 'git-upload-pack';
  const capabilities = upload ? 'side-band-64k shallow ofs-delta symref=HEAD:' + repo.head : receiveCapabilities;
  const refs = sortedRefs(repo).map(name => [name, repo.refs.get(name)!]);
  if (upload && repo.refs.has(repo.head)) refs.unshift(['HEAD', repo.refs.get(repo.head)!]);
  if (!upload && !refs.length) refs.push(['capabilities^{}', zero]);
  const packets = [packet('# service=' + service + '\n'), flush];
  for (const [i, [name, sha]] of refs.entries()) {
    packets.push(packet(sha + ' ' + name + (i ? '' : '\0' + capabilities) + '\n'));
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
    const attributes: string[] = [];
    if (name === 'HEAD' && (lines.includes('symrefs') || !sha)) attributes.push('symref-target:' + repo.head);
    if (!sha && !lines.includes('unborn')) continue;
    if (sha && lines.includes('peel')) {
      const peeled = repo.peel(sha);
      if (peeled !== sha) attributes.push('peeled:' + peeled);
    }
    packets.push(packet([sha ?? 'unborn', name, ...attributes].join(' ') + '\n'));
  }
  return Buffer.concat([...packets, flush]);
}

function history(repo: Objects, tips: string[], depth: number, stops: Set<string>) {
  const seen = new Set<string>();
  const boundary = new Set<string>();
  const queue = tips.map(sha => ({ sha, level: 1 }));
  for (let i = 0; i < queue.length; i++) {
    const { sha, level } = queue[i];
    if (seen.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (!object) continue;
    seen.add(sha);
    if (object.type === 4) queue.push({ sha: repo.peel(sha), level });
    const commit = repo.readCommit(sha);
    if (!commit || stops.has(sha)) continue;
    if (level >= depth) {
      if (commit.parents.length) boundary.add(sha);
    } else {
      for (const parent of commit.parents) queue.push({ sha: parent, level: level + 1 });
    }
  }
  return { seen, boundary };
}

function reachable(repo: Objects, commits: Set<string>, excluded = new Set<string>()) {
  const ids = new Set<string>();
  const queue = [...commits];
  while (queue.length) {
    const sha = queue.pop()!;
    if (ids.has(sha) || excluded.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (!object) continue;
    ids.add(sha);
    const commit = repo.readCommit(sha);
    if (commit) queue.push(commit.tree);
    if (object.type === 2) {
      for (const entry of repo.entries(sha)) if (entry.mode !== '160000') queue.push(entry.sha);
    }
  }
  return ids;
}

export function upload(repo: Objects, data: Buffer, v2: boolean) {
  const { lines } = readLines(data, false);
  if (lines.includes('command=ls-refs')) return lsRefs(repo, lines);
  if (v2 && !lines.includes('command=fetch')) throw new Error('Unknown upload command');
  const args = (prefix: string) => lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).split(' ')[0]);
  const wants = args('want ');
  if (wants.some(sha => !repo.objects.has(sha))) return packet('ERR not our ref\n');
  const haves = args('have ').filter(sha => repo.objects.has(sha));
  const shallow = new Set(args('shallow '));
  const depth = Number(args('deepen ')[0]) || Infinity;
  const known = reachable(repo, history(repo, haves, Infinity, shallow).seen);
  const wanted = history(repo, wants, depth, Number.isFinite(depth) ? new Set() : shallow);
  const boundaries = [...wanted.boundary].filter(sha => !shallow.has(sha)).map(sha => packet('shallow ' + sha + '\n'));
  if (Number.isFinite(depth)) for (const sha of shallow) {
    if (wanted.seen.has(sha) && !wanted.boundary.has(sha)) boundaries.push(packet('unshallow ' + sha + '\n'));
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
  return Buffer.concat([...response, ...(v2 || /side-band-64k/.test(lines[0] ?? '') ? sideband(pack) : [pack])]);
}

export function receive(repo: Objects, data: Buffer) {
  const { lines, offset } = readLines(data, true);
  const capabilities = (lines[0]?.split('\0')[1] ?? '').split(' ');
  const updates = lines.map(line => line.split('\0')[0].split(' '));
  let error = '';
  try {
    if (offset < data.length) readPack(repo, data.subarray(offset));
  } catch {
    error = 'invalid pack';
  }
  const report = [packet('unpack ' + (error || 'ok') + '\n')];
  for (const [old, next, ref] of updates) {
    let reason = error;
    const valid = /^[0-9a-f]{40}$/;
    if (!reason && (!valid.test(old) || !valid.test(next) || !/^refs\/(heads|tags)\/[^\s\x00-\x1f~^:?*\[\\]+$/.test(ref ?? '') ||
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
