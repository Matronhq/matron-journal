# QR device-link login — design

**Date:** 2026-07-18
**Repos:** matron-journal (server), matron-apple, matron-android
**Status:** approved design, pending implementation plan

## Problem

Signing in on a new device requires typing the server URL, username, and password.
The password is long and effectively untypeable on a phone keyboard. A logged-in
device should be able to sign a new device in: the logged-in device shows a QR
code, the new device scans it with the camera, the logged-in device confirms with
one tap, and the new device is signed in — nothing typed on the new device.

## Decisions already made (with the user)

- **Symmetric:** every platform gets both roles — show-QR (when signed in) and
  scan-QR (when signing in). Mac is show-only for the camera path but gets the
  manual-code fallback for signing in.
- **Confirm tap required:** scanning alone never signs a device in. The showing
  device displays who is asking (device name + IP) and the user must tap Approve.
  A photographed QR is useless without that tap.
- **Mechanism:** a new server-mediated `/link/*` flow modeled on the existing
  `/pair/*` agent-enrollment flow (approach 1). Rejected alternatives: overloading
  `/pair/*` with a `device_kind` parameter (flow direction is backwards — in
  pairing the *unauthenticated* side starts; here the *signed-in* side starts),
  and putting the existing device's bearer token in the QR (shared device
  identity, broken revocation, long-lived credential on screen).

## Terms

- **Starter** — the signed-in device that starts the link and shows the QR.
- **Claimant** — the new device that scans (or types) the code and ends up signed in.
- **Link session** — the server-side in-memory record tying the two together.

## 1. Server (matron-journal)

New module `src/link.js` exporting `makeLinkStore(...)`, alongside and closely
modeled on `src/pairing.js` (`makePairStore`): in-memory Map, sweep-on-touch
expiry, Crockford codes via the same 30-char alphabet/`normalizeCode`, 256-bit
hex claim tokens, bounded pending set. Wired into `src/http.js` next to the
`/pair/*` handlers with the same conventions (anti-enumeration 404s, shared
per-IP limiter on the unauthenticated surface, `cf-connecting-ip` fallback
chain for requester IP).

### Link session record

```
{ code,             // 8-char normalized Crockford code (display: XXXX-XXXX)
  userId,           // starter's user — bound at start, never changes
  starterDeviceId,  // only this device may status/approve/deny
  status,           // 'waiting' | 'claimed' | 'approved' | 'denied'
  claimToken,       // 256-bit hex, set at claim
  deviceName,       // claimant-supplied, set at claim
  requesterIp,      // claimant IP, set at claim
  expiresAt }
```

Store rules:

- TTL **120 s** from start. On a successful claim, `expiresAt` extends to
  `max(remaining, now + 60 s)` so a last-second scan still leaves time for the
  approve tap.
- **One active session per starter device**: a new `/link/start` from the same
  device replaces (deletes) its previous session.
- Global pending cap 64 (same envelope as pairing; hitting it returns the same
  `rate_limited` shape as the limiter).
- First claim wins; a claim on an already-claimed session is rejected.
- Sessions are one-shot: the approved identity is deleted before the claimant
  sees the token (mirror of `pairs.claim`). A `denied` session is kept until the
  claimant observes it once via poll (or TTL), then deleted, so the claimant can
  distinguish "denied" from "expired".

### Endpoints

All request/response bodies JSON, matching existing conventions.

