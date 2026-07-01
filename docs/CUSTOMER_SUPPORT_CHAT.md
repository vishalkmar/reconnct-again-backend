# Customer Support Chat — Real-time SMS/Chat System

A real-time, persistent, WhatsApp-style support messaging system that spans the
**backend** (Node/Express/Sequelize + Socket.IO), the **admin website**
(Vite/React), and the **mobile app** (React Native). Travellers ("users") and
hosts ("suppliers") message support; a single **admin** replies to everyone from
one console with two queues.

> Status: living document. Update the "Progress" checkboxes as phases land.

---

## 1. Goals

- Two customer-facing sides can start conversations:
  - **User** (traveller) — from the mobile app (traveller mode) and the website.
  - **Supplier / Host** — from the mobile app (host mode) and the website.
- **One** responder: **Admin**, from the admin website, with a **Chat Support**
  tab containing two sub-tabs: **User Support** and **Supplier Support**.
- **Real-time & instant** via Socket.IO (message delivery, typing, read receipts).
- **Persistent** history, per user and per supplier, kept forever (like WhatsApp/
  Instagram/Facebook DMs). Always available on every side.
- **Seen / unseen** tracking (single vs double ticks, unread counts) — WhatsApp
  logic.
- **New-message notifications** on both sides (admin + party).
- **Attachments**: images (photo) and PDF documents.
- Admin sees a **list of conversations** (like WhatsApp chat list) → tap to open a
  thread. One thread panel; the list swaps between the User and Supplier tabs.
- **Theme**: the app's existing theme (golden-amber brand) with a WhatsApp-like
  chat layout (bubbles, incoming left, outgoing right, timestamps, ticks).
- Neat, clean, bug-free, with graceful reconnection and offline fallback (REST).

---

## 2. Actors, identities & auth

The backend already has three token kinds — the chat reuses them as-is:

| Actor | App / surface | Token | Middleware / verify |
|------|----------------|-------|---------------------|
| Admin | Admin website (`frontend/`) | JWT in `Authorization: Bearer` | `middlewares/auth.middleware.js` |
| User (traveller) | Mobile app (traveller mode) + website | JWT `kind:'user'` in `X-User-Auth` | `middlewares/userAuth.middleware.js` |
| Supplier / Host | Mobile app (host mode) + website | **same User account** as above (host is a client-side mode of the logged-in user) | `userAuth` + `queue:'supplier'` |

**Key decision — who is a "supplier" in the app?**
In the mobile app, "host" is a *mode* of the same logged-in `User` (see
`App/reconnct/src/store/HostContext.jsx` — there is no separate host login). So a
single user account can own **two** conversations: one in the `user` queue and
one in the `supplier` queue. The queue is chosen by the app mode at send time.

The data model still carries an optional `supplierId` (FK to the existing
`supplier` model) so a *separate* website supplier login can be attached later
without a schema change.

---

## 3. Data model (Sequelize, MySQL)

Two new models, registered in `backend/src/models/index.js` and synced by the
existing background `sequelize.sync({ alter: true })` (no manual migration file
needed; follow the repo convention).

### 3.1 `SupportConversation` — table `support_conversations`

| Field | Type | Notes |
|-------|------|-------|
| `id` | INTEGER PK AI | |
| `queue` | ENUM('user','supplier') | which support queue / admin tab |
| `userId` | INTEGER FK→users NULL | the app/site user (host mode reuses this) |
| `supplierId` | INTEGER FK→suppliers NULL | reserved for website supplier login |
| `subjectLabel` | STRING | denormalised display name (e.g. user name) |
| `lastMessageText` | STRING(500) | preview for the inbox list |
| `lastMessageAt` | DATE | sort key for the inbox |
| `lastSenderRole` | ENUM('user','supplier','admin') | for tick/preview styling |
| `unreadAdmin` | INTEGER default 0 | messages the admin hasn't read |
| `unreadParty` | INTEGER default 0 | messages the user/host hasn't read |
| `status` | ENUM('open','closed') default 'open' | admin can archive/close |
| `createdAt/updatedAt` | DATE | |

