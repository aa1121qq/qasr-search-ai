# Admin Endpoints — Security Proposal

**Status:** ⏸️ Awaiting decision. Not implemented.
**Endpoints in scope:** `POST /admin/add-product`, `POST /admin/clear-cache`, `POST /admin/reload-csv`, `GET /admin/analytics/zero-results` (read-only).
**Current state:** static `ADMIN_KEY` header check. Dev mode (no key set) allows everything.

---

## Threat model

| Threat | Impact | Likelihood today |
|---|---|---|
| Catalog poisoning via `/add-product` | High — bad products visible to all users | Medium (endpoint exposed publicly if deployed) |
| Cache flush DoS via `/clear-cache` | Medium — every search hits cold cache, latency spikes | Low (no automated attackers yet) |
| Catalog read via analytics endpoint | Low — leaks query trends | Low |
| Key exposure (committed/.env leak) | Critical — full admin access | Medium (key is static, no rotation) |

The most important property is **revocability**: when (not if) the key leaks via accidental commit, screenshot, or shared screen, we must be able to invalidate it without restarting the server or coordinating with every caller.

---

## Options

### Option A — Keep static `ADMIN_KEY` (status quo)
- **Pros:** zero work; trivially understood; works behind a private network.
- **Cons:** key is forever; no audit; no rate limit; rotation needs server restart + redeploy.
- **When this is fine:** backend deployed behind VPN / private network only, no public exposure.

### Option B — HMAC signed short-lived tokens
- **How:** bootstrap secret on the server → call `POST /admin/token` with bootstrap → get 15-min token. Subsequent calls send `Authorization: Bearer <token>`.
- **Pros:** tokens self-expire (limits damage on leak); bootstrap secret stays on server only; easy to add scopes (`read-only` vs `write`); no DB.
- **Cons:** caller must refresh tokens; clock skew matters (use server time, not client).
- **Why we'd pick this:** balances security with operational simplicity; no external dependency.

### Option C — JWT (RS256 with rotated keys)
- **How:** asymmetric signing; public key on the API server, private key kept separately (HSM / KMS / dev laptop).
- **Pros:** can delegate token issuance to a separate auth service; native scope/role claims; library support everywhere.
- **Cons:** key management is a non-trivial responsibility; revocation needs a denylist or short TTL.
- **When this is right:** when there will be ≥3 admin users or a separate auth service is planned.

### Option D — OAuth / hosted identity provider (Auth0, Cognito, Google IAP)
- **Pros:** offload auth entirely; MFA, audit, user management included.
- **Cons:** monthly cost; external dependency; overkill for 1–3 admins.
- **When this is right:** customer-facing admin portal with multiple roles.

### Option E — IP allowlist + WAF / Cloudflare Access (network layer)
- **Pros:** strongest in practice (attacker can't reach the endpoint at all); no code changes.
- **Cons:** requires the deployment to sit behind Cloudflare / a WAF; remote admins need a fixed IP or VPN.
- **When this is right:** stacks on top of B or C — defense in depth.

---

## Recommendation

**B + E** when the service goes public.

- **Option B** (HMAC short-lived tokens) for application-layer auth. Implementation is ~80 lines, no external dependency, fits our current Express/Node stack.
- **Option E** (Cloudflare Access or IP allowlist) at the network layer if you control the deployment. Defense in depth; even if a token leaks, the attacker also needs to reach the endpoint.

**Why not C/D for now:**
- Only 1 admin (you). JWT's flexibility is unused.
- Hosted IdP adds cost and complexity for no gain at this scale.

If the team grows to 3+ admins with different roles, revisit and migrate to C.

---

## Decisions you need to make before implementation

1. **Token TTL** — proposal: **15 minutes** for write operations, **1 hour** for read-only (`/admin/analytics/*`). Trade-off: shorter = more refreshes; longer = more damage on leak.

2. **Bootstrap secret rotation** — how often? Proposal: **rotate every 90 days** by editing `.env` and restarting. If you want zero-downtime rotation, that's a different design (two valid secrets during overlap window).

3. **Where the bootstrap secret lives** — options:
   - `.env` (current) — convenient but easy to leak via screenshot or commit.
   - OS keychain / Windows Credential Manager — safer but harder to script.
   - Secret manager (1Password CLI, AWS Secrets Manager) — best, requires setup.

4. **Rate limit policy** — proposal: 3 calls/min/IP on write endpoints, 30/min on read. Or do you want stricter (1/min)?

5. **Audit log retention** — append-only JSONL is simple; do you want rotation (gzip + archive weekly)? Send to external log service?

6. **CORS for admin endpoints** — currently open via `app.use(cors())`. Should admin endpoints reject CORS entirely (browser-side access blocked)?

7. **`/admin/clear-cache` granularity** — full flush is destructive. Proposal: replace with `/admin/cache/invalidate?key=...` so you can flush one query without affecting the rest.

---

## Implementation plan once decisions are confirmed

| Step | Files | Effort |
|---|---|---|
| Add `signAdminToken` + `verifyAdminToken` helpers | `backend/index.js` (~60 lines) | 20 min |
| Replace `adminAuth` middleware | `backend/index.js` | 15 min |
| Add `POST /admin/token` endpoint | `backend/index.js` | 10 min |
| Add per-IP rate limit middleware | `backend/index.js` (~20 lines) | 15 min |
| Append-only audit log to `data/admin-audit.jsonl` | `backend/index.js` | 10 min |
| Update README / .env.example | `backend/README.md`, `.env.example` | 15 min |
| Smoke test with curl scripts | `backend/scripts/test-admin.sh` | 20 min |

**Total: ~2 hours after decisions are signed off.**

---

## Out of scope (do later)

- Per-user identity (need 3+ admins first).
- SSO / SAML.
- Per-endpoint scopes beyond read/write.
- Mutual TLS (overkill for now).
