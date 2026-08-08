# Emulating Actual's web-client auth + backend lifecycle from a Chrome extension

## Context

You're building a Chrome extension that talks to an Actual sync server through
`@actual-app/api`. The extension runs the **browser build** (`dist/browser.js`,
source `packages/api/index.browser.ts`) inside an offscreen document / extension
page, which spawns the real loot-core backend in an inline Web Worker.

You want to reproduce three behaviours the web client already has:

1. Use a password **once** to obtain and persist a session token; authenticate
   with that token thereafter. Plus logout.
2. Keep one long-lived worker + absurd-sql instance alive across many
   operations, with explicit `sync()` and explicit close.
3. Handle OIDC redirects.

This document is research output: explanations, code pointers, tradeoffs, and a
spec for an optional PR to this repo. No code in this repo is changed unless you
pick Option C.

---

## Part 0 — What the browser build already gives you

`packages/api/index.browser.ts:12-26`:

```ts
export async function init(
  config: InitConfig = {},
): Promise<{ send: typeof send }> {
  worker = new InlineWorker();
  try {
    await startBackendWorker(worker, config);
  } catch (error) {
    worker.terminate();
    worker = null;
    throw error;
  }
  return { send };
}
```

Two facts that shape everything below:

**`send` is typed over the entire handler union.** `Handlers`
(`packages/loot-core/src/types/handlers.ts:26-48`) intersects `AuthHandlers`
(line 48) along with everything else. So the object returned from `init()` can
already call _every_ auth message tag:

| Tag                           | Source                                         | Use                                             |
| ----------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `subscribe-needs-bootstrap`   | `packages/loot-core/src/server/auth/app.ts:43` | server reachable? which login methods?          |
| `subscribe-get-login-methods` | `auth/app.ts:118`                              | list methods                                    |
| `subscribe-sign-in`           | `auth/app.ts:235`                              | password / header / openid login                |
| `subscribe-set-token`         | `auth/app.ts:296`                              | inject a token (this is what `/openid-cb` uses) |
| `subscribe-get-user`          | `auth/app.ts:146`                              | validate token, get user + `tokenExpired`       |
| `subscribe-sign-out`          | `auth/app.ts:285`                              | clear local credentials                         |
| `close-budget`, `sync`        | `budgetfiles/app.ts:74-95`, `sync/app.ts:15`   | lifecycle                                       |

**asyncStorage in the browser build is persistent, despite `persist: false`.**
`main.ts:285` calls `asyncStorage.init({ persist: false })`, but the browser
build resolves `#platform/server/asyncStorage` to the _default_ (IndexedDB)
variant — `browser-worker.ts` does **not** use the `api` Vite resolve condition
(contrast `packages/api/vite.config.mts:44,68`). And
`packages/loot-core/src/platform/server/asyncStorage/index.ts:7-9`:

```ts
export const init: T.Init = function () {
  // No need to initialise in the browser
};
```

The `persist` flag is ignored; every `setItem` lands in the IndexedDB
`asyncStorage` object store. **So in your extension `user-token` already
survives worker restarts** — unlike the Node build, where it is memory-only.
That is a real behavioural difference from the documented Node API and it is
what makes Option B below viable at all.

### The one genuine gap

Nothing returns the token to the caller. `signIn` writes it and returns `{}`:

```ts
// packages/loot-core/src/server/auth/app.ts:277-282
if (!res.token) {
  throw new Error('login: User token not set');
}
await asyncStorage.setItem('user-token', res.token);
return {};
```

There is no `get-token` handler anywhere. Everything that needs it reads
asyncStorage in-process (~40 call sites, all sending `X-ACTUAL-TOKEN`). If you
want the token in `chrome.storage.local` — where it survives the offscreen
document being torn down, and where you can inspect/revoke it — you must either
obtain it yourself over HTTP (Option A) or add a way to read it (Option C).

### `InitConfig` today

`packages/loot-core/src/server/main.ts:242-265` — a discriminated union:

```ts
type ServerInitConfig = BaseInitConfig & { serverURL: string };
type PasswordAuthConfig = ServerInitConfig & {
  password: string;
  sessionToken?: never;
};
type SessionTokenAuthConfig = ServerInitConfig & {
  sessionToken: string;
  password?: never;
};
type NoServerConfig = BaseInitConfig & {
  serverURL?: undefined;
  password?: never;
  sessionToken?: never;
};
```

`sessionToken` is already a first-class option (`main.ts:292-314`): it runs
`subscribe-set-token`, then validates with `subscribe-get-user`, and on failure
clears the token and throws with a machine-readable code (`'token-expired'` or
`'network-failure'`, via `withErrorCode`, `server/errors.ts:102`).

**Note there is no `{ serverURL }`-only variant.** You cannot legally
`init({ serverURL })` and then sign in afterwards — the type union forbids it,
even though the runtime would be perfectly happy (`main.ts:289-327` just skips
both auth branches). This is the second thing Option C fixes.

---

## Task 1 — Password once, token thereafter

### Option A — Extension does the login HTTP call itself

Mirror `signIn` (`auth/app.ts:235-283`) with your own `fetch`, outside loot-core:

```ts
// once, with the user-supplied password
const res = await fetch(`${serverURL}/account/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password, loginMethod: 'password' }),
});
const body = await res.json(); // { status:'ok', data:{ token } }
// or  { status:'error', reason:'invalid-password' }
await chrome.storage.local.set({ actualToken: body.data.token });