Indexes / uniqueness: unique composite `(queue, userId)` and `(queue, supplierId)`
so "get-or-create my conversation" is deterministic. Index `lastMessageAt` for the
inbox sort.

### 3.2 `SupportMessage` — table `support_messages`

| Field | Type | Notes |
|-------|------|-------|
| `id` | INTEGER PK AI | |
| `conversationId` | INTEGER FK→support_conversations | cascade delete |
| `senderRole` | ENUM('user','supplier','admin') | who sent it |
| `senderUserId` | INTEGER NULL | set when a user/host sent |
| `senderAdminId` | INTEGER NULL | set when admin sent |
| `body` | TEXT | message text (may be empty if attachment-only) |
| `attachments` | JSON | `[{ type:'image'|'pdf', url, name, size }]` |
| `readByAdmin` | BOOLEAN default false | |
| `readByParty` | BOOLEAN default false | |
| `createdAt` | DATE | shown as the bubble time |

Associations (in `models/index.js`):
```
SupportConversation.hasMany(SupportMessage, { as: 'messages', foreignKey: 'conversationId', onDelete: 'CASCADE' });
SupportMessage.belongsTo(SupportConversation, { as: 'conversation', foreignKey: 'conversationId' });
SupportConversation.belongsTo(User, { as: 'user', foreignKey: 'userId' });
SupportConversation.belongsTo(Supplier, { as: 'supplier', foreignKey: 'supplierId' });
```

### 3.3 Read-receipt / unread rules (WhatsApp logic)

- **Sent**: on `POST message`, create the row; bump the *other* side's unread
  (`unreadAdmin++` if party sent, `unreadParty++` if admin sent); update the
  conversation preview (`lastMessage*`).
- **Delivered**: implied when the recipient's socket is connected (single→double
  tick). Optional; we can treat "delivered" as "the server accepted it".
- **Read (seen)**: when a side *opens/focuses* a conversation → mark all the
  opposite side's messages `readBy* = true`, reset that side's unread counter to
  0, and emit a `support:read` event so the sender's ticks turn blue.

---

## 4. Real-time transport — Socket.IO namespace `/support`

The existing `initSocket` (in `pwa/services/socket.js`) only accepts **PWA**
tokens (`decoded.pwa`). We add a **dedicated namespace** `io.of('/support')` with
its own handshake auth that accepts **admin** and **user** tokens, so the two
systems stay independent.

### 4.1 Handshake auth
`socket.handshake.auth.token` + `role` hint:
- `role:'admin'` → verify with admin JWT → `socket.support = { role:'admin', id }`.
- `role:'user'|'supplier'` → verify `kind:'user'` JWT → `socket.support = { role, userId }`.

### 4.2 Rooms
- `conv:<conversationId>` — both the party and the admin join when a thread is open.
- `support:admin` — every admin socket joins; receives inbox/list updates &
  new-conversation events (for the badge + list re-order).
- `support:party:<userId>` — the user's personal room; receives replies &
  unread bumps even when the thread isn't open (drives the app badge).

### 4.3 Events
Client → Server:
| Event | Payload | Effect |
|-------|---------|--------|
| `support:join` | `{ conversationId }` | join `conv:<id>`; server marks read for the joiner |
| `support:message` | `{ queue?, conversationId?, body, attachments, tempId }` | persist + fan-out |
| `support:read` | `{ conversationId }` | mark read + emit receipt |
| `support:typing` | `{ conversationId, typing:boolean }` | relay to the room |

Server → Client:
| Event | Payload |
|-------|---------|
| `support:message` | the created message (with `conversationId`, `tempId` echoed) |
| `support:read` | `{ conversationId, by:'admin'|'party', at }` |
| `support:conversation` | inbox row (id, queue, subjectLabel, preview, unread, lastMessageAt) — admin list live-update |
| `support:typing` | `{ conversationId, role, typing }` |
| `support:error` | `{ tempId, message }` |

REST remains the source of truth / history & the fallback when the socket is
down; the socket is an accelerator, not the only path.

---

## 5. REST API

Mounted in `backend/src/routes/index.js` as `router.use('/support', require('./support.routes'))`.