| Endpoint | Auth | Request | Responses |
|---|---|---|---|
| `POST /link/start` | Bearer, `kind='client'` only | `{}` | `200 {link_code: "XXXX-XXXX", expires_in}` · `429 rate_limited` (cap) |
| `POST /link/claim` | none (per-IP rate limited, shared limiter instance with `/login` + `/pair/start`) | `{link_code, device_name}` | `200 {status:'claimed', claim_token, expires_in}` · `404 not_found` (unknown/expired merged) · `409 conflict` (already claimed) · `400 bad_request` · `429 rate_limited` |
| `POST /link/poll` | none (not rate-limited — Map lookup on a 256-bit key, same stance as `/pair/claim`) | `{claim_token}` | `200 {status:'pending'}` · `200 {status:'approved', token, device_id, user_id, username}` · `200 {status:'denied'}` (once, then session deleted) · `404 not_found` (unknown/expired) |
| `POST /link/status` | Bearer, must be the starter device of its active session | `{}` | `200 {status:'waiting', expires_in}` · `200 {status:'claimed', device_name, requester_ip, expires_in}` · `404 not_found` (no active session / expired) |
| `POST /link/approve` | Bearer, starter device only | `{link_code}` (must match the device's active session — belt-and-braces intent check) | `200 {status:'approved'}` · `404 not_found` · `409 conflict` (not in `claimed` state — nothing to approve yet, or already resolved) |
| `POST /link/deny` | Bearer, starter device only | `{link_code}` | `200 {status:'denied'}` · `404 not_found` |

Minting: on the first `/link/poll` after approval, the server mints a
**`kind='client'`** device via the same issuance path `/login` uses
(`issueDevice`-equivalent in `src/auth.js`, `device_name` = claimant-supplied
name), deletes the session, and returns `{token, device_id, user_id, username}`.
`username` is required in the response: both apps store the typed username as
`UserSession.userID`, and a link-login claimant never types one — the server
looks it up from the users table by the session's `userId`.

Validation: `device_name` required non-empty string, trimmed, max 64 chars
(same bound as `/login`'s `device_name` handling). `link_code` accepted in any
typed variation via `normalizeCode`.

Sign-out interaction: link sessions die with their starter's token — `/link/*`
starter endpoints 401 once the device is revoked, and an unapproved session
just expires. No extra cleanup hook needed (sessions are in-memory, ≤120 s, and
approval requires a *live* starter token at tap time).

Docs: add a "Device link (QR sign-in)" section to `docs/protocol.md` beside the
pairing section, documenting the table above.

## 2. QR payload

```
matron://link?v=1&server=<URL-encoded base server URL>&code=XXXX-XXXX
```

- `v=1` — scanners reject other versions with an "update the app" message.
- `server` — the starter's `homeserverURL` exactly as its session stores it.
- `code` — display form; parsers run it through `normalizeCode` anyway.
- Scanners reject any non-`matron://link` payload with "Not a Matron sign-in code."
- Under every QR the code is also shown as text (`XXXX-XXXX`), and the sign-in
  screens keep a manual path ("Have a link code?": server URL field + code
  field) — the camera-less fallback and the only Mac-claimant route. The manual
  path is identical to the scan path after parsing: same claim → poll → session.

A shared parser (one per codebase, unit-tested) turns the URI into
`{serverURL, code}` and is the single place the format is known.

## 3. Apple apps (matron-apple)

### Show side — iOS + Mac
- New Settings entry **"Link a Device"** → screen owned by a new
  `DeviceLinkViewModel` in `MatronShared/Sources/ViewModels` (shared by both
  platforms; thin SwiftUI views per platform, following the
  `AddAgentSheet`/`MacAddAgentSheet` split).
- On appear: `link/start` → render QR (CoreImage `CIFilter.qrCodeGenerator`,
  scaled crisp, with the code as selectable text below) → poll `link/status`
  every 2 s while visible.
- On `claimed`: swap QR for an approve card — device name + requester IP,
  Approve / Deny buttons → `link/approve` / `link/deny` → terminal state
  ("Approved — finishing sign-in on the other device" / "Denied"). Approve
  success is terminal for the show side; it does not wait for the claimant's
  final poll.
- On expiry (`404` from status): automatically start a fresh session and
  re-render — the QR self-refreshes for as long as the screen is open.
- On disappear: stop polling; the session is left to expire (or is replaced by
  the next start).
- New `JournalAPI` methods: `linkStart`, `linkStatus`, `linkApprove`, `linkDeny`
  (+ claimant-side `linkClaim`, `linkPoll`), mirroring existing method style.

### Scan side — iOS
- `SignInView` gains a **"Scan QR code"** button → full-screen camera sheet
  using `AVCaptureMetadataOutput` (QR metadata objects only). Adds
  `NSCameraUsageDescription` to `project.yml` ("Matron uses the camera to scan
  sign-in QR codes from your other devices."). Camera-permission denial shows
  a settings-deeplink message; the manual-code path remains available.
- On scan: parse URI → `linkClaim(server, code, deviceName)` where
  `deviceName` is the same device-name string password login sends → poll
  `linkPoll` every 2 s → on `approved`, build
  `UserSession(userID: username, deviceID: String(device_id), homeserverURL:
  server, accessToken: token)`, persist via the existing auth-service persist,
  and enter the normal `onSignedIn` path (which already runs
  `awaitPendingTeardown()` + `wipeLocalDataForFreshLogin()`).
- Pending UI: "Waiting for approval on your other device…" with Cancel.
- A `LinkSignInViewModel` in MatronShared owns claim/poll/session-build so the
  logic is shared and testable; the camera sheet is iOS-only view code.

### Scan side — Mac
- Manual path only: `MacSignInView` gains "Have a link code?" revealing a code
  field (server field already exists on the sign-in form). Same
  `LinkSignInViewModel` beneath.

## 4. Android app (matron-android)

Mirror of the Apple structure, following the existing
`PairingViewModel`/`AddAgentSheet` patterns:

- **Show side:** Settings **"Link a Device"** screen + `DeviceLinkViewModel`.
  QR bitmap rendered with `com.google.zxing:core` (pure-Java `QRCodeWriter` →
  `BitMatrix` → `Bitmap`; no scanning machinery from ZXing). Same 2 s status
  poll, approve card, auto-regenerate, stop-on-dismiss.
- **Scan side:** `SignInScreen` gains "Scan QR code" using ML Kit's
  Play-services code scanner (`com.google.android.gms:play-services-code-scanner`)
  — Google-provided capture UI, **no CAMERA permission and no manifest change**.
  If Play services is unavailable the button surfaces "Scanner unavailable —
  use a link code instead" and the manual path covers it.
- On scan: parse URI → `JournalApi.linkClaim` → poll → build the same
  `UserSession` shape password login builds (`userID` = returned `username`,
  `deviceID = device_id.toString()`) → persist via `JournalAuthService` →
  normal signed-in path (`MainActivity.onSignedIn` wipe path applies).
- Manual fallback on `SignInScreen`: "Have a link code?" reveals a code field,
  reusing the existing server-URL field; input auto-formats like
  `PairingViewModel` does for pair codes.
- New `JournalApi` methods for all six endpoints; `LinkSignInViewModel` +
  `DeviceLinkViewModel` unit-tested against a fake api, like existing VM tests.

## 5. Errors and edge cases

- **Expired while showing:** show side gets `404` from status → silently starts
  a new session, QR refreshes. (No error surfaced — expiry is routine.)
- **Expired after claim, before approve:** approve returns `404` → show side
  says "Code expired — showing a fresh one" and regenerates; claimant's poll
  returns `404` → "Sign-in expired. Scan again."
- **Denied:** claimant poll gets `denied` once → "Sign-in was denied on the
  other device."
- **Already claimed (`409` on claim):** claimant sees "This code was already
  used. Generate a new one on your signed-in device."
- **Wrong QR content / wrong version:** clear inline message, camera stays open.
- **Network loss:** both pollers back off (2 s → 5 s cap) and keep trying until
  their screen closes; claim/approve taps show ordinary retryable errors.
- **Starter signs out mid-flow:** starter endpoints 401 → show screen closes to
  sign-in; claimant's session expires normally.
- **Cancel on claimant:** stops polling and returns to sign-in; the show side
  still sees `claimed` and the user can Deny or just let it expire/regenerate.

## 6. Security analysis

- The 39-bit code grants nothing by itself: an attacker who guesses (or
  photographs) a live code can only *claim*, which puts their IP and chosen
  device name in front of the starter, who must tap Approve. Guessing is
  further bounded by the shared per-IP limiter and the ≤120 s session life.
- The claim token (poll credential) and the minted bearer token are 256-bit;
  poll is a direct high-entropy lookup, unauthenticated by design like
  `/pair/claim`.
- Approve/deny/status are bound to the **starter device**, not merely the same
  user — a second signed-in device of the same user cannot approve a link it
  isn't showing.
- Minting is one-shot-at-poll (session deleted before the token leaves the
  server), mirroring the pairing flow's mint-at-claim.
- The minted device is `kind='client'`: it appears in `/devices`, is
  individually revocable, and can itself later show QRs. No credentials ever
  appear in the QR — only the short-lived code and the server URL.
- Unknown/expired stay merged into `404` everywhere (anti-enumeration parity
  with the rest of the API); `conflict` on claim is distinguishable because
  telling the second claimant the truth leaks nothing useful.

## 7. Testing

- **Server** (mirroring the existing pairing tests): store unit tests —
  happy path, expiry sweep, claim-extends-TTL, first-claim-wins, one-session-
  per-starter replacement, deny-observed-once deletion, one-shot mint; HTTP
  tests — auth gating (`client`-only start/status/approve/deny, starter-device
  binding), rate-limit envelope, `username` present in the approved poll
  response, anti-enumeration 404s.
- **Apps** (both platforms, VM tests against fake APIs): show-side state
  machine (waiting → claimed → approved/denied, expiry-regenerate,
  stop-on-dismiss), claimant state machine (claim → pending → approved →
  session persisted with `userID` = username; denied; expired), QR-URI parser
  round-trips (valid, wrong scheme, wrong version, malformed server).
- **Manual end-to-end:** Mac shows → Android (Galaxy A07) scans → approve on
  Mac → Android signed in; iPhone shows → Android scans; Android shows →
  iPhone scans; manual-code path Mac → Mac.

## 8. Rollout

Additive endpoints — safe in any order, but sequence as: matron-journal PR →
deploy → matron-apple PR → matron-android PR. Old apps against the new server
are unaffected; new apps against an old server get `404` on `/link/start` and
the show/scan UI surfaces "Server doesn't support device linking yet."

## Out of scope (deliberate)

- OS deep-link handling for `matron://` (tapping a link instead of scanning).
- Push/WS notification of claims to the starter (polling only, matching pairing).
- Any change to the agent `/pair/*` flow or its typed-code UI.
- Rate-limit UI (retry-after countdowns) beyond generic error messages.