// every session thereafter
const { send } = await api.init({ serverURL, sessionToken: actualToken });
```

Server side: `packages/sync-server/src/app-account.js:74-129`. The response
envelope is `{ status, data }` — `post()` in
`packages/loot-core/src/server/post.ts:99-114` unwraps `.data` and turns
`status !== 'ok'` into `PostError(reason)`; you'd replicate that unwrapping.
Note `/login` is behind `authRateLimiter`.

- **Pros.** Zero dependency on the api package's auth surface. Token is yours,
  in `chrome.storage.local`, survives offscreen-document teardown. You can
  validate it cheaply (`GET /account/validate` with `X-ACTUAL-TOKEN`) without
  booting a worker at all. Works identically against the Node build if you ever
  move the backend into a helper process.
- **Cons.** You now own a copy of the wire contract (`{status,data}` envelope,
  `reason` slugs, the `X-ACTUAL-TOKEN`-vs-`token`-in-body split, the
  `needs-bootstrap`/`login-methods` shapes) and it can drift from the server.
  You reimplement `PostError`'s error mapping, including the ngrok-tunnel
  special case at `post.ts:20-30`. Two sources of truth for "am I logged in".
- **Logout.** `POST`ing nothing — sign-out is purely local (see below). You'd
  clear `chrome.storage` yourself and, if a worker is up, also
  `send('subscribe-sign-out')` so the worker's IndexedDB copy goes too.

### Option B — loot-core handlers only, no token ever leaves the worker

```ts
const { send } = await api.init({ serverURL, password }); // first run
// ...later runs, worker's IndexedDB still holds user-token:
const { send } = await api.init({ serverURL } as InitConfig); // ← type cast required
const user = await send('subscribe-get-user');
if (!user || user.tokenExpired) {
  /* re-prompt for password */
}
```

or, keeping `init` credential-free and signing in explicitly:

```ts
await send('subscribe-sign-in', { password, loginMethod: 'password' });
```

- **Pros.** Single source of truth. You inherit every fix to the auth handlers.
  No wire-format duplication. `subscribe-needs-bootstrap` /
  `subscribe-get-login-methods` / `subscribe-sign-out` all come for free.
- **Cons.**
  - **Requires a type cast.** `{ serverURL }` alone is not in `InitConfig`.
  - **The token's durability is an implementation detail you're relying on.**
    It persists only because the browser build happens to take the IndexedDB
    asyncStorage variant while `init` passes `persist: false`. Nothing tests or
    documents that; it is arguably a bug waiting to be "fixed".
  - **You cannot see or audit the token.** No revoke-from-your-UI, no
    "sign in on this device with this token", no cheap pre-flight validation —
    every check costs a worker boot.
  - **A bad token kills the worker.** `index.browser.ts:19-23` terminates the
    worker and rethrows if `init` fails, so an expired token forces a full
    re-init rather than a recoverable re-auth. (You can dodge this by never
    passing credentials to `init` and calling `subscribe-sign-in` after.)
  - IndexedDB is origin-scoped to your extension, so this does at least not
    leak across origins — but it also means clearing extension data silently
    logs the user out with no way for your code to notice in advance.

### Option C (recommended) — Option B, plus a small PR that closes the gap

Everything B gets, minus B's two real problems, by adding the missing surface to
the api package. Spec in **Part 4**. In short: an `api/*` handler that returns
the stored token, `signIn`/`signOut`/`getUser` exported from `methods.ts`, and a
`{ serverURL }`-only `InitConfig` variant. Your extension then does:

```ts
const { send } = await api.init({ serverURL }); // no credentials
const { token } = await api.signIn({ password }); // ← token returned
await chrome.storage.local.set({ actualToken: token });
// next launch
await api.init({ serverURL, sessionToken: await load() });
```

- **Pros.** Wire contract stays in loot-core; token custody stays with you.
  Auth becomes recoverable without tearing down the worker. Upstream benefit —
  this is the surface any non-web embedder needs, not just yours.
- **Cons.** Requires the PR to land (or you carry a patch/fork in the meantime).
  Slightly widens the api package's public surface, so it needs review buy-in.

**Sign-out semantics apply to all three options.** `auth/app.ts:285-294` clears
`user-token`, `encrypt-keys`, `lastBudget`, `readOnly` and unloads encryption
keys. It makes **no server call** — the `sessions` row survives, and
`loginWithPassword` (`packages/sync-server/src/accounts/password.js:99-104`)
_reuses the same token row_ on the next password login. So "logout" is local
only; treat the token as valid-until-expiry no matter what your UI says.

---

## Task 2 — How the web app manages the backend lifecycle

The point of this section is the mechanism, not a recipe. Seven principles, each
traced to where the web client implements it, then what each one implies for the
extension.

### P1. The worker is booted once as a module side effect, outside React

`packages/desktop-client/src/index.tsx:3` — the very first import, before
stylesheets, before i18n, before React:

```ts
import '#browser-preload';
```

That runs `startBrowserBackend`
(`packages/loot-core/src/platform/client/browser-preload/start.ts:34-109`),
which does `new Worker(backendWorkerUrl)` + `initSQLBackend(worker)` (`:92-93`)
and posts an `init` payload. Nothing in the React tree ever creates, restarts, or
tears down the worker. Its lifetime is the page's lifetime, full stop.

**Principle:** backend boot is a process-level concern, not a component-level
one. **For you:** call `api.init()` once in the offscreen document's top-level
module and never in response to a user action.

### P2. A connect handshake plus a message queue hides startup latency

The worker is available immediately, but the _backend inside it_ is not. So the
transport invents its own readiness signal
(`platform/client/connection/index.ts:99-112`):

```ts
if (msg.type === 'connect') {
  messageQueue?.forEach(msg => worker.postMessage(msg));
  messageQueue = null;      // later sends post directly
  ...
  onOpen();
}
```

and `send` buffers until then (`:174-178`):

```ts
if (messageQueue) {
  messageQueue.push(message);
} else {
  globalWorker.postMessage(message);
}
```

**Principle:** callers never coordinate with backend readiness — the transport
does. **For you:** once `startBackendWorker` resolves you can `send` freely; there
is no second "is it ready" gate to build.

### P3. Two nested lifetimes — worker (process) and budget (document)

A web session opens **one** budget and keeps it open. Closing is never routine —
every `closeBudget()` dispatch is user-driven or error recovery:

| Trigger                              | Where                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| "Close file" menu item               | `components/sidebar/BudgetName.tsx:85`                                             |
| Cmd/Ctrl+O                           | `index.tsx:125`                                                                    |
| Settings action / mobile close       | `components/settings/index.tsx:176`, `components/mobile/budget/BudgetPage.tsx:499` |
| Sign out                             | `users/usersSlice.ts:52`                                                           |
| Switch / delete / download a budget  | `budgetfiles/budgetfilesSlice.ts:282,294,394`                                      |
| Auth-method change, version mismatch | `modals/OpenIDEnableModal.tsx:45`, `modals/OutOfSyncMigrationsModal.tsx:20`        |

The point of P3 is therefore **not** "close often" — it is that the two lifetimes
are _separate_. The worker is process-scoped (P1); the budget is a document
opened inside it. The client mirrors that split when it does close
(`budgetfilesSlice.ts:99-114`):

```ts
dispatch(resetApp());
queryClient.clear();
await send('close-budget');
```

— Redux reset and the TanStack cache cleared, because closing invalidates every
client-side derived value. Server-side, `close-budget` is far more than closing a
database (`budgetfiles/app.ts:258-282`): `waitOnSpreadsheet` →
`unloadSpreadsheet` → `clearFullSyncTimeout` → `stopServices` → `closeDatabase` →
`unloadPrefs`. `startServices`/`stopServices` (`server/app.ts:70-89`) run
budget-scoped subscriptions registered with `app.service()` — schedules
(`schedules/app.ts:557`), transaction rules (`transaction-rules.ts:216`), db id
mappings (`mappings.ts:38`), each an `addSyncListener`. `_loadBudget` starts them
at `budgetfiles/app.ts:640-643`.

(There is a third state worth knowing about: `closeBudgetUI`
(`budgetfilesSlice.ts:116-125`) resets client state **without** sending
`close-budget`. It fires on backend-initiated `start-load` / `start-import` /
`show-budgets` pushes (`global-events.ts:151,162,172`) — i.e. "the backend
changed budgets underneath me". Only relevant if you ever drive one worker from
two contexts.)

**For you: open the budget once and leave it open.** That is what a web session
does too. The reason the separation still matters is that `api.shutdown()`
(`index.browser.ts:28-42`) collapses both lifetimes — it syncs, closes the
budget, _and_ terminates the worker — so reaching for it to end an _operation_
kills your backend. Use `load-budget` / `close-budget` directly, and keep
`shutdown()` for actually going away.

#### What leaving it open costs in the browser build

Two things make an indefinitely-open budget riskier here than on desktop:

- **No backups.** `_loadBudget` gates the backup service on `!Platform.isBrowser`
  (`budgetfiles/app.ts:618-620`), so the browser build never takes local backups.
  Desktop has a fallback if the local DB goes bad; you do not.
- **`PRAGMA journal_mode=MEMORY`** (`platform/server/sqlite/index.ts:222`). The
  rollback journal is in memory, so termination mid-transaction — exactly how
  Chrome reclaims an idle offscreen document — can leave the local file
  inconsistent.

**So the server is your only durability, and the cadence question is "when do I
sync", not "when do I close".** A long-lived open budget with periodic syncs is
the right shape; just don't treat the local sqlite file as the source of truth
the way desktop can.

When you _are_ deliberately tearing down (switching budgets, sign-out, extension
update): sync first, because `close-budget` cancels the pending debounce rather
than flushing it (P6). Note the web app couples these — `usersSlice.ts:52`
dispatches `closeBudget()` as part of sign-out, since `subscribe-sign-out` clears
`lastBudget` but does not close anything itself.

### P4. Sync is not driven per-operation — every write self-schedules it

This is the piece that most changes how you'd design the extension. Every CRDT
write funnels through `sendMessages` (`db/index.ts:212,245,259`,
`prefs.ts:71`, `undo.ts:111`) into `_sendMessages`, which ends
(`sync/index.ts:488-497`):

```ts
await scheduleFullSync();
```

and that is a 1-second trailing debounce (`sync/index.ts:550-567`,
`FULL_SYNC_DELAY = 1000` at `:40`):

```ts
clearFullSyncTimeout();
if (checkSyncingMode('enabled') && !checkSyncingMode('offline')) {
  syncTimeout = setTimeout(fullSync, FULL_SYNC_DELAY);
}
```

**Principle:** pushing your own writes is automatic and coalesced. **For you:**
you do not need `api.sync()` after a batch of mutations to get them uploaded —
idling one second does it. What you _do_ need it for is P5.

### P5. Explicit sync means "pull now", and only at coarse moments

Every explicit sync in the web client is a _staleness_ trigger, never a
per-mutation flush:

| Trigger                    | Where                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| Finances app mounts        | `components/FinancesApp.tsx:110-115` (100 ms delay so the sync button catches the `start` event) |
| Tab becomes visible        | `components/App.tsx:178-181`, `useOnVisible`                                                     |
| Window/app focus           | `index.tsx:50-52` → `send('app-focused')` → `main.ts:120-125` → `void fullSync()`                |
| Manual sync button         | `components/Titlebar.tsx:214`                                                                    |
| After recovery / bank sync | `sync-events.ts:138,221,303`, `accounts/mutations.ts:813-822`                                    |

**Principle:** explicit sync answers "has someone else changed something?", not
"did my write land?". **For you:** call it on wake-up and before a read that must
be fresh — not after each write.

### P6. `fullSync` coalesces concurrent callers, so syncing is cheap to request

`sync/index.ts:597` wraps it in `once` (`shared/async.ts:62-76`), which is
in-flight deduplication rather than run-once: concurrent callers share one
promise, reset on settle. Visibility, focus and the debounce timer firing
together produce a single sync.

**Principle:** sync requests are idempotent-ish; over-calling is harmless.
**But two consequences bite an extension and not the web app:**

- Your explicit `api.sync()` may _join_ an already-running sync that started
  before your latest writes, and return without having pushed them. The web app
  never notices because something syncs again a moment later. If you need
  "flush, then stop", sync, then sync once more, or wait out the debounce first.
- `close-budget` calls `clearFullSyncTimeout()` (`budgetfiles/app.ts:266`) — a
  pending debounced sync is **cancelled, not flushed**. Closing immediately after
  writing loses the push until the next load. This is precisely why
  `shutdown()` sends `'sync'` before `'close-budget'`.

### P7. Sync status is a push stream; the client is reactive, never polling

`main-app.ts:10-12` is the whole bridge:

```ts
app.events.on('sync', event => {
  connection.send('sync-event', event);
});
```

`fullSync` emits `{type:'start'}` at `sync/index.ts:601` and typed error variants
at `:613-657` (`out-of-sync`, `invalid-schema`, `decrypt-failure`, `clock-drift`,
`unauthorized`, `network`). Success events carry `tables`, computed by
`getTablesFromMessages` (`:569-579`). Consumers subscribe with `listen`
(`platform/client/connection/index.ts:186-199`):

- `Titlebar.tsx:137` — spinner
- `LoggedInUser.tsx:70` — re-validate the user on online/offline transitions
- `sync-events.ts:22` — `unauthorized` → sticky notification
- `sync-events.ts:39-70` — on `success`/`applied`, invalidate caches **by table
  name** from `event.tables`
- `queries/liveQuery.ts:139` — re-run live queries

**Principle:** there is no sync-status handler to poll because status is a typed
event stream, and cache invalidation is driven off `event.tables`. **For you:**
`listen('sync-event', cb)` is your only observability hook, and it's the right
one. (In the _Node_ api build these are black-holed —
`platform/server/connection/index.api.ts` no-ops — another reason the browser
build suits you.)

### Bonus: syncing mode is per-budget-load, not per-call

`setSyncingMode` (`sync/index.ts:44-63`) takes `enabled | offline | disabled |
import`; `_loadBudget` picks one from whether `getServer()` is set
(`budgetfiles/app.ts:652-656`); the api's no-server path forces `offline`
(`main.ts:333-335`). Watch `checkSyncingMode`'s asymmetry (`:65-76`) —
`checkSyncingMode('enabled')` is true for _both_ `enabled` and `offline`, which
is why `scheduleFullSync` tests both.

### What this adds up to for the extension

```ts
// module scope, once per offscreen-document lifetime
const { send } = await api.init({ serverURL, sessionToken });
listen('sync-event', onSyncEvent); // P7
await api.downloadBudget(syncId, { password }); // or loadBudget — P3

// …and then just leave it open. Steady state:

// on wake / before a read that must be fresh — P5
await api.sync();

// mutations — P4: no sync call needed, the debounce pushes them
// ...

// periodically, because the server is your only durability (P3) —
// not because anything needs closing
await api.sync();
```

The two teardown paths, both rare:

```ts
// switching budgets, or signing out — sync BEFORE close (P6),
// or clearFullSyncTimeout() drops the pending push
await api.sync();
await send('close-budget');

// actually going away (extension update, explicit stop)
await api.shutdown(); // syncs, closes, terminates the worker
```

### No reconnect — and why the token belongs outside the worker

`platform/client/connection/index.ts:90-92`: "_if the worker dies, it will
permanently be disconnected_". `globalWorker` and `index.browser.ts`'s `worker`
are module singletons — one backend per JS realm. The web app can assume that
holds for the page's life; an offscreen document can be reclaimed by Chrome at
any time. So design for cold starts, and keep the session token in
`chrome.storage` rather than only in the worker's IndexedDB.

### Environment constraints — all three are settled by the PoC

**Corrected 2026-08-07.** An earlier draft of this document claimed the api
package's inlined **Blob-URL worker would be blocked by MV3's CSP**, and called
it the most likely thing to sink the design. **That is wrong**, and
`actual-api-crx-poc` is the disproof: it runs, with

```jsonc
// actual-api-crx-poc/public/manifest.json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self'"
}
```

`worker-src 'self'` admits the blob worker — a blob URL created by the extension
page carries that page's origin, so it matches `'self'`. No `blob:` grant is
needed and no upstream change is required. The reasoning that led me astray
(`worker-src` falling back to a `blob:`-hostile `script-src`) was plausible and
wrong; the running PoC outranks it. See Part 7.

The genuinely operative constraints, all already handled:

1. **`new Worker()` is unavailable in an MV3 extension service worker.** You need
   a document context. The PoC uses
   `chrome.offscreen.Reason.WORKERS` (`background.ts:19-22`). Chrome may still
   reclaim an idle offscreen document, so design for cold starts (persisted
   token, re-`loadBudget` on boot) rather than assuming the worker outlives the
   browser session.
2. **`'wasm-unsafe-eval'` is required** in `extension_pages` for sql.js. A
   manifest line on your side, nothing more.
3. **absurd-sql wants `SharedArrayBuffer`, i.e. cross-origin isolation.** MV3
   supports this directly, and the PoC declares it:

   ```jsonc
   "cross_origin_embedder_policy": { "value": "require-corp" },
   "cross_origin_opener_policy": { "value": "same-origin" }
   ```

   So the degraded `readIfFallback` path
   (`platform/server/sqlite/index.ts:210-214`) and the data-loss warning it
   implies (`desktop-client/src/components/FatalError.tsx:147-176`) do not apply
   to you. Still worth asserting `self.crossOriginIsolated` at boot so a manifest
   regression fails loudly rather than silently degrading.

Background on why isolation is needed at all: `startBackendWorker`
(`platform/client/backend-worker.ts:12`) calls absurd-sql's `initBackend(worker)`,
and the repo's own test harness serves with the same two headers
(`packages/api/e2e/serve-dist.mjs:23-24`).

---

## Task 3 — OIDC redirects

The flow the web client runs:

1. `send('subscribe-sign-in', { returnUrl: <your origin>, loginMethod: 'openid', password: firstLoginPassword })`
   (`desktop-client/src/components/manager/subscribe/Login.tsx:126-144`).
2. `auth/app.ts:273-275` returns `{ redirectUrl }` — the _provider's_
   authorization URL — and stores **no token**.
3. Browser navigates there; provider redirects to
   `{server}/openid/callback`; the server exchanges the code, mints a session,
   and 302s to `` `${return_url}/openid-cb?token=${token}` ``
   (`packages/sync-server/src/accounts/openid.ts:336`).
4. `OpenIdCallback.ts:17-25` reads `?token=` and calls
   `send('subscribe-set-token', { token })`.

### The blocker

`isValidRedirectUrl` (`openid.ts:359-381`) accepts a `returnUrl` **only** if its
hostname equals the configured `server_hostname`, or is literally `localhost`:

```ts
if (
  redirectUrl.hostname === serverUrl.hostname ||
  redirectUrl.hostname === 'localhost'
) {
  return true;
}
```

It is enforced twice — `app-account.js:98` before setup, and `app-openid.ts:107`
before the final redirect. So neither `chrome-extension://<id>/…` (hostname =
the extension id) nor `https://<id>.chromiumapp.org/` passes, which rules out
the obvious `chrome.identity.launchWebAuthFlow` approach against an unmodified
server. Electron sidesteps this with a loopback HTTP server on port 3010
(`packages/desktop-electron/index.ts:93-134`) — the `localhost` carve-out exists
for exactly that — and an extension cannot open a listening socket.

### Workaround without server changes

Route the callback through a **path the web app never uses**, on the server's own
hostname. `isValidRedirectUrl` compares hostname only — not path, not port, not
scheme — so `returnUrl` can carry a discriminator:

```ts
await send('subscribe-sign-in', {
  returnUrl: `${serverURL}/__actual-ext`, // ← passes the hostname check
  loginMethod: 'openid',
  password: firstLoginPassword,
});
// server's second hop lands on: {server}/__actual-ext/openid-cb?token=…
```

Then:

- `host_permissions` for the server origin.
- A content script at `document_start` matching **`{server}/__actual-ext/openid-cb*`**
  (not `/openid-cb*`) that reads
  `new URLSearchParams(location.search).get('token')`, calls `window.stop()`,
  and messages the token back to the extension.
- Extension then `send('subscribe-set-token', { token })` — same tag the web
  client uses — and closes the tab.

**Why the discriminating path is mandatory, not cosmetic.** The final callback
URL carries only the token (`openid.ts:336`) — no `state`, no nonce, nothing
correlatable — so a content script matching bare `/openid-cb*` has no way to
tell your login from a user's real web-app login in another tab, and its
`window.stop()` would break the web app. The nested path removes the ambiguity
entirely.

It also stops the SPA from stealing the token. The sync server has an SPA
catch-all (`app.ts:175-177`, `sendFile('index.html')` for `/{*splat}`), so the
web client _does_ load at the nested path — but its router only registers
`<Route path="/openid-cb">` at the root (`ManagementApp.tsx:189`), so
`/__actual-ext/openid-cb` falls through to the catch-all → `/bootstrap` and
`OpenIdCallback` never runs. With the root path you would instead get a parallel
logged-in session written into the server origin's IndexedDB. The `window.stop()`
is then just a load-time optimisation, and it is safe because it can only ever
fire on your own path.

### Longer-term fix (separate, larger PR — sync-server, not api)

Add an allow-list of additional redirect origins to `isValidRedirectUrl`
(config key alongside `openId.server_hostname`, e.g.
`ACTUAL_OPENID_ALLOWED_REDIRECT_ORIGINS`), so an operator can opt in
`https://<id>.chromiumapp.org`. Pair it with `chrome.identity.launchWebAuthFlow`:

```ts
const returnUrl = chrome.identity.getRedirectURL(); // https://<id>.chromiumapp.org/
const { redirectUrl } = await send('subscribe-sign-in', {
  returnUrl,
  loginMethod: 'openid',
  password: firstLoginPassword,
});
const final = await chrome.identity.launchWebAuthFlow({
  url: redirectUrl,
  interactive: true,
});
const token = new URL(final).searchParams.get('token');
await send('subscribe-set-token', { token });
```

`chromiumapp.org` does not resolve; Chrome intercepts the navigation inside the
auth window and hands back the URL without fetching it. That is the same shape as
the existing `localhost` carve-out for Electron — an unfetchable sentinel origin
the client recognises — which makes it an easy change to argue for upstream.

**Do not allow-list `chrome-extension://`.** Chrome blocks server-initiated
navigation to extension URLs, so the 302 would die.

**The OIDC provider is not a constraint here.** `setupOpenIdClient`
(`openid.ts:88-96`) hardcodes the provider-facing redirect URI:

```ts
redirect_uri: new URL('/openid/callback', configParameter.server_hostname).toString(),
```

Google (or any provider) is only ever told about `{server}/openid/callback`, an
ordinary https URL on the operator's domain. `returnUrl` is Actual's own _second_
hop, applied after `loginWithOpenIdFinalize` has already exchanged the code and
minted the session (`openid.ts:315-336`). The provider has no visibility into it
and no say over it, so its redirect-URI policy does not apply. (It _would_ apply
to a different architecture — the extension talking OIDC to Google directly —
where Google's console rejects `chrome-extension://` redirect URIs for Web
application clients and the old Chrome App client type that accepted
`chromiumapp.org` is deprecated for new clients. That flow never arises here
because the server holds the `client_secret` and performs the exchange.)

This is a security-relevant change to an auth boundary and should be proposed
separately from the Part 4 PR — do not bundle them.

Also relevant: `openid.ts:113-127` requires the server password on the _first_
OpenID login when no named users exist yet; `Login.tsx:101,158-168` is where the
web client collects it.

---

## Part 4 — Spec for the Option C PR

Small, additive, no behaviour change for existing consumers.

### 1. `packages/loot-core/src/types/api-handlers.ts`

Add to `ApiHandlers` (existing style at lines 36-60):

```ts
'api/sign-in': (arg: { password: string; loginMethod?: string }
              | { returnUrl: string; loginMethod: 'openid' })
              => Promise<{ token?: string; redirectUrl?: string }>;
'api/sign-out': () => Promise<void>;
'api/get-session-token': () => Promise<string | null>;
'api/get-user': () => Promise<Awaited<ReturnType<AuthHandlers['subscribe-get-user']>>>;
```

### 2. `packages/loot-core/src/server/api.ts`

Follow the `api/sync` pattern (`api.ts:273-282`) — delegate to the existing
handler, translate `{ error }` into a thrown `withErrorCode`:

```ts
handlers['api/sign-in'] = async function (loginInfo) {
  const result = await handlers['subscribe-sign-in'](loginInfo);
  if (result.error) {
    throw withErrorCode(
      new Error(`Authentication failed: ${result.error}`),
      result.error,
    );
  }
  if (result.redirectUrl) return { redirectUrl: result.redirectUrl };
  return { token: await asyncStorage.getItem('user-token') };
};

handlers['api/sign-out'] = () =>
  handlers['subscribe-sign-out']().then(() => undefined);
handlers['api/get-session-token'] = () =>
  asyncStorage.getItem('user-token') ?? null;
handlers['api/get-user'] = () => handlers['subscribe-get-user']();
```

Composing sign-in + token read **server-side** (rather than exporting a bare
token getter and letting callers do two round trips) avoids a race with any
concurrent sign-out. Keep `api/get-session-token` too — it's what lets a caller
recover the token after `init({ password })`.

**The coded-error contract is load-bearing and must be preserved.** Consumers
already depend on rejections carrying a stable `.code` across the worker
boundary. The demo app switches on exactly that
(`browser-app-demo/src/snapshot/actual-browser.ts:45-64`), and its comment
records why the alternative failed:

> Rejections now carry a stable `code` across the worker boundary … so map that
> instead of regex-matching prose — which mis-fired on messages like
> "Authentication failed: network-failure" (the "auth" substring wrongly matched
> before "network").

It maps `invalid-password`, `unauthorized`, `decrypt-failure`, `needs-key`,
`network-failure`, `budget-not-found`. Using `withErrorCode` with the raw
`result.error` slug (as above) keeps `invalid-password` and `network-failure`
flowing through unchanged, so existing consumers need no change — but this is a
compatibility requirement to state in the PR, and a case worth covering in the
tests, not an incidental detail.

### 3. `packages/loot-core/src/server/main.ts`

Add the missing `InitConfig` variant so credential-free init typechecks:

```ts
type StoredAuthConfig = ServerInitConfig & {
  password?: never;
  sessionToken?: never;
};

export type InitConfig =
  | PasswordAuthConfig
  | SessionTokenAuthConfig
  | StoredAuthConfig // ← new
  | NoServerConfig;
```

No runtime change needed — `main.ts:289-327` already falls through both auth
branches. Worth a comment noting that this mode relies on a previously stored
`user-token`, and that it is only durable where asyncStorage persists (browser
build: yes; Node build: no, `persist: false`).

### 4. `packages/api/methods.ts`

Thin one-liners in the existing style (`methods.ts:37-47`):

```ts
export async function signIn(loginInfo) {
  return send('api/sign-in', loginInfo);
}
export async function signOut() {
  return send('api/sign-out');
}
export async function getSessionToken() {
  return send('api/get-session-token');
}
export async function getUser() {
  return send('api/get-user');
}
```

These flow to both builds automatically — `index.ts:6` and
`index.browser.ts:7` both `export * from './methods'`.

### 5. ~~Opt-in worker injection~~ — dropped, premise disproven

An earlier draft proposed letting `init()` accept a caller-supplied `Worker`,
plus publishing the worker as a standalone `dist/browser-worker.js`, on the
theory that MV3's CSP blocks the inlined Blob-URL worker. **`actual-api-crx-poc`
disproves that** — `worker-src 'self'` admits it and the PoC runs. See the
corrected environment constraints in Task 2 and Part 7.

Dropping this matters for the PR's framing: it was the _only_ proposed item
motivated by extensions rather than by browsers generally. Without it,
**nothing in this PR is extension-specific** — every remaining item is justified
by the browser demo app or by Node consumers. That is a strictly better position
to argue from.

(Should a real strict-CSP host turn up later that genuinely cannot admit a
blob worker, the escape hatch is still the right shape — but propose it then,
with that host as evidence, not speculatively.)

### 6. `listen` in `init()`'s return value

The Part 5C parity fix, and worth stating as its own item rather than a rider:

```ts
export async function init(
  config: InitConfig = {},
): Promise<{ send: typeof send; listen: typeof listen }> {
  ...
  return { send, listen };
}
```

Three lines. The justification is in Part 5C (Node's `lib` already exposes
`on()`; the browser build exposes nothing) — and Part 7 supplies a second,
sharper one: without `listen`, a browser consumer cannot observe
`api-fetch-redirected` and therefore **cannot support auth-proxied servers at
all**.

### 7. Tests

- `packages/api/methods.test.ts` — unit coverage for the new wrappers.
- `packages/api/e2e/browser.test.ts` — extend the existing Playwright harness
  (`e2e/harness.html`, served with COOP/COEP by `e2e/serve-dist.mjs`) with a
  round-trip: `init({ serverURL })` → `signIn({ password })` returns a token →
  re-`init({ serverURL, sessionToken })` succeeds → `signOut()` →
  `getSessionToken()` is null. Needs a sync server fixture; check what
  `packages/api/e2e/consumer.test.ts` and `global-setup.mjs` already stand up
  before adding one.
- `packages/loot-core` — the `api/sign-in` error-translation path.

### 8. Repo conventions

- PR title: `[AI] Expose session-token auth via the api package`.
- Leave `.github/PULL_REQUEST_TEMPLATE.md` **unmodified and unchecked**.
- Add `upcoming-release-notes/<slug>.md` — short, plain language, no jargon.
- `yarn typecheck`, `yarn lint:fix`, `yarn test` from the repo root.
- New files must be type-strict (no `// @ts-strict-ignore`). Note `api.ts` and
  `api-handlers.ts` are both already `@ts-strict-ignore`'d at the top, so
  additions there inherit that.

### Upstream justification — who else benefits

The PR should be argued on general grounds, not on "a Chrome extension needs
this". Honest strength assessment per item:

| Item                                           | General benefit                                                                                                                                                                                                                                                                                                                 | Strength                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `signIn` returns the token / `getSessionToken` | `sessionToken` is **already** an `InitConfig` option (`main.ts:251-254`) but there is no supported way to obtain one. Every headless consumer must therefore retain the _password_ and re-login on each `init`, because the Node build is `persist: false`. Lets a consumer mint a token once and store it in its own keystore. | **Strong** — completes an existing feature rather than adding one |
| `init()` returns `{ send, listen }`            | **Parity gap.** The Node build's `lib` already exposes `on(name, cb)` over `app.events` (`main.ts:353`); the browser build returns only `{ send }`, so browser consumers cannot observe sync at all without importing loot-core internals.                                                                                      | **Strong** — parity, not a new feature                            |
| `getUser()`                                    | Multiuser consumers need identity, permission and `tokenExpired`. Currently unanswerable except via an `init` that throws.                                                                                                                                                                                                      | Moderate                                                          |
| `getLoginMethods()` / `needsBootstrap()`       | Anything connecting to an arbitrary server (CLI, setup tool) needs to know whether it is bootstrapped and what auth it accepts.                                                                                                                                                                                                 | Moderate                                                          |
| `closeBudget()`                                | Narrower than it first looks: `api.loadBudget(otherId)` already closes the current budget (`budgetfiles/app.ts:227-243`), so switching does not need it. Real use is "stop working on this budget but keep the process" — releasing the spreadsheet and services without paying re-init.                                        | Weak-moderate                                                     |
| `signOut()`                                    | Near-no-op for Node (`persist: false` — process exit already discards the token). Matters for the browser build, where asyncStorage is IndexedDB-backed. Justify on those terms.                                                                                                                                                | Weak for Node, real for browser                                   |
| `StoredAuthConfig` (`init({ serverURL })`)     | On its own looks pointless in Node, since no token is ever stored. Its real justification: the current union forces credentials to exist _at init time_, which is wrong for any interactive consumer where the user supplies a password after start-up. Precondition for sign-in-after-init.                                    | Indirect — present it as such                                     |

**Do not oversell `closeBudget`, `signOut` or `StoredAuthConfig`.** Leading with
the two strong items and presenting the rest as completing the same surface is a
better shape than a flat list of seven additions.

### The Task 3 allow-list is also not extension-specific

Worth correcting the framing in Task 3: this fixes a live bug for self-hosters.
`isValidRedirectUrl` compares `returnUrl`'s hostname against the OIDC config's
`server_hostname` (`openid.ts:359-381`), while the web client sends
`window.location.origin` (`Login.tsx:127-131`). Those match **only when the web
client is served by the sync server**. Anyone running a split-origin deployment —
web client on `app.example.com`, sync server on `sync.example.com`, which
`ConfigServer` explicitly supports — has OIDC broken today. The `localhost`
carve-out exists because Electron hit exactly this wall. An extension origin is
just one more beneficiary of the same fix, which makes the change considerably
more likely to land than "please allow-list my extension".

### Explicitly out of scope for this PR

- The `isValidRedirectUrl` allow-list (Task 3) — separate, security-sensitive,
  sync-server-side.
- Any change to how `persist: false` interacts with the browser asyncStorage
  variant. Worth raising as an issue (the browser build silently persists
  credentials the Node build does not), but conflating it with this PR risks
  breaking the very durability Option B depends on.

---

## Part 5 — Coupling surface: raw `send` vs exported `api.*`

`send` is typed over the whole `Handlers` union only because
`index.browser.ts:14` declares the return type as `typeof send` — it is a
consequence of the transport being reused, not a designed public API. Nothing in
the api package documents a message tag, no test pins one, and `Handlers` is an
internal union that upstream reshuffles freely (the per-app `*/app.ts` split
moved most tags between modules). Accepting that coupling is reasonable; it
should just be explicit and contained.

### A. Depends on raw `send` because no `api.*` equivalent exists

| Tag                           | Needed for                           | Task |
| ----------------------------- | ------------------------------------ | ---- |
| `subscribe-sign-in`           | password login; OIDC initiation      | 1, 3 |
| `subscribe-set-token`         | inject an OIDC / stored token        | 1, 3 |
| `subscribe-get-user`          | validate token, read `tokenExpired`  | 1    |
| `subscribe-sign-out`          | logout                               | 1    |
| `subscribe-needs-bootstrap`   | server reachable? bootstrapped?      | 1    |
| `subscribe-get-login-methods` | password vs OIDC vs header           | 1, 3 |
| `close-budget`                | close without terminating the worker | 2    |

Six of the seven are auth. That is the whole justification for the Part 4 PR:
it converts the top four into supported `api.signIn` / `api.setToken` /
`api.getUser` / `api.signOut` calls. Worth folding into that PR as well:

- `api.closeBudget()` — today the only supported way to close is `shutdown()`,
  which also kills the worker. This is a real gap for any long-running embedder,
  not just yours.
- `api.getLoginMethods()` / `api.needsBootstrap()` — cheap, and they complete the
  "connect to an arbitrary server" story.

That would leave `subscribe-set-token` (unavoidable for the OIDC callback) as the
only raw tag in the auth path.

### B. Uses raw `send` where an `api.*` exists — don't

| Instead of            | Use                | Why                                                                                                                                                                                                |
| --------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send('load-budget')` | `api.loadBudget()` | `api/load-budget` (`api.ts:161-176`) skips a redundant reload of the same id, emits `start-load`/`finish-load`, and **throws** a coded error instead of returning `{error}`                        |
| `send('sync')`        | `api.sync()`       | raw `sync` is the `once`-wrapped debounced `fullSync`; `api/sync` → `sync-budget` also sets syncing mode and uses `initialFullSync`, which waits on the spreadsheet (`budgetfiles/app.ts:220-225`) |
| `send('get-budgets')` | `api.getBudgets()` | merges local budgets with remote files and maps through the external models (`api.ts:264-271`)                                                                                                     |

