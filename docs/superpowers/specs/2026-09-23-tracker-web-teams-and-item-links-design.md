# Tracker web app, teams and shareable item links — design

Date: 2026-09-23. Status: draft for review.
Decided with Dan in tracker items #2769, #2771, #2772, #2773 and recorded
as decisions #2784 and #2788.

## Problem

Tracker items are the record of what an agent asked and what its user
decided, but they only exist inside Matron and only for one user.

- Agents write item numbers (`#12`) into GitHub issues, PR bodies and
  commit messages, where GitHub autolinks them to unrelated issues. The
  in-app link form `[#12](matron://item/12)` fares no better: GitHub strips
  every scheme except `http`, `https` and `mailto`.
- `matron://item/12` is a convention the apps' markdown renderers
  intercept. Neither the Apple nor the Android app registers `matron` as a
  system URL scheme, so the link opens nothing from outside the app.
- Item, mission and milestone numbers are a **per-user counter**
  (`item_counters`). Dan's #12 and a colleague's #12 are different rows, so
  no bare number can ever identify an item to someone else.
- Cross-user visibility was a v1 non-goal of the tracker. A journal has
  `users` but no team, and a colleague cannot see which decisions were made
  in a repo they share.

## Goals

1. Agents never leak tracker numbers onto GitHub. Ships first and
   independently (bounded change to matron-bridge).
2. Every item, mission and milestone has one **https link** that works in a
   browser anywhere, and opens the app when it is installed.
3. A **tracker web app** where a signed-in user reads and works their own
   tracker, reads their teammates', manages their account, and
   administrators manage users and teams. No chat in v1.
4. **Per-repo visibility**: an item is readable by the members of a team
   whose GitHub org owns the repo the item was filed from. Personal repos
   and conversations without a repo stay private.

## Non-goals (v1)

- Chat, a composer, or live conversation streaming in the web app. See
  "Built for chat later".
- Public or signed links readable without signing in.
- Per-item or per-mission sharing controls.
- Comments, closes or reorders by anyone but the owner (and the owner's
  agents).
- Multi-company tenancy. One journal is one installation; teams partition
  visibility within it, they do not isolate billing or admin.
