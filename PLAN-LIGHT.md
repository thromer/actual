# Session-token auth for `@actual-app/api`

One thing the official web app does that an app built on `@actual-app/api`
cannot: **log in once and stay logged in.** The web app prompts for a password,
then runs on a session token thereafter. An api consumer must hold the password
and re-supply it on every start.

OIDC is out of scope; see `PLAN-OIDC.md`, which builds on this.

---

## The gap

`sessionToken` is already a first-class `InitConfig` option (`main.ts:251-254`,
consumed and validated at `main.ts:292-314`) — but nothing in the monorepo can
mint one. `signIn` (`auth/app.ts:235-283`) writes the token to asyncStorage and
returns `{}`:

```ts
await asyncStorage.setItem('user-token', res.token);
return {};
```

There is no getter anywhere; every consumer reads asyncStorage in-process. The
door exists with no way to cut a key.

## Proposed additions

Three methods. The handlers already exist and work; they are simply unreachable
from `packages/api/methods.ts`.

### `packages/loot-core/src/types/api-handlers.ts`

```ts
'api/sign-in': (arg: { password: string; loginMethod?: string })
             => Promise<{ token: string }>;
'api/get-session-token': () => Promise<string | null>;
'api/sign-out': () => Promise<void>;
```

### `packages/loot-core/src/server/api.ts`

Follow the `api/sync` pattern (`api.ts:273-282`): delegate to the existing
handler and translate `{ error }` into a thrown `withErrorCode`.

```ts
handlers['api/sign-in'] = async function (loginInfo) {
  const result = await handlers['subscribe-sign-in'](loginInfo);
  if (result.error) {
    throw withErrorCode(
      new Error(`Authentication failed: ${result.error}`),
      result.error,
    );
  }
  return { token: await asyncStorage.getItem('user-token') };
};
```

Composing sign-in and the token read server-side avoids a race with a concurrent
sign-out. `api/get-session-token` is kept separately so a caller can recover the
token after an `init({ password })` — which is the path most consumers will
actually take (see below).

**The coded-error contract must be preserved.** Consumers already switch on a
stable `.code` surviving the worker boundary — see
`browser-app-demo/src/snapshot/actual-browser.ts:49-64`, whose comment records
that regex-matching the message text was tried and failed. Passing the raw
`result.error` slug to `withErrorCode` keeps `invalid-password` and
`network-failure` flowing unchanged. Worth a test.

### `packages/api/methods.ts`

Thin one-liners in the existing style (`methods.ts:37-47`), reaching both builds
automatically via `export * from './methods'` in `index.ts` and
`index.browser.ts`:

```ts
export async function signIn(loginInfo) {
  return send('api/sign-in', loginInfo);
}
export async function getSessionToken() {
  return send('api/get-session-token');
}
export async function signOut() {
  return send('api/sign-out');
}
```

## The consumer flow this enables

Deliberately small, because `init` already does the hard parts:

```ts
// have a token? use it
try {
  await api.init({ serverURL, dataDir, sessionToken: stored });
} catch (err) {
  if (err.code !== 'token-expired') throw err;
  // no token, or it was rejected → prompt, then mint one
  await api.init({ serverURL, dataDir, password });
  await save(await api.getSessionToken());
}
```

`init({ sessionToken })` already validates against `/account/validate` and throws
`token-expired` (`main.ts:299-306`), so no separate "is my token still good?"
call is needed.

Note what this does **not** require: the engine is always initialised _with_ a
credential — token or password — so credential-free init (`{ serverURL }` alone)
is unnecessary here. It is needed only for OIDC, where a consumer must boot
before any credential exists; it is specified in `PLAN-OIDC.md` accordingly.

Cost of a rejected token: the browser build terminates the worker when `init`
fails (`index.browser.ts:19-23`), so that path pays two engine boots. Tokens
default to never expiring, so it is rare.

## Who this is for