Note `shutdown()` itself sends the _raw_ `'sync'` (`index.browser.ts:31`), so it
does not wait on the spreadsheet — one more reason to call `api.sync()` yourself
before tearing down.

### C. A deeper coupling than `send`: `listen`

`init()` returns only `{ send }`. The push channel is not exposed at all, so P7's
sync observability requires reaching past the api package:

```ts
import { listen } from '@actual-app/core/platform/client/connection';
```

That means adding `@actual-app/core` as a direct dependency of the extension —
importing loot-core's internals rather than consuming the api package. It is
published (`packages/loot-core/package.json`, no `private`, and
`./platform/client/connection` is in `exports`), so it works; it is simply a
larger commitment than the `send` accident. If you want to shrink the surface,
`init()` returning `{ send, listen }` is a one-line addition worth including in
the Part 4 PR.

### D. Everything else is ordinary supported API

The ~60 functions in `packages/api/methods.ts` — transactions, accounts,
categories, payees, rules, schedules, tags, budget months/amounts, `aqlQuery`,
`runImport`, `batchBudgetUpdates`, `runBankSync`, `getPreferences` — plus `init`,
`shutdown`, `utils` and `q`. All of your actual data work should live here.

### E. Containing the risk

- **Put every raw `send`/`listen` call in one adapter module.** Seven tags and
  one import; a breaking rename upstream then costs one file, and the diff when
  the Part 4 PR lands is confined to it.
