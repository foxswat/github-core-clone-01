# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/foxswat/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/foxswat/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process: git smart HTTP, REST v3, GraphQL and MCP, all over one in-memory store. Entry for [make.fun bounty github-core-clone-01](https://make.fun/bounty/github-core-clone-01) — "Build a GitHub-compatible git forge".

## Run it

```sh
node main.ts
```

No dependencies to install (Node stdlib only). The server binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, serves until the env reports done, then exits 0.

## Surfaces

- Git smart HTTP `/{owner}/{repo}.git` — clone/fetch/push, upload-pack v2 and receive-pack v0, pure pkt-line/pack implementation (no git binary), OFS/REF deltas, fast-forward enforcement, shallow `deepen 1`
- REST v3 `/api/v3` — repos, issues, pull requests, contents, labels (Bearer `MAKEFUN_SHOP_TOKEN`, `X-GitHub-Request-Id` on every reply)
- GraphQL `/api/graphql` — Repository/Issue/PullRequest, search, `createPullRequest`
- MCP `/mcp` — JSON-RPC 2.0 Streamable HTTP (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request, …)

Deterministic: sequential IDs, stable ordering, merge timestamps from `MAKEFUN_TRIAL_NOW`.

## Verify locally

```sh
node test/smoke.mjs
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=0ka9dxnm&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