**Lead with `packages/cli`.** It already ships `sessionToken` as a CLI flag, an
env var and a config-file key (`config.ts:11,26,40`), consumed at
`connection.ts:47-53` — and nothing can mint one. A user's only options are
`--password` or extracting a token out of band. A first-party, in-repo,
half-built feature: cheap to verify, hard to dispute.

```
actual login    # prompt once, print or store a token
actual logout
```

Secondary:

- **`actualbudget/browser-app-demo`** — `Login.tsx:8` stores _"only the URL —
  never the password, sync ID, or encryption key"_, so the user retypes 3–4
  fields on every reload and `snapshot/actual-browser.ts:104-110` hands the
  password to `init` each time.
- **Chrome extensions** — an offscreen document can be reclaimed by Chrome at any
  time, so the credential must live outside the engine. Holding a token in
  `chrome.storage` beats holding a password.

## What to claim, and what not to

The security case is **one point, and it is narrow**: the user's password — which
they may have reused elsewhere — never touches disk. Everything else about a
stored token is no better than a stored password, and some of it is worse:

- **Sign-out is local only.** `auth/app.ts:285-294` clears `user-token`,
  `encrypt-keys`, `lastBudget`, `readOnly` and unloads encryption keys. No server
  call. There is no logout or revoke endpoint at all — `DELETE FROM sessions`
  appears only in `enableOpenID`/`disableOpenID` (`account-db.js:167,202`, which
  wipe everything), `clearExpiredSessions` (`:279`), and admin disable/delete of a
  user (`user-service.ts:82,94`).
- **Password tokens are one shared string.** `password.js:98-103` selects
  `WHERE auth_method = 'password'` with no `user_id` filter and reuses that row's
  token, so every password login on the server returns the same value. Not
  per-client, so not individually revocable. (Per-login tokens are an OIDC
  property — `openid.ts:315-332` inserts a fresh uuid each time.)
- **Changing the server password does not invalidate it.** `changePassword` never
  touches `sessions`.
- **On a password-auth server there is no revocation path.** The token defaults to
  never expiring, the user row is created with `owner = 1` (`password.js:113`),
  and `deleteUser` refuses owners (`WHERE id = ? and owner = 0`). The only lever
  is toggling OpenID to wipe the table.
- A leaked token is therefore roughly as damaging as a leaked password: the
  holder is ADMIN and can call `/account/change-password` themselves.

So `signOut` is local cleanup, not revocation, and should be described that way.
It still earns its place: in the browser build `user-token` persists in IndexedDB
(`asyncStorage/index.ts:7-9` ignores `persist: false`), so without it a consumer
that clears its own copy leaves a live credential at rest.

Also worth stating in the PR:

- **Token durability differs by build.** `main.ts:285` passes
  `asyncStorage.init({ persist: false })`, which the Node implementation honours
  (memory-only) but the browser implementation ignores. So a browser consumer's
  token survives worker restarts and a Node consumer's does not. Consumers should
  persist the token themselves rather than rely on either behaviour.

## Verification

- `packages/api/methods.test.ts` — unit coverage for the new wrappers.
- Error-code round trip: assert `invalid-password` and `network-failure` still
  arrive as `.code` through the worker boundary.
- Against a local sync server (`yarn start:server-dev`, port 5006): sign in,
  capture the token, tear down the process, re-`init` with `sessionToken` only,
  confirm a read works. Then a garbage token → `token-expired`.
- Sign out, then confirm the same token still validates at
  `GET /account/validate` — demonstrating the local-only semantics above.
- `packages/api/e2e/browser.test.ts` — extend the existing Playwright harness
  (`e2e/harness.html`, COOP/COEP via `e2e/serve-dist.mjs`) with the same round
  trip in the browser build.

## Repo conventions

- PR title prefixed `[AI]`.
- Leave `.github/PULL_REQUEST_TEMPLATE.md` unmodified and unchecked.
- Add `upcoming-release-notes/<slug>.md` — short, plain language.
- `yarn typecheck`, `yarn lint:fix`, `yarn test` from the repo root.
