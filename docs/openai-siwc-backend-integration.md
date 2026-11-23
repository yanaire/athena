# SIWC backend integration handoff

Historical controlled backend evidence, November 22, 2026. No existing account,
credential file, or authenticated OpenAI endpoint was used. No commit was made.
At the time of this handoff, the composition in `runtime/server.ts` did not
enable ChatGPT plan usage. See the [current build and verification record](m42/siwc.md)
for the personal local macOS build and the current account acceptance criteria.

## Delivered behavior

Verified OpenAI identity and permission to spend a ChatGPT plan are separate.
Successful OAuth with a valid, bound ID token but no
`chatgpt.tokens.use.direct` retains the issued-client/subject/host registration.
The ID token stays protected for native returning sign-in. Identity-only grants
may omit access and/or refresh tokens; returned token values and expiry are
validated and retained without granting inference permission. A direct grant
still requires both tokens. Malformed tokens/scopes, invalid identities, and
account/host changes still fail.

The existing `connected | signed_out | reauth_required` registration state is
unchanged. Public registration/account projections now also contain
`planUsage: 'enabled' | 'disabled'`. Enabled requires connected state and the
direct scope. The scoped credential facade additionally validates tokens.
Identity-only records cannot supply runtime auth, list usable credentials,
load the plan model catalog, author a plan profile, or pin a plan run.
They remain available for returning authorization and sign-out.

User-initiated reconnect of a connected identity-only registration sends the
saved issued client ID, stable host ID, fresh state/nonce/PKCE, the complete
scope set, and `prompt=consent`. Routine granted-account reauthorization does
not force consent. No `force_reconsent` parameter is emitted because deployment
confirmation for this integration is absent. Recheck scopes after every grant.
Successful refresh that loses the direct scope persists the reduced grant
under the same registration lock, then fails to authorize inference.

Per-account storage, account pinning, serialized refresh, terminal refresh
invalidation, native-only ID-token hints, and independent API-key credentials
continue through the existing owners. This work does not change credential
storage format, migration, local file handling, desktop-host, or the UI.

Responses strips `service_tier` alongside unsupported fields, including after
caller `onPayload` overrides and again at the outbound transport boundary.
The selected model, public endpoint, bearer binding, no redirects, no automatic
retry, `store: false`, `stream: true`, and terminal-completion checks remain.

Inference admission errors retain the actual HTTP status in the sanitized
response and report body classification (`structured`, `detail`, `other`,
or `malformed`). Error bodies are read up to 64 KiB. Only a fixed allowlist of
documented codes, recognized top-level parameter names, and bounded
`req_[A-Za-z0-9_-]+` request IDs are surfaced. Unknown codes become
`provider_error`; unknown parameters and invalid request IDs are omitted.
Provider message/detail text and raw transport errors are never forwarded.
SSE failures use the same code/parameter allowlist. These diagnostics currently
travel in the existing stream `errorMessage`, not a new structured RPC field.

## Exact UI/status-contract delta for the lead

1. **P0: type and display identity separately from plan usage.** Add the following
   to the `listChatGPTAccounts` response contract (the backend already emits it):

   ```ts
   readonly planUsage: 'enabled' | 'disabled';
   ```

   Keep `state` unchanged. Render connected/disabled as "Signed in; ChatGPT plan
   usage is disabled". Enable plan-model/profile actions only when state is
   connected AND planUsage is enabled. A preexisting client checking connected
   alone must be updated; absence of the new field must not imply permission.
   The current account-label rendering is in `ui/provider-profiles.js`, in its
   `[data-amp-account]` option construction.

2. **P0: expose explicit enablement using the existing reconnect call.**
   For connected/disabled, label `[data-amp-account-reconnect]` "Enable ChatGPT
   plan usage" and call `startProviderOAuth('openai', account.authRef)`.
   Do not start OAuth automatically when rendering accounts or loading models.
   After `succeeded`, await `listChatGPTAccounts` before deriving success text
   and loading the selected account catalog. The current poller sets local flow
   status to `authorized` and launches these reads independently; OAuth success
   establishes verified sign-in, not plan permission.
   If permission remains disabled, retain identity, keep models empty, and
   offer enablement or the independent API-key route.

3. **P1: distinguish permission from token refresh in catalog messaging.**
   A selected identity-only account returns `source: 'chatgpt_account'`,
   its `accountRef`, `provider.auth: 'refresh_required'`, empty `models` and
   `availableModelIds`, and no catalog error. This reuses the existing auth
   enum rather than adding an uncoordinated wire variant. Combine that result
   with `planUsage` to show the enablement action; repeated catalog refresh
   cannot grant consent. `signed_out` still returns unconfigured, and
   `reauth_required` still requires reconnect. Preserve saved profiles without
   making them runnable or silently selecting an API-key billing path.

4. **P1: present recovery using safe stream diagnostics.** HTTP 401 calls for
   checking identity and scopes; 403 calls for permission/region/integration
   checks; 503 preserves credentials and permits a later bounded retry.
   `subscription_sharing_usage_limit_exceeded` pauses plan requests and links
   to ChatGPT Settings / Usage; do not invent a reset time.
   `subscription_sharing_user_not_eligible` and
   `subscription_sharing_route_not_supported` need configuration/policy
   correction rather than OAuth loops.
   `subscription_sharing_unsupported_capability` requires removing the
   unsupported parameter, not repeating the same body.
   `chatpass_v2_scope_not_authorized` and
   `chatpass_v2_invalid_authorization_context` require grant/client diagnosis.
   Usage/user unavailability preserves credentials and allows a later retry.
   Invalid-user errors alone do not erase credentials: terminal refresh
   rejection confirms the need for reauthorization.
   The existing `ModelCheck.error` enum remains coarse and has no structured
   diagnostic object. Do not claim probe cards already expose these fields or
   parse display prose into a new stable machine contract.

5. **P2: retain existing sign-out feedback.** `remote: 'unconfirmed'` requires
   telling the user that local sign-out succeeded but remote revocation was
   unconfirmed. `remoteFailure` remains a fixed safe code. No credentials,
   hint-bearing authorization URL, subject, or issued client ID belongs in
   browser diagnostics. Continue using `browserReady` and native open for
   native hints.

## Evidence and limitations

The identity-only manager regression failed before the production fix with
OAuth status `failed` instead of `succeeded`. The admission-diagnostics
regressions failed before that fix because safe request IDs were discarded.
Controlled tests cover verified identity without resource tokens or without a
refresh token, explicit
reconsent and upgrade, encrypted reopen after scope loss, scope enforcement
before catalog/profile/run operations, independent API keys, service-tier
stripping after caller overrides, and sanitized structured/detail/malformed
admission failures. Existing controlled tests cover binding, cancellation,
rotation, terminal refresh failure, sign-out, catalog freshness, and pinned
parent/child account use.

Final controlled run: **67 tests passed, 0 failed**. The service-tier wire test
also failed when the old allowlist entry was temporarily restored, then passed
after the mutation was removed.

Run from this worktree:

```sh
node --test tests/provider-oauth.test.ts tests/chatgpt-registrations.test.ts tests/chatgpt-account.test.ts tests/chatgpt-responses.test.ts tests/provider-manager.test.ts
npm run check
```

No live eligibility, consent, model-list, inference, desktop, or UI acceptance
is claimed. The release gate stays off. Existing large manager/registration
modules remain in place to respect the assigned ownership and avoid a broad
structural refactor during final integration.

Official contracts read for this change:

- <https://developers.openai.com/siwc/token-sharing-open-source/sign-in>
- <https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions>
- <https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference>
- <https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery>
- <https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations>