- **Pin `@actual-app/api` exactly** (not `^`), and treat a version bump as
  requiring a run of the auth + lifecycle smoke test in the Verification section.
  Handler tags are not covered by semver here because they are not public.
- **Prefer the `api.*` form wherever column B applies** — those are not just
  supported, they are behaviourally better.

---

## Part 6 — Parallel PR to `actualbudget/browser-app-demo`

### What the demo is today

`actualbudget/browser-app-demo` (fork checked out at `browser-app-demo/`, remote
`thromer/browser-app-demo`). React 18 + Vite 7 + Tailwind + Recharts; a
**read-only** analysis dashboard. Dev server sets COOP/COEP (`vite.config.ts:9-10`).

All `@actual-app/api` usage is in one 188-line file,
`src/snapshot/actual-browser.ts`; `src/api/client.ts` is a thin façade holding a
module-global `Snapshot`; `App.tsx` is a two-state toggle between `Login` and
`Dashboard`.

The current lifecycle is **read-once, then discard the engine**:

```ts
// src/snapshot/actual-browser.ts:101-119
withEngine({ dataDir: DATA_DIR, serverURL, password }, mapError, async () => {
  await api.downloadBudget(req.syncId, { password: req.encryptionKey });
  return readSnapshot(); // slurps the whole budget into a JS object
});
// src/api/client.ts:68-72 — disconnect() → api.shutdown()
```