### 5.1 Party (user / host) — `userAuth` (`X-User-Auth`)
| Method | Path | Body / query | Returns |
|--------|------|--------------|---------|
| GET | `/api/support/me/conversation?queue=user|supplier` | — | get-or-create my conversation + last 30 messages |
| GET | `/api/support/me/messages?conversationId=&before=<id>` | — | older messages (pagination) |
| POST | `/api/support/me/messages` | `{ queue, body, attachments }` | created message (also socket-emitted) |
| POST | `/api/support/me/read` | `{ conversationId }` | `{ ok:true }` |
| GET | `/api/support/me/unread` | — | `{ user: n, supplier: n }` — app badge |

### 5.2 Admin — `auth.middleware` (`Authorization`)
| Method | Path | Body / query | Returns |
|--------|------|--------------|---------|
| GET | `/api/support/admin/conversations?queue=user|supplier&q=&page=` | — | inbox list (sorted by `lastMessageAt`, with unread) |
| GET | `/api/support/admin/conversations/:id/messages?before=` | — | thread history |
| POST | `/api/support/admin/conversations/:id/messages` | `{ body, attachments }` | reply (socket-emitted) |
| POST | `/api/support/admin/conversations/:id/read` | — | `{ ok:true }` |
| GET | `/api/support/admin/unread` | — | `{ user:n, supplier:n }` — tab badges |
| PATCH | `/api/support/admin/conversations/:id` | `{ status }` | open/close |

### 5.3 Attachments — `/api/support/attachments`
`POST` multipart (`file`), auth = either party or admin. Reuses the existing
Multer + Cloudinary pipeline (`middlewares/upload.middleware.js`). Accepts
`image/*` and `application/pdf` (max ~10 MB). Returns
`{ type:'image'|'pdf', url, name, size }` to embed in `attachments`.

---

## 6. UI / UX

Shared chat conventions (all surfaces): incoming bubbles left (light gray),
outgoing right (brand-tinted), timestamp under/!inside bubble, day separators,
sticky composer with attach (📎 → photo/pdf), send button, auto-scroll to
bottom, unread divider, typing indicator, tick states (sent ✓ / read ✓✓ blue).

### 6.1 Mobile app (React Native)
- New **Support** chat screen reachable from Profile → "Support" (traveller) and
  Host Profile → "Support" (host). The existing **Inbox** tab currently shows
  demo "Messages" — Support is a distinct support thread (keep Inbox as-is or
  route its entry to Support; decided per Phase 6).
- Uses `socket.io-client` (pure JS, RN-compatible — add to `App/reconnct`).
- Theme: app gold (`colors.brand`) outgoing bubble on dark text, incoming
  `#F1F2F4`. Header shows "Support" + online dot.
- Attachments via existing `react-native-image-picker` (photo) + a document
  picker for PDF (or paste-URL fallback for phase-1, consistent with current
  listing photo flow).
- Unread badge on the Support entry + push/local notification on new reply.

### 6.2 Admin website (Vite/React)
- New route/page **Chat Support** in the admin sidebar.
- Two tabs: **User Support** | **Supplier Support** (each = a `queue`).
- Layout: left = conversation list (avatar, name, preview, time, unread pill,
  online dot), right = the open thread (WhatsApp-style). Selecting a queue tab
  swaps the list; selecting a conversation opens the thread.
- Socket client joins `support:admin` + the open `conv:<id>`; the list
  live-reorders and shows unread badges; a global bell/tab badge shows totals.

### 6.3 Website public site (optional, Phase 7)
- A floating "Support" chat widget for signed-in site users/suppliers, same
  backend. Deferred until app + admin are solid.

---

## 7. Notifications & badges

- **Admin**: per-conversation `unreadAdmin`, per-tab totals (`/admin/unread`),
  and a global bell count. Live via `support:conversation` + `support:message`
  on the `support:admin` room. A subtle sound/toast on a new message.
- **Party**: `/me/unread` → badge on the Support entry; `support:message` on
  `support:party:<userId>` bumps it in real-time; a local notification when the
  app is backgrounded (phase-6 best-effort).
