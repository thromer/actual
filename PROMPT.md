I am researching the code base for Actual to refine the source code
for a chrome extension that lives in a separate package. I will not be
making changes here. The extension interacts with the Actual server
through the api package (packages/api) which is essentially a wrapper
around methods in packages/loot-core (imported as
actual-app/core/*). My extension will emulate the auth process and the
backend connection lifecycle of the web server provided by Actual.

I want your output to be explanations with code pointers and possibly
code snippets, not complete code. If you need assistance along the
way, ask me.

I am interested in doing the following in the same way as the web server,
in order. Tackle the first, first; keep the others in mind as you
explore the code base.

1. Use a user-provided password only once, to obtain and persist
   user-token; and use that token for future auth rounds when calling
   api.init. Also support logout.
2. Maintain a long-lived the worker+absurdql instance and perform
   multiple operations against it, with explicit sync operations and
   explicit close.
3. Handle redirects through auth layers e.g. OIDC / openid (mostly)
   transparently.

I believe most of the relevant code for the web server is also in the
loot-core package, but you may have to also look in the desktop-client
package (which is a web app, not a desktop app). You can confirm this
by working backwards from the signIn method in task 1. Most of the
code in desktop-client is irrelevant.

Note that clients communicate with the server via message passing, so
you cannot find a callee just by grepping for the method name; you
have to find the message tag. For example, IIUC
@packages/loot-core/src/server/auth/app.ts exposes signOut via the
subscribe-sign-out message tag.

I am not concerned about managing multiple simultaneous instances of
the extension (as the web server does with its leader/follower
architecture).
