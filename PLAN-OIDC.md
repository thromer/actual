# OIDC login for `@actual-app/api` consumers

Builds on `PLAN-LIGHT.md`, which exposes `signIn` and `getSessionToken`. That
document is deliberately scoped to password auth; everything OIDC additionally
needs is specified here, including the parts of the auth surface that only OIDC
makes load-bearing. This document covers the three consumer shapes separately
because they hit different constraints.

**But nothing here has to wait on that.** Every open question below is about the
sync server, not the api package, and the api already has the one piece needed to
close the loop — `init({ serverURL, sessionToken })` works today. So the whole
design can be de-risked first, with no changes to either package. Do that before
writing code; if the server behaves differently than this document reads it, that
lands before anything is built on top.

---

## Phase 0 — answer the open questions with curl

Needs a sync server with OIDC configured and at least one named user (otherwise
`openid.ts:113-127` demands the server password on first login — pass it as
`password` if you are testing against a fresh instance).

Every case below is one request:

```bash
curl -sS -X POST "$SERVER/account/login" \
  -H 'Content-Type: application/json' \
  -d '{"loginMethod":"openid","returnUrl":"'"$RETURN_URL"'"}'
```

Success is `{"status":"ok","data":{"returnUrl":"<provider authorization URL>"}}`;
rejection is HTTP 400 `{"status":"error","reason":"Invalid redirect URL"}` from
`app-account.js:98-103`.

| `RETURN_URL`                  | Expected     | Establishes                                                            |
| ----------------------------- | ------------ | ---------------------------------------------------------------------- |
| `https://example.invalid`     | rejected     | the foreign-origin rejection this document's consumer-2 claim rests on |
| `http://localhost:9999`       | accepted     | the carve-out the CLI flow depends on                                  |
| `http://127.0.0.1:9999`       | **rejected** | the compare is a literal string, not an address resolution             |
| `$SERVER/__actual-ext`        | accepted     | hostname-only checking — the entire basis of the extension workaround  |
| `$SERVER` on a different port | accepted     | confirms port is not compared, if you care                             |

Then the other half of the extension claim, which needs no auth at all — just
load this in a browser:

```
$SERVER/__actual-ext/openid-cb?token=not-a-real-token
```

Expected: the served SPA falls through its catch-all to `/bootstrap` and
`OpenIdCallback` never runs, leaving no `user-token` in that origin's IndexedDB
(check DevTools → Application → IndexedDB). Compare against
`$SERVER/openid-cb?token=not-a-real-token`, where the route _does_ match
(`ManagementApp.tsx:189`) and the token is consumed. If both behave the same, the
nested-path reasoning in consumer 3 is wrong and that section needs rework.

## Phase 1 — prove the end-to-end path, ~30 throwaway lines

Runs the real flow with **no changes to either package**, using the api exactly
as it ships:

```js
// 1. loopback listener — the server appends /openid-cb to your returnUrl
const tokenPromise = new Promise(resolve => {
  http
    .createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:9999');
      if (url.pathname === '/openid-cb') {
        res.end('You can close this tab.');
        resolve(url.searchParams.get('token'));
      }
    })
    .listen(9999);
});

// 2. ask the server where to send the user
const { data } = await fetch(`${SERVER}/account/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    loginMethod: 'openid',
    returnUrl: 'http://localhost:9999',
  }),
}).then(r => r.json());

// 3. open data.returnUrl in a browser, authenticate, and wait
const token = await tokenPromise; // 300s budget — openid.ts:156