- Seen/unseen: ticks driven by `readBy*` + `support:read`.

---

## 8. Security & edge cases

- A party may only read/write **their own** conversation (enforced by `userId`
  from the token; never trust a client-supplied `conversationId` without an
  ownership check).
- Admin may read/write any conversation (admin JWT).
- Validate attachment MIME (`image/*`, `application/pdf`) + size server-side.
- Sanitize/limit `body` length (e.g. 4000 chars).
- Socket auth failures disconnect cleanly; REST still works.
- Idempotent send via `tempId` (client-generated) so a reconnect retry doesn't
  duplicate; server echoes `tempId` and the client reconciles the optimistic
  bubble.
- Reconnection: on socket `reconnect`, client re-`support:join`s open threads and
  refetches messages `after` the last known id to fill gaps.
- Rate-limit sends (reuse the `/api` limiter; add a per-socket soft cap).

---

## 9. Phased implementation plan

Each phase is independently shippable and testable. Do them in order.

### Phase 1 — Backend data model ✅ when
- [ ] `support/` models: `SupportConversation`, `SupportMessage` (place under
      `backend/src/models/` following the `*.model.js` convention).
- [ ] Registered + associated in `models/index.js`; `sync({alter})` creates the
      tables without breaking existing sync (verify locally).
- **Accept**: tables exist; associations load; server boots clean.

### Phase 2 — Backend REST API
- [ ] `support.controller.js` (party + admin handlers) + `support.routes.js`
      mounted at `/api/support`.
- [ ] get-or-create conversation, list, history (pagination), send, read, unread.
- [ ] Ownership checks; unread/preview bookkeeping.
- **Accept**: full flow works via curl/Postman with real tokens; history persists.

### Phase 3 — Backend socket namespace `/support`
- [ ] `support/services/supportSocket.js` — `io.of('/support')` with admin+user
      handshake auth, rooms, and the events in §4.3.
- [ ] Controllers emit on send/read (extract a small `emitSupport` helper so REST
      and socket paths share fan-out).
- **Accept**: two clients (admin + user) exchange messages in real-time; read
  receipts + typing propagate; REST and socket stay consistent.

### Phase 4 — Attachments
- [ ] `POST /api/support/attachments` (Multer+Cloudinary), MIME/size guard.
- [ ] Messages render image thumbnails + PDF chips (all surfaces).
- **Accept**: photo + PDF send and display on app + admin.

### Phase 5 — Admin frontend "Chat Support"
- [ ] Sidebar entry + page with **User / Supplier** tabs.
- [ ] Conversation list + thread panel (WhatsApp-like), socket client, unread
      badges, live reorder, notification toast/bell.
- **Accept**: admin replies to both queues in real-time; badges accurate; refresh-safe.

### Phase 6 — Mobile app Support chat
- [ ] Add `socket.io-client`; `SupportContext` (connection + unread).
- [ ] Support screen (traveller + host modes → correct `queue`), composer,
      attachments, ticks, badges; entry points in Profile / Host Profile.
- **Accept**: user & host chat with admin live on-device; history persists across
  app restarts (server-backed); badge + reconnection work.

### Phase 7 — Polish & (optional) website widget
- [ ] Seen/unseen ticks everywhere, typing indicator, day separators, empty
      states, error/retry, sound.
- [ ] (Optional) public-site floating support widget.
- **Accept**: feels like WhatsApp; no dupes, no lost messages, clean reconnect.

---

## 10. File map (planned)

```
backend/src/
  models/supportConversation.model.js
  models/supportMessage.model.js
  models/index.js                       (register + associate)
  controllers/support.controller.js
  routes/support.routes.js
  routes/index.js                       (mount /support)
  support/supportSocket.js              (io.of('/support'))   [Phase 3]
  services/socket.js or pwa/services/socket.js  (export getIO to share server)

frontend/src/
  pages/ChatSupport.jsx                 (2 tabs + list + thread)
  services/supportApi.js
  services/supportSocket.js
  (sidebar/route registration)

App/reconnct/src/
  store/SupportContext.jsx
  api/support.js                        (REST helpers)
  services/supportSocket.js             (socket.io-client)
  screens/SupportScreen.jsx
  (entry points in ProfileScreen / host/HostProfileScreen)
```

