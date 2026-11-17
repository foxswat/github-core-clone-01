import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { advertise, receive, upload } from './lib/git.ts';
import { graphql } from './lib/graphql.ts';
import { mcp, rpcError } from './lib/mcp.ts';
import { rest } from './lib/rest.ts';
import { HttpError, Store, fail, type Input } from './lib/store.ts';

function sendJson(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (data: Buffer) => {
      size += data.length;
      if (size <= 64 * 1024 * 1024) chunks.push(data);
      else reject(new HttpError(413, 'Request too large'));
    });
    req.on('error', reject);
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
  });
}

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  let requestId = 0;
  return createServer(async (req, res) => {
    res.sendDate = false;
    try {
      const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      res.setHeader('x-github-request-id', 'req-' + ++requestId);
      const validToken = !!token && req.headers.authorization === 'Bearer ' + token;
      const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (git) {
        const [, owner, name, action] = git;
        if (!validToken) fail(401, 'Bad credentials');
        const repo = store.repo(decodeURIComponent(owner), decodeURIComponent(name));
        const advert = method === 'GET' && action === 'info/refs';
        const service = advert ? url.searchParams.get('service') : action;
        if ((!advert && method !== 'POST') || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) fail();
        const v2 = service === 'git-upload-pack' && !!req.headers['git-protocol']?.toString().includes('version=2');
        let answer: Buffer;
        try {
          answer = advert ? advertise(repo, service, v2) :
            service === 'git-upload-pack' ? upload(repo, await readBody(req), v2) : receive(repo, await readBody(req));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          return sendJson(res, 400, { message: 'Invalid Git request' });
        }
        res.writeHead(200, { 'content-type': 'application/x-' + service + (advert ? '-advertisement' : '-result'),
          'content-length': answer.length, 'cache-control': 'no-cache' });
        res.end(answer);
        return;
      }
      if (path === '/api' || path.startsWith('/api/') || path === '/mcp') {
        if (!validToken) fail(401, 'Bad credentials');
        let body: Input = {};
        if (method !== 'GET' && method !== 'HEAD') {
          const raw = await readBody(req);
          try {
            body = raw.length || path === '/mcp' ? JSON.parse(raw.toString()) : {};
          } catch {
            return sendJson(res, 400, path === '/mcp' ? rpcError(null, -32700, 'Parse error') : { message: 'Malformed JSON' });
          }
          if (body === null || typeof body !== 'object') fail(400, 'Expected a JSON object');
        }
        if (path === '/mcp' && method === 'POST') return sendJson(res, ...mcp(store, body));
        if (path === '/api/graphql' && method === 'POST') return sendJson(res, 200, graphql(store, body));
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const parts = path.slice(8).replace(/\/$/, '').split('/').filter(Boolean).map(decodeURIComponent);
          return sendJson(res, ...rest(store, method, parts, url, body));
        }
      }
      fail();
    } catch (error) {
      if (error instanceof HttpError) sendJson(res, error.status, { message: error.message });
      else if (error instanceof URIError) sendJson(res, 400, { message: 'Invalid path' });
      else sendJson(res, 500, { message: 'Internal server error' });
    }
  });
}