// 4. the payoff: this already works today
await api.init({ serverURL: SERVER, dataDir: DATA_DIR, sessionToken: token });
await api.downloadBudget(SYNC_ID);
console.log(await api.getAccounts());
```

If step 4 succeeds, the entire premise is proven: an OIDC login can produce a
token that drives a headless api consumer. Everything in `PLAN-LIGHT.md` and the
rest of this document is then about making that ergonomic and supported — not
about whether it is possible.

Assert one more thing while you are here, since the CLI's `login --openid` gates
on it and phase 0 cannot tell you: that an **OIDC-minted** token validates the
same as a password-minted one.

```bash
curl -sS "$SERVER/account/validate" -H "X-ACTUAL-TOKEN: $TOKEN"
```

Expect `{"status":"ok","data":{"validated":true,…}}` with the OIDC identity in
`userName` / `loginMethod`. Same endpoint either way, so it should — but the flow
depends on it.

## Phase 2 — only if the flow should live inside the api

The critical path is `PLAN-LIGHT.md`'s `signIn` (widened to the openid variant)
plus four additions specified in the next section: `StoredAuthConfig`,
`setToken`, `getUser`, `getLoginMethods`. Not on the critical path:
`getSessionToken` and `signOut` from `PLAN-LIGHT.md`.

---

## The flow the web app runs

1. `send('subscribe-sign-in', { returnUrl, loginMethod: 'openid', password: firstLoginPassword })`
   — `desktop-client/src/components/manager/subscribe/Login.tsx:126-144`.
2. `auth/app.ts:273-275` returns `{ redirectUrl }` — the **provider's**
   authorization URL — and stores no token.
3. The browser navigates there. The provider redirects to
   `{server}/openid/callback`; the server exchanges the code, mints a session,
   and 302s to `` `${return_url}/openid-cb?token=${token}` ``
   (`sync-server/src/accounts/openid.ts:336`).
4. `OpenIdCallback.ts:17-25` reads `?token=` and calls
   `send('subscribe-set-token', { token })`.

Note the naming inversion: the client's `returnUrl` (its own origin) goes up; the
server's response field is also called `returnUrl` but carries the provider
authorization URL, which the client stores as `redirectUrl`.

**The provider never sees the consumer's URL.** `setupOpenIdClient`
(`openid.ts:88-96`) hardcodes the provider-facing redirect URI as
`new URL('/openid/callback', server_hostname)`. `returnUrl` is Actual's own
second hop, applied after the code exchange. So a provider's redirect-URI policy
does not constrain any of this.

## The constraint everything else follows from

`isValidRedirectUrl` (`openid.ts:359-381`) accepts a `returnUrl` only if its
hostname equals the configured `server_hostname` or is literally `localhost`:

```ts
if (
  redirectUrl.hostname === serverUrl.hostname ||
  redirectUrl.hostname === 'localhost'
) {
  return true;
}
```

Enforced twice — `app-account.js:98` before setup, `app-openid.ts:107` before the
final redirect. It compares **hostname only**: not path, not port, not scheme.
`127.0.0.1` fails; `localhost` passes.

Also relevant: the pending request expires after 300 s (`openid.ts:156`), and
`openid.ts:113-127` requires the server password on the _first_ OIDC login when
no named users exist yet.

## Required api additions

Four beyond `PLAN-LIGHT.md`. Each is load-bearing _only_ for OIDC, which is why
they live here — the password flow in `PLAN-LIGHT.md` needs none of them.

### `setToken`

```ts
'api/set-token': (arg: { token: string }) => Promise<void>;
```

```ts
export async function setToken(token: string) {
  return send('api/set-token', { token });
}
```

Whoever receives the redirect has to inject the token. Delegates to
`subscribe-set-token` (`auth/app.ts:296-298`). With this exposed, no raw message
tag remains in the auth path.

### `StoredAuthConfig` — credential-free init

```ts
type StoredAuthConfig = ServerInitConfig & {
  password?: never;
  sessionToken?: never;
};

export type InitConfig =
  | PasswordAuthConfig
  | SessionTokenAuthConfig
  | StoredAuthConfig // new
  | NoServerConfig;
```

No runtime change — `main.ts:289-327` already falls through both auth branches.

The password flow never needs this: it initialises with a token, and on rejection
re-initialises with a password. OIDC has no such fallback — the consumer must
boot the engine to call `signIn`, and the credential only exists after the
round trip. This is the item that makes `actual login --openid` possible at all.

### `getUser`

```ts
'api/get-user': () => Promise<Awaited<ReturnType<AuthHandlers['subscribe-get-user']>>>;
```

Validates a freshly minted token before a consumer stores or prints it. Under
password auth this is near-useless — `password.js:113` creates the user with
`user_name = ''` and `display_name = ''`, and `/account/validate` echoes those
back (`app-account.js:199-206`), so there is no identity to report. Under OIDC
every login is a distinct identity, so `userName` / `displayName` /
`loginMethod` are real.

### `getLoginMethods`

```ts
'api/get-login-methods': () => Promise<Awaited<ReturnType<AuthHandlers['subscribe-get-login-methods']>>>;
```

A password-only consumer can assume password auth and let `init` fail loudly. A
consumer that may face either has to ask, or it will show a password box to
someone whose server accepts only OIDC. That question only arises once OIDC is in
play.

`signIn`'s signature also widens to the union the handler already accepts:

```ts
'api/sign-in': (arg: { password: string; loginMethod?: string }
              | { returnUrl: string; loginMethod: 'openid'; password?: string })
              => Promise<{ token?: string; redirectUrl?: string }>;
```

---

## Consumer 1: `packages/cli` — works today, no server change

A CLI can bind a socket, so the `localhost` carve-out — which exists for
Electron's loopback server (`desktop-electron/index.ts:93-134`) — applies
directly.

```
actual login --openid
  1. api.init({ serverURL })                      // credential-free init
  2. listen on http://localhost:<port>
  3. { redirectUrl } = api.signIn({ returnUrl: `http://localhost:${port}`,
                                    loginMethod: 'openid' })
  4. open the browser at redirectUrl
  5. loopback receives GET /openid-cb?token=…
  6. api.setToken(token); api.getUser()           // validate before emitting
  7. print it, or write it to the chosen config file