- Repo hosts other than GitHub in the org mapping. The repo string is
  host-agnostic so GitLab and friends can be added by mapping later.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Item refs on GitHub (#2769) | Never `#N` or `matron://`; say it in words; the https link once it exists. |
| Link format (#2771) | https on the journal host is canonical. In-app opening via a registered `matron://` scheme; universal links optional per build. See "Why not universal links alone". |
| Web access (#2772) | A new, focused web app on the journal HTTP API. Not matron-web. |
| Visibility (#2773, #2784) | Per repo. Audience derived from the GitHub org in the remote, mapped by an admin to a journal team. |
| Chat in the web app (#2788) | Not in v1; the app is structured so a conversation view can be added. |

## Repo identity

The bridge learns a session's repo and tells the journal. Nothing else
in the design depends on local paths.

- **Canonical repo string**: `host/owner/name`, lower-cased host and owner,
  name as-is minus a trailing `.git`. `git@github.com:Matronhq/matron-journal.git`,
  `https://github.com/Matronhq/matron-journal` and `ssh://git@github.com/Matronhq/matron-journal.git`
  all become `github.com/matronhq/matron-journal`. Name case is preserved
  so the display matches GitHub; comparisons in the journal are
  case-insensitive on the whole string.
- **Bridge** (`lib/repo-identity.js`, new): on session create, resume and
  `/workdir`, run `git -C <workdir> remote get-url origin` with a 2 s
  timeout via `spawnSync`. Best effort: no git, no remote, or a timeout
  yields `null`. Never throws, never logs the workdir path to the journal.
- **Wire**: `convo_upsert` gains an optional `repo` field. Absent means
  unchanged; `null` clears; a string must match
  `^[a-z0-9.-]+/[a-z0-9_.-]+/[A-Za-z0-9_.-]+$` and be ≤ 256 chars, else
  `bad_request`. The `convo_meta` fan-out carries it so clients can show
  the repo on a conversation.
- **Journal**: `conversations.repo TEXT` (nullable), index on
  `lower(repo)`.

Items, missions and milestones do not store a repo. Their repo is the
repo of the conversation they came from, resolved at query time:

- item → `conversations.repo` via `origin_convo_id`
- milestone → `conversations.repo` via `convo_id`
- mission → the set of repos of its `origin_convo_id` plus every joined
  conversation; a mission is visible if any of them is.

A conversation's repo can change (the user switches workdir). Visibility
follows the current value; that is the rule that is cheapest and easiest
to explain.

## Teams (matron-journal)

### Data model (`src/db.js`)

```
CREATE TABLE IF NOT EXISTS teams(
  id          TEXT PRIMARY KEY,           -- 'tm_' + 16 hex
  name        TEXT NOT NULL UNIQUE,       -- ≤ 64 chars, shown in the UI
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members(
  team_id   TEXT NOT NULL REFERENCES teams(id),
  user_id   INTEGER NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL CHECK(role IN ('admin','member')),
  added_at  INTEGER NOT NULL,
  PRIMARY KEY(team_id, user_id)
);
CREATE TABLE IF NOT EXISTS team_orgs(
  team_id   TEXT NOT NULL REFERENCES teams(id),
  host      TEXT NOT NULL,                -- 'github.com'
  owner     TEXT NOT NULL,                -- 'matronhq' (lower-cased)
  added_at  INTEGER NOT NULL,
  PRIMARY KEY(host, owner)                -- one org maps to one team
);
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
```

Roles:

- **Journal admin** (`users.is_admin`): creates users, teams, and org
  mappings; adds the first admin to a team. Bootstrapped from the CLI:
  `matron-admin user admin <name> on|off`. A journal with no admin behaves
  exactly as today.
- **Team admin**: adds and removes members and org mappings of their team.
- **Member**: reads.

### Visibility rule

`canRead(viewer, row)` for an item, mission, milestone or conversation
excerpt, where `owner` is the row's `user_id`:

1. `viewer.userId === owner` → yes (unchanged from today).
2. Otherwise the row's repo `R` must be non-null, and there must exist a
   team `T` such that **both** viewer and owner are members of `T` and
   `(host(R), owner(R))` is in `team_orgs` for `T`.
3. Rows whose origin conversation is owned by a **private device** are
   never cross-user visible, regardless of team. The existing privacy sieve
   (`src/privacy.js`) runs first.

Requiring the owner to be a team member too is deliberate: a user who has
a checkout of a team's repo but is not in the team neither sees the team's
items nor exposes their own. A user in no team is fully private.

Agent callers get the read visibility of their owning user, so an agent
can answer "what did Dan decide about X" from a colleague's items. Writes
remain owner-only for users and agents alike.

The predicate lives in one place, `src/visibility.js`, and is the only
copy: `/items*`, `/missions*`, `/milestones*`, `/lookup` and the excerpt
read all call it, following the `privacy.js` precedent of a single shared
sieve.

### HTTP API changes (`src/http.js`, `src/items-http.js`, `src/missions-http.js`, new `src/teams-http.js`)

Reads that widen:

- `GET /items?scope=mine|team` (default `mine`, today's behaviour).
  `team` returns every item visible under the rule, with `owner: {user_id,
  name}` on each row and `repo` where known. Existing filters apply.
- `GET /missions?scope=mine|team`, same shape.
- `GET /items/:id`, `GET /missions/:id`, `GET /missions/:id/milestones` on
  a visible foreign row return it with `owner` and `repo`. An invisible
  row is `404 not_found` (anti-enumeration, as today).
- Writes to a visible foreign row (`comment`, `close`, `reopen`, `rank`,
  `PATCH`) are `403 forbidden`. Visible-but-not-yours is safe to
  distinguish from does-not-exist because the caller can already read it.
- `GET /lookup?user=<name>&num=<n>` → `{kind: 'item'|'mission'|'milestone',
  id}` for a visible row, else `404`. Numbers come from the shared per-user
  counter, so one lookup resolves all three kinds.
- `GET /convo/:id/messages?around_seq=&limit=` gains the same team rule for
  a **foreign user's** conversation: allowed when the conversation's repo is
  visible to the viewer and the conversation is not private-owned. Prose
  only (`text`, `diff`), `limit` clamped to 30, logged server-side, exactly
  as the existing foreign-device read. This is what the milestone excerpt
  view uses.
- `GET /me` → `{user: {id, name, is_admin}, teams: [{id, name, role, orgs:
  [{host, owner}]}]}`.

Team administration (journal admin, or team admin for their own team):

- `GET /teams`, `POST /teams {name}`, `PATCH /teams/:id {name}`,
  `DELETE /teams/:id` (admin only; refuses with `409` while members remain).
- `PUT /teams/:id/members/:user_id {role}`, `DELETE /teams/:id/members/:user_id`.
- `PUT /teams/:id/orgs {host, owner}`, `DELETE /teams/:id/orgs/:host/:owner`.
  `409 conflict` if the org is already mapped to another team.

User administration (journal admin), mirroring `matron-admin`:

- `GET /users`, `POST /users {name, password}`, `POST /users/:id/password {password}`,
  `PATCH /users/:id {is_admin}`.
- `POST /users/:id/link-code {expires}` → the same payload `matron-admin
  link-code` produces, so the web app can show the pairing QR for a new
  colleague's phone.

Self-service (any user), reusing existing helpers where routes are
missing: `GET /devices`, `DELETE /devices/:id`, `PATCH /devices/:id {name}`,
`POST /me/password {old, new}`.

All new routes follow `http-who.js` conventions, bear the existing
Bearer auth, and reuse the `/login` rate limiter for password changes.

### Item links and the lookup URL

Canonical link: `https://<journal-host>/u/<username>/<num>`.

- Short, one form for all three kinds, and the username makes the per-user
  number unambiguous.
- The journal serves the web app for `/u/*`, which calls `/lookup` and
  routes to the item, mission or milestone page.
- The journal also answers `GET /u/<user>/<num>` with `Accept:
  application/json` by returning the lookup result, so tools can resolve
  a pasted link without loading the app.

### Static hosting

`MATRON_WEB_DIR` (env, unset today → nothing changes). When set, the
journal serves that directory read-only: exact files for assets, and the
directory's `index.html` for `/u/*` and `/app/*` (history fallback). Same
origin as the API, so no CORS is introduced. Cloudflare in front caches
assets by the content hashes in their filenames.

`GET /.well-known/apple-app-site-association` and
`GET /.well-known/assetlinks.json` are served from env
(`MATRON_APPLE_APP_IDS`, `MATRON_ANDROID_CERT_SHA256`) when those are set,
claiming `/u/*`. Unset → `404`. See "Why not universal links alone".

### Marker events

Unchanged. Foreign rows are read through HTTP, never replayed into another
user's journal; the WebSocket stays a per-user stream. The web app
refreshes a team view on its own `item`/`mission` markers and on a 60 s
poll when a team view is open.

## Bridge changes (matron-bridge)

1. **Guidance** (`BRIDGE_CLAUDE.md`, `BRIDGE_CODEX.md`), the bounded change
   from #2769, shipped ahead of everything else:

   > Tracker item numbers are per-user and mean nothing outside Matron. In
   > anything that leaves Matron (GitHub issues, PR titles and bodies,
   > commit messages, code comments, external docs) never write a tracker
   > item as `#N`, `item #N`, or a `matron://` link. Say what was decided in
   > words. If a GitHub issue or PR exists for the same work, attach it to
   > the item with `links` so the connection lives on the Matron side.

   Once the journal serves links, the bridge appends the user's own link
   prefix to the instructions it renders (`Your shareable item link form is
   https://<journal>/u/<name>/<num>`), and the rule gains: "the https item
   link is the one form allowed outside Matron". The bridge knows both the
   journal base URL and the user name already.
2. **Repo reporting**: `lib/repo-identity.js` plus the `repo` field on
   `upsertConvo` in `lib/journal-publisher.js`, called from session create,
   resume and `/workdir` in `index.js`.
3. **Tools**: `item_list` and `mission_get` accept `scope: 'team'`;
   `item_get` and `item_comment` accept `dan#12` and a pasted https link as
   the id; list output shows the owner on foreign rows. In-chat references
   to a colleague's item render as `[dan#12](https://…/u/dan/12)`. Own
   items keep `[#12](matron://item/12)` in chat for v1 so existing clients
   need no change to keep working; switching chat to the https form is a
   follow-up once every app handles it.

## Apps (matron-apple, matron-android)

- **Register the `matron` URL scheme** with the OS (`CFBundleURLTypes`,
  an `intent-filter` with `android:scheme="matron"`). Handle
  `matron://open?v=1&server=<url-encoded base>&user=<name>&num=<n>`:
  if the app is signed into that server, open the row (existing item and
  mission detail hosts, via `/lookup`); otherwise show "not signed in to
  <host>". The existing `matron://link?…` pairing URL rides the same
  registration.
- **Handle the https form** the same way, both from the OS (universal /
  app links, when a build configures them) and inside message bodies:
  the markdown link handlers that already catch `matron://item/<n>` also
  catch `https://<this server>/u/<user>/<num>`.
- **Associated domains are per build, optional.** `project.yml` and
  `build.gradle` read the journal host from a build setting
  (`MATRON_LINK_HOSTS`); a build without it simply has no universal links
  and relies on the scheme.

### Why not universal links alone

Universal Links and App Links require the domain to be baked into the
app at build time and a site-association file on that domain. Matron is
self-hosted, so the App Store build cannot know every journal's host. The
scheme works for any host; universal links are a per-deployment upgrade
for installations that build their own apps. The web app's item page
therefore shows an **Open in Matron** button that launches the scheme
URL, and on iOS and Android tries it automatically once per page load.

This corrects the closing note on #2771, which said the scheme would stay
an in-app convention only. It has to be registered for the "opens the app"
goal to hold on an arbitrary host.

## Web app (new repo)

Proposed name `matron-tracker`; the name is Dan's call.

### Stack

TypeScript, React, Vite, no server of its own. Output is a static
directory the journal serves (`MATRON_WEB_DIR`). React because matron-web
is React, so nothing new to learn. No
component framework beyond a small shared set; the design follows the
apps' tracker panel (list, detail, thread) so the three surfaces read as
one product.

Auth: `POST /login` with `device_name: 'web (<browser>)'`; the returned
client-device token is kept in `localStorage` and sent as Bearer. Sign
out revokes the device. The account page lists it alongside phones and
Macs, so a forgotten browser can be revoked from anywhere.

### Structure (the "built for chat later" shape)

```
src/
  api/            JournalClient: HTTP + WebSocket, token, cursor replay
  model/          items, missions, milestones, teams, conversations
  features/
    tracker/      my list, team list, item detail, thread, compose comment
    missions/     mission list, mission page, milestone list
    excerpt/      read-only conversation excerpt around a seq
    account/      devices, password, pairing QR
    admin/        users, teams, members, org mappings
    conversation/ RESERVED: route /c/:id, renders excerpt today
  routes.tsx      /u/:user/:num, /items, /team, /missions/:id, /c/:id, /account, /admin
```

`JournalClient` speaks the same WebSocket `hello` the apps use, with a
cursor, so the app already receives the user's live event stream. v1
consumes only `item` and `mission` markers from it. Adding chat later is a
`features/conversation` implementation over the same client and the same
event types, not a second data layer.

### Screens

- **Sign in.** Username, password, server is the page's own origin.
- **My tracker.** Three groups, like the apps: awaiting me, awaiting
  agent (tasks in rank order), decisions in force. Closed items behind a
  toggle. Drag to reorder posts `rank`.
- **Team.** Every visible item from teammates, grouped by repo then owner,
  with kind/state/awaiting filters and a search box (client-side over the
  loaded page; server search is a follow-up).
- **Item.** Title, body, labels, links, thread with attachments inline,
  voice-note transcripts as text. Owner: comment, close with resolution,
  reopen, edit. Teammate: read only, with a visible "owned by Dan" line.
  Origin: "filed from <conversation title>" linking to the excerpt.
- **Mission.** Body, milestones newest first (each opens its excerpt),
  open items, conversations. Owner can close with a summary; refuses over
  open items exactly as the API does.
- **Excerpt.** The messages around a milestone's `seq`, prose only, with
  "Open full conversation in matron-web" when a matron-web URL is
  configured (`MATRON_WEB_CHAT_URL`, optional).
- **Account.** Devices (rename, revoke), change password, "pair a phone"
  QR via the link-code route.
- **Admin.** Users (create, reset password, admin flag), teams (create,
  members with roles, org mappings). Team admins see only their team.

### Open in Matron

Every item, mission and milestone page shows the button described under
the apps section. The page's own URL is the shareable link; a copy button
puts it on the clipboard.

## Error handling

- Journal: every new route returns the existing shapes (`bad_request`,
  `not_found`, `forbidden`, `conflict`, `rate_limited`). Invisible rows are
  `404`, never `403`.
- Repo detection in the bridge never fails a session start: any error is
  `repo: null` and a debug log line.
- Web app: `401` anywhere drops the token and returns to sign-in with the
  intended route preserved. `403` on a foreign row renders the read-only
  view with the action bar hidden, never a dead end.
- Lookup of an unknown or invisible link shows "no such item, or you
  cannot see it", the same message for both.

## Security notes

- Anti-enumeration is preserved: invisible rows and unknown users answer
  `404` identically. `/lookup` rate-limits per device like `/search`.
- Private devices stay private across teams. The sieve runs before the
  team rule and a test pins the order.
- Foreign excerpt reads are prose-only, capped at 30 and logged with viewer
  and conversation ids, matching the existing foreign-device rule.
- The repo string is validated server-side; it is peer text like a title
  and passes the same control-character sanitiser.
- Static serving is read-only, rejects path traversal, and serves nothing
  unless `MATRON_WEB_DIR` is set.
- The well-known files are served only when configured, so a journal
  without app builds claims nothing.

## Testing

- **Journal**: schema migration on a populated DB; visibility predicate
  table-driven (owner, teammate with org, teammate without org, non-member
  with checkout, private-owned origin, no repo, mission with mixed repos);
  route tests for scope=team, foreign read/write status codes, lookup,
  foreign excerpt cap and logging, teams and users admin authorisation,
  static fallback and traversal, well-known on/off.
- **Bridge**: `repo-identity` normalisation table (ssh, https, ssh://,
  no `.git`, no remote, timeout); `convo_upsert` carries `repo` on create,
  resume, `/workdir`; guidance text present in both prompt files; tool id
  parsing for `dan#12` and links.
- **Web app**: unit tests on the client and models; component tests for
  the item page in owner and teammate modes; one end-to-end run against a
  journal started from `test/` fixtures (sign in, open a link, comment,
  admin creates a team and a mapping, teammate sees the item).
- **Apps**: link-handler unit tests for the scheme and https forms; the
  existing snapshot tests for item links extended with the https form.

## Rollout

Each step below is its own implementation plan in its own repo; the
steps share this spec, not a plan.

1. **matron-bridge guidance** (#2769). Independent, ships now.
2. **matron-journal**: `repo` on conversations, teams, visibility, lookup,
   admin routes, static hosting, well-known. Behind nothing: a journal
   with no teams and no `MATRON_WEB_DIR` is unchanged.
3. **matron-bridge**: repo reporting, tool scopes, link prefix in the
   instructions. Old journals ignore unknown `convo_upsert` fields, so
   this can deploy before or after step 2.
4. **matron-tracker** web app, deployed by setting `MATRON_WEB_DIR` on the
   journal host.
5. **Apps**: scheme registration and https link handling, then optional
   associated domains for installations that build their own.
