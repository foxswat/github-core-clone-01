import { createApp } from './app.ts';

// Publish the kernel-assigned port, then keep serving until the environment finishes.
const environmentOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (environmentOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const requestTimeoutMs = 30_000;

const initialDelayMs = 250;
const maximumDelayMs = 2_000;

function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(maximumDelayMs, initialDelayMs * 2 ** Math.min(attempt, 8));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${environmentOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await waitBeforeRetry(attempt);
  }
}

async function pollCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${environmentOrigin}/done`, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Only an affirmative response ends polling; failures leave the trial running.
    }
    await waitBeforeRetry(attempt);
  }
}

async function runEntry(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await announcePort(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await pollCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await runEntry();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