```

The server appends `/openid-cb` to the `returnUrl`, so the loopback must route
that path.

**Headless/SSH is the real limitation** — the browser is on the operator's
laptop, the loopback on the remote host. Actual has no device-code flow, so this
needs SSH port-forwarding or a paste-the-callback-URL fallback.

## Consumer 2: browser apps not served by the sync server

`Login.tsx:127-131` sends `window.location.origin`, and `isValidRedirectUrl`
compares it against the OIDC config's `server_hostname`. Those match **only when
the client is served by the sync server** — an assumption that holds for the web
app and for nothing else Actual ships.

Each other client has so far needed a bespoke exemption:

| Client             | Origin                        | How it copes                                                                              |
| ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------- |
| Web app            | served by the sync server     | matches `server_hostname`                                                                 |
| Electron desktop   | `app://actual`                | loopback server on port 3010 (`desktop-electron/index.ts:93-134`) → `localhost` carve-out |
| CLI                | none                          | same `localhost` carve-out (consumer 1)                                                   |
| `browser-app-demo` | its own static-hosting domain | **no path — cannot offer OIDC**                                                           |
| Chrome extension   | `chrome-extension://<id>`     | none (consumer 3)                                                                         |

`browser-app-demo` is the case worth citing: an official actualbudget project,
deployed as a static site that the user points at their own sync server, so it is
inherently a different origin. It supports password auth only.

**Confirm before citing.** This is traced from code, not reproduced — it is the
first row of the phase 0 table above. Run that, and confirm the demo therefore
cannot complete an OIDC login.

Self-hosters running the web client split-origin would hit the same wall, but
that deployment is undocumented — `packages/docs/docs/config/reverse-proxies.md`
only covers proxying to a single instance — so treat it as a corollary, not the
argument. The argument is that the origin check generalizes badly to every
non-web client, which the `localhost` carve-out already concedes.

## Consumer 3: Chrome extensions

Neither `chrome-extension://<id>/…` (hostname is the extension id) nor
`https://<id>.chromiumapp.org/` passes the hostname test, and an extension cannot
open a listening socket.

**Workaround, no server change.** Since only the hostname is checked, carry a
discriminator in the path:

```ts
await api.signIn({
  returnUrl: `${serverURL}/__actual-ext`, // passes the hostname check
  loginMethod: 'openid',
});
// server's second hop: {server}/__actual-ext/openid-cb?token=…
```

Then a content script at `document_start` matching
`{server}/__actual-ext/openid-cb*` reads the token, calls `window.stop()`, and
messages it back; the extension calls `api.setToken(token)` and closes the tab.
Requires `host_permissions` for the server origin.

The nested path is load-bearing, not cosmetic. The callback URL carries only the
token — no `state`, no nonce — so a script matching bare `/openid-cb*` cannot
distinguish the extension's login from a user's real web-app login in another
tab, and its `window.stop()` would break the web app.

It also keeps the served SPA from consuming the token. The sync server has an SPA
catch-all (`app.ts:175-177`), so the web client does load at the nested path —
but its router only registers `<Route path="/openid-cb">` at the root
(`ManagementApp.tsx:189`), so `/__actual-ext/openid-cb` falls through to
`/bootstrap` and `OpenIdCallback` never runs. At the root path you would instead
mint a parallel logged-in session in the server origin's IndexedDB.

## Proposed sync-server change: redirect-origin allow-list

Add a config key alongside `openId.server_hostname` — e.g.
`ACTUAL_OPENID_ALLOWED_REDIRECT_ORIGINS` — that `isValidRedirectUrl` also
accepts.

- Generalizes the exemption the `localhost` carve-out already grants Electron
  and the CLI, so a browser client not served by the sync server —
  `browser-app-demo` today — can offer OIDC. Lead with that, not with
  split-origin self-hosting.
- Lets an operator opt in `https://<id>.chromiumapp.org`, pairing with
  `chrome.identity.launchWebAuthFlow`: `chromiumapp.org` does not resolve, so
  Chrome intercepts the navigation and hands back the URL without fetching it —
  the same shape as the existing `localhost` carve-out.
- **Do not allow-list `chrome-extension://`.** Chrome blocks server-initiated
  navigation to extension URLs, so the 302 would die.

This modifies an auth boundary. Propose it as its own PR, separately from the api
package work, and not bundled with the `PLAN-LIGHT.md` changes.

## Token lifetime

`token_expiration` defaults to `'never'` (`load-config.js:258-263`), and the
`tokenExpiration` format coerces to exactly `'never' | 'openid-provider' | number`.
So a token written into a config file keeps working unless the operator
configured otherwise. Under `'openid-provider'` it inherits the provider's
expiry, and a consumer should expect `getUser()` to report `tokenExpired` and
re-run the flow.

Unlike password auth — where every login reuses one shared `sessions` row
(`password.js:98-103`) — each OIDC login mints a fresh uuid
(`openid.ts:315-332`), so tokens really are per-client here.

## Verification

Phases 0 and 1 already cover the server's behaviour and the end-to-end path;
`packages/sync-server/src/app-openid.test.ts` and `app-account.test.js` document
the wire shapes. What remains, once the flow lives in the api:

- The CLI loopback flow end to end via `api.signIn`/`api.setToken`, with
  `getUser()` returning the expected OIDC identity — i.e. phase 1 rerun through
  the supported surface rather than raw `fetch`.
- For the allow-list PR: the regression test is a client on a foreign origin
  completing an OIDC login — `browser-app-demo` pointed at a sync server on a
  different hostname.