---

## 11. Progress log

- 2026-07-01 — Doc created; conventions confirmed (socket.io present but
  PWA-scoped; admin `Authorization`, user `X-User-Auth`; Multer+Cloudinary
  uploads; model/route patterns).
- 2026-07-01 — **Phase 1 done**: `supportConversation.model.js` +
  `supportMessage.model.js` + registered/associated in `models/index.js`.
- 2026-07-01 — **Phase 2 done**: `controllers/support.controller.js` +
  `routes/support.routes.js` mounted at `/api/support` (party + admin).
- 2026-07-01 — **Phase 3 done**: `services/support.service.js` (shared DB logic)
  + `support/supportSocket.js` (`io.of('/support')` namespace, admin+user auth,
  rooms, message/read/typing events, `emitNewMessage`/`emitRead` fan-out); REST
  controller refactored onto the service + emits; wired in `server.js`.
- 2026-07-01 — **Phase 4 (backend) done**: `POST /api/support/attachments`
  (image/pdf via existing Multer+Cloudinary, either admin or party auth) →
  `{ type, url, name, size }`. Attachment *rendering* happens in the UI phases
  (5 admin, 6 app). Decision confirmed: app host = same User account; queue
  chosen by which chat they message from.
- 2026-07-01 — **Phase 6 (mobile app) done**: `socket.io-client` added to the
  app; support REST helpers + multipart `supportUpload` in `api/client.js`;
  `utils/imagePicker.pickAsset`; `services/supportSocket.js`; `screens/
  SupportScreen.jsx` (WhatsApp-style, socket + REST fallback, image attachments,
  sent/read ticks, typing, day separators); route `support` in RootNavigator;
  entry points **Profile → Support (queue=user)** and **Host Profile → Support
  (queue=supplier)**. Also: backend `authenticateUser` now falls back to the
  `Authorization` header (the app sends the user token there) — website still
  uses `X-User-Auth`; no privilege crossover (token still checked `kind:'user'`).
  App JS bundle builds clean. **DEPLOY DEPENDENCY: the whole `/api/support` +
  `/support` socket + the userAuth fallback must be on Render before the app can
  talk to support.** PDF attachments from the app are a follow-up (image only
  for now; admin supports both).
- 2026-07-01 — **Phase 7 (polish) done + a correctness fix**:
  - **Fix**: `support.controller` now returns the standard `{ success, data }`
    envelope (`ok`/`created`/`fail`) — the app's `request()` reads `json.data`,
    so the old top-level shape gave `undefined` and broke the app chat load.
    (Admin page already read defensively; still works.)
  - **App**: unread badge on the Support entry — Profile (user queue) and Host
    Profile (supplier queue); SupportScreen re-joins + refetches on socket
    reconnect (gap-fill, keeps local pending bubbles).
  - **Admin**: toast on a genuinely-new incoming message (unread went up, not
    the open thread); on reconnect, resyncs the list + open thread.
  - **Website**: `pages/user/UserSupportPage.jsx` (member support, user queue,
    same real-time chat) + route `/dashboard/support` + sidebar entry;
    `supportSocket` reconnects when the role (admin↔user) changes.
  - Verified: backend controller loads, frontend `npm run build` passes, app JS
    bundle builds. Full system (backend + admin + app + website) is
    feature-complete; ready for end-to-end local test then deploy.
- 2026-07-01 — **Phase 5 (admin frontend) done**: `socket.io-client` added;
  `frontend/src/services/supportSocket.js` (admin `/support` client);
  `pages/admin/ChatSupportPage.jsx` — WhatsApp-style **User / Supplier** tabs,
  conversation list (avatar, preview, time, unread pill), thread with day
  separators, image/PDF bubbles, sent/read ticks, typing indicator, optimistic
  send + REST fallback, live/offline badge; route `/admin/chat-support`; sidebar
  entry with a live unread badge (poll + `support-unread` event). `npm run build`
  passes clean.