After `connect()` the worker is still alive but never used again; every read
comes from the in-memory `Snapshot`. `withEngine` (`:79-92`) shuts down only on
failure. The read itself is `readSnapshot` (`:96-99`) → `fetchRawData`
(`:135-183`), which pulls accounts, categories, groups and payees in parallel and
then loops accounts **sequentially**, one full-range `getTransactions` each.

### Incidental findings worth folding into the demo PR

Independent of the Part 4 items — these are true today:

- **The `DATA_DIR` comment is stale.** `actual-browser.ts:21-24` says writing
  anywhere but `/documents` "throws a WASM FS error". Custom `dataDir` shipped in
  `dcff910de` ("api: support custom dataDir", #8397, 2026-07-16) and the demo
  pins `^26.8.0-nightly.20260717` — a day later. `InitConfig`'s own docstring
  (`main.ts:230-239`) now says the browser path "is created automatically if
  missing". Worth re-verifying at runtime, then correcting the comment.
- **`fetchRawData` does N sequential round trips**, one `getTransactions` per
  account over `0001-01-01`–`9999-12-31` (`:26-30`, `:147-161`). With the engine
  kept alive, a single `aqlQuery` would replace the loop — a natural companion to
  the long-lived-engine restructure, and a better showcase of the api's query
  surface than N date-bounded reads.
- **Existing `localStorage` convention is `aa.<thing>.v1`** (`Login.tsx:9`
  `aa.serverURL.v1`, `lib/settings.ts:4` `aa.settings.v1`). A stored session
  token should follow it.

### Why this demo is the right evidence for the Part 4 PR

Each api addition maps onto a concrete deficiency the demo has _today_. That is
the argument to make upstream: not "add these methods", but "here is the consumer
code that gets simpler".

| Part 4 item                              | What the demo does now                                                                                                                                                                                        | What it could do                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signIn` → token, `sessionToken` re-init | `Login.tsx:8` — _"only the URL — never the password, sync ID, or encryption key"_. The user retypes 3–4 fields on **every reload**, and `actual-browser.ts:104-110` passes the password to `init` every time. | Store the returned session token in `localStorage`, re-init with `sessionToken`, land straight on the dashboard. Honest story: a **revocable session token, never the password**. The single most user-visible payoff. |
| `listen` in `init()`'s return            | `Login.tsx:129-132` — a static _"Connecting & downloading budget…"_ spinner for a wait that is seconds-to-minutes on a real budget.                                                                           | `listen('sync-event')` → real progress and typed failure states. This demo is what _justifies_ the parity fix.                                                                                                         |
| long-lived worker + `api.sync()`         | The only way to get fresh data is disconnect → retype everything → full `downloadBudget`.                                                                                                                     | A "Refresh" button: `api.sync()` + re-read, no re-download, no re-auth. Demonstrates P2 and P5 in one control.                                                                                                         |
| `closeBudget()`, `getBudgets()`          | `actual-browser.ts:164-170` takes `budgets[0].name` and **ignores every other budget**.                                                                                                                       | A budget picker driving `loadBudget` / `closeBudget`, making the two nested lifetimes (P3) visible instead of implied. The natural justification for `closeBudget`.                                                    |
| `needsBootstrap()`, `getLoginMethods()`  | The form hardcodes password auth; against an OIDC-only server the demo simply cannot connect.                                                                                                                 | Enter a server URL → discover whether it is bootstrapped and what auth it accepts → render the right form.                                                                                                             |

**Not demonstrable here**, and that is fine — say so rather than stretching:

- ~~Worker injection~~ — dropped from the PR entirely (Part 4 §5); was a CSP
  escape hatch with no web-app-visible
  behaviour. Its justification stays in the api PR.
- Task 3's OIDC redirect needs a configured OIDC provider; out of scope for a
  demo unless one is already available to test against.

### Sequencing and framing

1. The api PR lands and a nightly publishes. `package.json` already tracks
   `"@actual-app/api": "^26.8.0-nightly.20260717"`, so the demo PR is a version
   bump plus the changes above.
2. Open both cross-referenced. The demo PR is the _evidence_ for the api PR — a
   reviewer can see the consumer diff shrink.
3. Keep the demo PR's scope honest: it is a demo, and the README already leads
   with a not-production-ready disclaimer. Prefer showing each capability once,
   clearly, over building a product.

### Things to be careful about in the demo PR

- **Storing a token in `localStorage` needs a visible, honest caveat.** The
  current README/Login copy is careful about credentials; the new copy must say
  what a session token is, that it is revocable server-side, and — per Task 1 —
  that **sign-out is local only** (`auth/app.ts:285-294` makes no server call, so
  the session row survives). Do not imply otherwise.
- **`withEngine` re-inits on every call and only shuts down on failure**
  (`actual-browser.ts:79-92`). Today the UI cannot reach two successive
  successful `init`s (disconnect always shuts down first), so this is a latent
  hazard rather than a live bug — but a "Refresh"/budget-picker flow that keeps
  the engine alive across screens will make it reachable. Restructure
  `actual-browser.ts` around a single long-lived engine before adding those.
- **The demo is read-only**, so P4 (writes self-schedule a sync) never fires and
  P6's close-cancels-pending-sync hazard does not apply. Do not claim to
  demonstrate them.

---

## Part 7 — Parallel PR to `actual-api-crx-poc`

### What the PoC is today

`thromer/actual-api-crx-poc` (checked out at `actual-api-crx-poc/`). MV3, Vite 8

- rolldown, Biome, no framework — four entry points (`background`, `offscreen`,
  `options`, `popup`). Deliberately minimal, and the README says so twice.

The whole api surface it touches is `src/offscreen.ts:26-40`:

```ts
await api.init({
  dataDir: DATA_DIR,
  serverURL: config.serverURL,
  password: config.password,
});
await api.downloadBudget(config.syncId, {
  password: config.encryptionPassword,
});
const accounts = await api.getAccounts();
// finally: await api.shutdown()
```

Init-download-read-shutdown, once per button press. Config
(`serverURL`/`password`/`syncId`/`encryptionPassword`) lives in
`chrome.storage.local` (`background.ts:41-43`) — **including the password, in
cleartext**. `background.ts:6-32` owns offscreen-document creation with a
`getContexts` existence check; `offscreen.ts:61-67` routes messages by
`target === 'offscreen'`.

### What it already proves — and what that costs the plan

This PoC settles the environment questions empirically, and **falsifies one of my
claims**:

| Question                                          | Answer, per `public/manifest.json`                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does MV3's CSP block the inlined Blob-URL worker? | **No.** `worker-src 'self'` admits it. My earlier "constraint 0" was wrong, and Part 4 §5 (worker injection) is dropped as a result.                                                    |
| Can an extension page be cross-origin isolated?   | **Yes** — `cross_origin_embedder_policy` / `cross_origin_opener_policy` are MV3 manifest keys and the PoC sets both, so `SharedArrayBuffer` and the fast absurd-sql path are available. |
| Is `'wasm-unsafe-eval'` needed?                   | Yes, and it is declared.                                                                                                                                                                |
| Does `new Worker()` work in the service worker?   | No — hence `chrome.offscreen.Reason.WORKERS` (`background.ts:19-22`).                                                                                                                   |

The net effect: **nothing in the Part 4 PR is extension-specific any more.**

### The README's "help wanted" is Task 3, and the mechanism exists

> Works inconsistently with Actual servers at endpoints protected by Cloudflare
> Access. … when a pre-established authenticated session is absent, the code is
> not set up to handle the redirects required to create one.

This is a _different_ redirect problem from Actual's own OIDC (Task 3), and
loot-core already has a mechanism for it —
`packages/loot-core/src/platform/server/fetch/index.ts`, the variant the browser
build uses:

```ts
if (!options.redirect) options.redirect = 'manual';
const response = await globalThis.fetch(input, options);
if (response.type === 'opaqueredirect') {
  connection.send('api-fetch-redirected');
  throw new Error(`API request redirected`);
}
```

The web client's response is a full page reload
(`global-events.ts:177-179` → `window.Actual.reload()`), which lets the auth
proxy run its top-level redirect dance in the browser; afterwards the cookie
exists and the request succeeds. Note this is browser-only: the Node variant is
`export const fetch = globalThis.fetch` (`fetch/index.api.ts`), no detection.

Two consequences for the extension:

1. **You cannot see the event today.** `init()` returns only `{ send }`, so a
   consumer has no way to subscribe to `api-fetch-redirected` without importing
   loot-core internals. This is a sharper justification for the `listen` fix
   (Part 4 §6) than sync progress was: **without it, a browser consumer cannot
   support auth-proxied servers at all.**
2. **Reload is the wrong response for an extension.** Reloading an offscreen
   document does nothing a user can interact with. The extension equivalent is to
   open a tab at the server URL, let the user complete the proxy login, wait for
   the tab to land back on the server origin, close it, and retry.

**Why it "works inconsistently" — a hypothesis to test, not a conclusion.**
`post.ts` never sets `credentials` (verified: no occurrence in `post.ts` or the
fetch layer), so requests default to `credentials: 'same-origin'`. From an
offscreen document the origin is `chrome-extension://<id>`, so a cross-origin
request to the sync server carries **no cookies** — and an auth proxy will always 302. That predicts "never works", not "works inconsistently", so something else
is also in play; instrument `response.type` and the presence of `CF_Authorization`
before concluding. Candidate fixes, in increasing order of upstream cost:

- **Cloudflare Access service tokens** (`CF-Access-Client-Id` /
  `CF-Access-Client-Secret` headers) — the correct answer for a headless client,
  needs no cookies and no Actual change. Try this first.
- A consumer-supplied `credentials` or header hook in `InitConfig` — a real
  upstream ask, but security-sensitive (sending cookies cross-origin by default
  would be wrong), so it must be opt-in.

Also worth noting from the README: Firefox is expected not to work. Nothing here
changes that.

### Scope: a reference implementation, not a justification

The PoC has two jobs, and the second sets the bar:

1. Evidence for the Part 4 PR.
2. **The worked example an extension author copies from.** Its README already
   positions it as "one minimal way of configuring and wiring a Chrome extension
   to use `@actual-app/api`", while disclaiming being a model for _secure_ or
   _robust_ usage. Covering the full api surface is what lets it drop the second
   half of that disclaimer.

So it should exercise **every** item in the Part 4 PR, plus the extension-only
concerns no web demo can teach. Partial coverage would leave an author to invent
the missing half themselves — which is exactly how the cleartext-password pattern
in the current PoC would get copied.

### Coverage matrix — every Part 4 item gets a demonstration

| api surface                                                        | Demonstrated by                                                                                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needsBootstrap()`                                                 | Options page: enter a server URL → report reachable / bootstrapped / needs setup before asking for any credential.                                             |
| `getLoginMethods()`                                                | Same screen: render the password form _or_ the OIDC button based on what the server advertises. Closes the README's "only supports password login".            |
| `init({ serverURL })` (`StoredAuthConfig`)                         | Boot the engine before any credential exists — the precondition for signing in from the options page rather than at init time.                                 |
| `signIn({ password })` → `{ token }`                               | Password entered once; token stored; **password never persisted**. Replaces `background.ts:41-43`.                                                             |
| `signIn({ returnUrl, loginMethod: 'openid' })` → `{ redirectUrl }` | OIDC via `chrome.identity.launchWebAuthFlow`, or the Task 3 path-discriminator workaround against an unmodified server.                                        |
| `subscribe-set-token` (raw — unavoidable)                          | Consuming the token from the OIDC callback. The one raw tag a reference must still show, so document _why_ (Part 5A).                                          |
| `init({ serverURL, sessionToken })`                                | Every offscreen boot after the first, including after Chrome reclaims the document.                                                                            |
| `getUser()`                                                        | Popup header: who is signed in, their permission, and `tokenExpired` → prompt to re-auth.                                                                      |
| `getSessionToken()`                                                | Recovering the token after an `init({ password })` path, and rendering signed-in state without a round trip.                                                   |
| `signOut()`                                                        | A sign-out control that clears `chrome.storage` **and** the worker's IndexedDB copy — with UI copy saying the server session survives (`auth/app.ts:285-294`). |
| `listen('sync-event')`                                             | Live progress and typed error states during download and sync, instead of a frozen button.                                                                     |
| `listen('api-fetch-redirected')`                                   | The auth-proxy flow: open a tab at the server, let the user authenticate, close it, retry. Closes the README's Cloudflare Access item.                         |
| `getBudgets()` + `loadBudget()`                                    | A budget picker, rather than assuming one file.                                                                                                                |
| `closeBudget()`                                                    | Switching budgets without tearing down the engine — makes the two nested lifetimes (P3) visible.                                                               |
| `sync()`                                                           | A refresh control: pull-now against a live engine, no re-auth, no re-download (P5).                                                                            |
| Long-lived engine                                                  | Everything above runs against one engine held for the offscreen document's lifetime — drop `finally { api.shutdown() }` (`offscreen.ts:38-40`).                |
| `shutdown()`                                                       | Reserved for explicit stop / teardown, so the distinction from `closeBudget` is legible.                                                                       |

### …plus the extension-authoring content no web demo can carry

This is the part that makes it a reference rather than a feature tour:

- **Offscreen document lifecycle.** `background.ts:6-32` already has the
  create-once-with-`getContexts`-check pattern. A reference should also handle
  _reclamation_: detect that the document went away mid-session, recreate it,
  re-`init` from the stored token, re-`loadBudget`. This is the concrete payoff
  of keeping the token in `chrome.storage` rather than only in IndexedDB.
- **A typed message protocol.** The current routing is ad hoc — string `target`
  fields (`offscreen.ts:64`, `background.ts:70-84`) and a boolean `started`
  mutex. A reference wants a small typed request/response union and a documented
  rule about which side owns the engine.
- **Error propagation across three boundaries.** worker → offscreen → background
  → popup. `chrome.runtime.sendMessage` does not carry `Error` subclasses, so
  codes must be flattened. The PoC already does this correctly at
  `offscreen.ts:33-37` (`{ ok, code, message }`) — it should be called out as a
  pattern, and tied to the coded-error contract in Part 4 §2.
- **Manifest requirements, explained.** CSP (`script-src 'self' 'wasm-unsafe-eval'`,
  `worker-src 'self'`), COOP/COEP, `offscreen` + `storage` permissions, and the
  `host_permissions` needed to reach an arbitrary sync server. The current
  manifest has all of this and the README explains none of it — yet it is
  precisely what an author would otherwise spend a day rediscovering.
  Also worth narrowing `"host_permissions": ["*://*/*"]` to something a reference
  is comfortable recommending.
- **Token custody options**, stated honestly: `chrome.storage.local` persists and
  is readable by anyone with the profile; `chrome.storage.session` is
  memory-only. Neither is a secret store; say so.

### Suggested staging

Large enough to land in pieces, and the first stage needs nothing from upstream:

- **Stage A — restructure (no api PR dependency).** Long-lived engine, typed
  message protocol, offscreen reclamation handling, README rewrite covering the
  manifest. Independently valuable; makes every later stage small.
- **Stage B — auth.** `needsBootstrap` / `getLoginMethods` / `signIn` / token
  storage / `getUser` / `signOut`, and deleting the stored password.
- **Stage C — observability.** Both `listen` subscriptions, including the
  auth-proxy tab flow.
- **Stage D — budget lifecycle.** `getBudgets` / `loadBudget` / `closeBudget` /
  `sync`, and a popup that reads more than one thing.
- **Stage E — OIDC.** Depends on either the Task 3 allow-list PR or the
  path-discriminator workaround; sequence last since it is the only stage that
  needs a specially configured server to test.

### Relationship to the demo-app PR (Part 6)

Both now cover the full surface, and the overlap is intentional: each is the
reference for its own platform, and an author reads one, not both. The demo app
carries the general argument to a wider audience in an upstream repo; the PoC
carries the same surface plus the extension-only material above — offscreen
lifetime, `chrome.storage` token custody, manifest configuration, and the
auth-proxy redirect flow. Write the shared narrative once and adapt it, but do
not ration coverage between them.

---

## Verification

**Before writing extension code**, settle the environment questions — they
invalidate everything else if they fail:

0. ~~Blob-worker CSP check~~ — **already answered**. `actual-api-crx-poc` runs
   with `worker-src 'self'`, so the inlined worker is admitted. Nothing to test;
   copy its `manifest.json` CSP and COOP/COEP blocks verbatim as your starting
   point.
1. Assert rather than investigate: in the offscreen document (created with
   `chrome.offscreen.Reason.WORKERS`), check `self.crossOriginIsolated` at boot
   so a manifest regression fails loudly. The PoC's manifest already sets both
   headers, so this should be true; if it is not, confirm the `readIfFallback`
   path at `platform/server/sqlite/index.ts:210-214` is acceptable for your write
   volume, or reconsider the architecture.
2. Confirm `api.init({ dataDir: '/documents' })` resolves.
   `packages/api/e2e/harness.html` + `browser.test.ts:29-40` are a working
   minimal reference.

**For Task 1**, against a local sync server (`yarn start:server-dev`, port 5006):

- Sign in with a password, capture the token, tear down the offscreen document,
  re-init with `sessionToken` only, and confirm `getBudgets()` works.
- Feed a garbage `sessionToken` and confirm you get `'token-expired'` from
  `withErrorCode` — and that the worker was terminated
  (`index.browser.ts:19-23`), so your recovery path must re-init, not retry.
- Sign out, then confirm the _same_ token still validates server-side
  (`GET /account/validate`) — proof that logout is local-only.

**For Task 2**, on a single worker with `listen('sync-event', …)` attached:

- `loadBudget` → mutations → `sync()` → `send('close-budget')` → `loadBudget`
  again, confirming no reinitialisation happens in between.
- Verify P4 directly: mutate, then idle >1 s without calling `sync()`, and
  confirm a `sync-event` `start` arrives anyway (the debounce fired).
- Verify P6's hazard: mutate, then `send('close-budget')` immediately, reopen,
  and check whether the write reached the server. It should not have — that is
  `clearFullSyncTimeout()` at `budgetfiles/app.ts:266` cancelling the pending
  push, and it is the reason to sync before closing.

**For the PR** (Option C): `yarn workspace @actual-app/api test` and
`yarn workspace @actual-app/api e2e`, plus root `yarn typecheck` / `yarn test`.
