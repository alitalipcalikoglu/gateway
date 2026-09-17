# gateway readiness contract

## Purpose

The public edge: matches incoming requests to routes, terminates (or forwards for) TLS, verifies
end-user JWTs against auth's JWKS, injects service credentials so browsers never see them, enforces
a local per-IP rate limit and an optional central one, adds geo headers, and streams the exchange
to an upstream. It is the only thing in this platform meant to be reachable from the open internet
besides the console.

## Dependencies

- Every upstream named in `routes.json` (required for that route to work; a route with no reachable
  upstream answers 502/504 for that request, `/ready` reports it unhealthy).
- auth's JWKS endpoint, when any route has `auth: "user"` (`jwt.jwksUrl` in `routes.json`; required
  at startup — `RouteTable.parse` throws if such a route exists with no `jwt` section). A JWKS
  fetch failure at request time answers `503 AUTH_UNAVAILABLE` for that request only.
- ratelimit (`RATELIMIT_URL`/`RATELIMIT_API_KEY`), optional: only used by routes that declare
  `policy`. Both env vars must be set together or neither (`Config.#service`).
- geo (`GEO_URL`/`GEO_API_KEY`), optional: only used by routes that declare `geo: true`. Same
  both-or-neither rule.

## Persistence

None persisted, but `routes.json` (path from `ROUTES_FILE`, default `./routes.json`) is read at
startup (`RouteTable.load`, `src/application.js`) and validated; a bad file stops the process with
the exact problem (`ConfigError`). No database, no files written at runtime. As of Stage 9 it is
also re-read on `SIGHUP` — see "Circuit breaker and live reload" below.

## Health endpoint

`GET /health`: always `{"status":"ok"}` if the process can answer HTTP at all. No dependency
checks (`src/http/gateway-api.js`).

## Readiness endpoint

`GET /ready`: for every route, probes one upstream's `healthPath` (default `/health`) with a 2 s
timeout; `200` only if every route has at least one healthy upstream, `503` with per-route detail
otherwise. Cached 15 s (`GatewayApi.READY_CACHE_MS`). Read-only: no side effects, no state mutated.

## Graceful shutdown

SIGTERM/SIGINT → `app.close()` (Fastify waits for in-flight requests) → destroy the upstream
connection-pool keep-alive agents (`api.destroy()`) → exit. Force-exit timer is
`UPSTREAM_TIMEOUT_MS + 5000` ms (default 35 s) (`src/application.js`). `unhandledRejection` runs
the same shutdown; `uncaughtException` exits immediately (no drain). PM2 `kill_timeout` should be
set at or above the force-exit timer plus a small margin.

## Resource limits

`BODY_LIMIT` per route (default from env, overridable per route in `routes.json`) — not actually
buffered: bodies are streamed through `Proxy` and only *counted* against the limit as bytes pass,
so a large upload does not sit in memory (`src/proxy.js`). `max_memory_restart` in
`ecosystem.config.cjs`: 300M.

## Timeouts

`UPSTREAM_TIMEOUT_MS` (default 30 000, per route overridable via `timeoutMs`): time to first byte
from the upstream, once connected. `UPSTREAM_CONNECT_TIMEOUT_MS` (default 5 000): TCP connect.
`RATELIMIT_TIMEOUT_MS` / `GEO_TIMEOUT_MS` (default 300 each): the two optional dependency calls.
JWKS fetch/cache timing is jose's own defaults (not configured here).

## Retry policy

One retry on the *next* upstream in the pool, only for `GET`/`HEAD`/`OPTIONS`, and only if no
response byte has been sent to the client yet (`Proxy.RETRY_METHODS`, `src/proxy.js`). No retry for
methods with a body, and no retry policy for the ratelimit/geo calls themselves (a single failed
call is treated as "unavailable" per the fail-open/closed rule below, not retried). Connection
failures, timeouts and upstream `5xx` responses all count as a breaker failure for that upstream
(Stage 9); a client `4xx` never does, and a client aborting the request is never held against the
upstream either (see "Circuit breaker and live reload" below).

## Idempotency

The gateway itself performs no idempotent-vs-not distinction beyond the retry rule above; it has no
state of its own to be idempotent about. Idempotency of the underlying operation is the upstream
service's responsibility.

## Backup

Nothing to back up: no database, no persistent files besides the operator-supplied `routes.json`
(which should live in version control or the deployment config, not be treated as generated state).

## Restore

Redeploy `routes.json` and restart. No data recovery needed.

## Metrics

`GET /metrics` (bearer `METRICS_TOKEN`, disabled entirely — 404 — if that env var is empty):
`gateway_requests_total{route,status}`, `gateway_request_duration_ms` histogram,
`gateway_bytes_total{route,direction}`, `gateway_upstream_errors_total{route}`,
`gateway_rejected_total{reason}` (`rate_limited`, `unauthorized`, `no_route`, `policy`,
`policy_unavailable`), `gateway_dependency_errors_total{dependency}` (`ratelimit`, `geo`), uptime.
Stage 9 adds `gateway_upstream_latency_ms` histogram (per route only — the time spent talking to
the upstream, never labeled by raw URL, IP, user or request id, so cardinality stays bounded by the
route count), and `gateway_upstream_breaker_state`/`gateway_upstream_breaker_failures` gauges plus
`gateway_breaker_transitions_total` counter, all labeled `route`+`upstream` — bounded because that
pair is the small, static set from `routes.json`, never per-request data. All process-local, reset
on restart — there is nowhere else for a stateless service to keep them.

## Logging

Custom access-log line (not Fastify's default; `disableRequestLogging: true`) with `route`,
`method`, `path`, `status`, `durationMs`, `upstreamMs` (Stage 9: time spent talking to the upstream,
connect through last response byte; omitted for a request that never reached a route/upstream —
404, rate-limited, unauthorized, etc.), `ip`, `upstream`, `ua`, `reqId`, and `traceId`. Stage 9 also
adds a one-off structured log line on every circuit breaker state transition (`route`, `upstream`,
`from`, `to`) — never per request. See [OBSERVABILITY.md](../../stack/docs/OBSERVABILITY.md) for
the full target vocabulary and what is still missing (`service`, `version`, `spanId`).

## Tracing

The only service that implements the `X-Request-Id` trust boundary and `traceparent` propagation
described in [OBSERVABILITY.md](../../stack/docs/OBSERVABILITY.md): both are honoured only when
`TRUST_PROXY=true`, generated fresh otherwise, and forwarded to whichever upstream handles the
request. Both are echoed back to the caller on the response.

## Security model

No inbound API key (public edge). `Authorization` from the client is dropped whenever a route
injects its own key or requires `auth: "user"`, so a service key or another user's token can never
leak through. `X-User-*`, `X-Client-IP`, `X-Forwarded-*`, `X-Real-IP` and `X-Geo-*` sent by a client
are always stripped and replaced with gateway-asserted values, regardless of `TRUST_PROXY`. `JWT`
verification is via JWKS (`kid`-based key selection); rotation is auth's responsibility (it can
serve a previous key alongside the current one). `METRICS_TOKEN` compared in constant time.
`injectApiKey` secrets and `METRICS_TOKEN` have no rotation mechanism of their own (change the env
var, restart). CORS is per-route allow-list, answered by the gateway itself for preflights. No
rotation for `RATELIMIT_API_KEY`/`GEO_API_KEY` beyond changing the env var and restarting.

## Scaling model

**A — stateless, horizontally scalable.** Any number of instances behind a load balancer works;
nothing here is written to disk. Per-instance state that does **not** need to be, and today is not,
shared across instances: the local per-IP rate limiter (`src/rate-limiter.js`, in-memory fixed
1-minute window — each instance enforces its own copy, so the *effective* limit across N instances
is up to N× the configured value), each instance's own circuit breaker state per upstream
(`UpstreamPool`/`Upstream`, Stage 9 — one instance's breaker opening for an upstream does not
inform the others; each independently discovers the same failure), and the geo lookup cache
(`GeoClient`, per instance, ≤20 000 entries). The optional central `policy` check (via ratelimit) is
shared correctly across instances by design — that is its purpose.

## Single-node / multi-node guarantees

Any number of gateway instances may run concurrently against the same `routes.json` and the same
upstreams safely; there is no shared state to corrupt. The three per-instance caches named above
mean each instance's *local* limits, upstream health, and geo cache diverge slightly from its
siblings — this is a known, accepted trade-off for a stateless edge, not a defect, but it means the
local `rateLimit` on a route is not a hard multi-instance ceiling.

## Known failure modes

- An upstream that is down: served 502/504 for that request; after `UPSTREAM_BREAKER_THRESHOLD`
  (default 1) consecutive failures its breaker opens for `UPSTREAM_COOLDOWN_MS` and it is skipped by
  that instance's pool (not other instances'). See "Circuit breaker and live reload" below.
- JWKS unreachable: every `auth: "user"` request gets `503 AUTH_UNAVAILABLE` until it recovers.
- ratelimit/geo unreachable: per-route `policy.failOpen` (Stage 9: **required, no default** —
  see below) decides — `true` lets the request through and increments
  `gateway_dependency_errors_total`; `false` answers `503 RATE_LIMIT_UNAVAILABLE`. `geo: true`
  routes always fail open (empty `X-Geo-*` headers), there is no fail-closed option for geo.
- Process killed without SIGTERM (SIGKILL, OOM): in-flight requests are dropped mid-response; no
  state to corrupt on restart since none is persisted.
- Misconfigured route referencing an `injectApiKey` env var that is unset, a `policy`/`geo` route
  with the corresponding service not configured, or (Stage 9) a `policy` block with no `failOpen`:
  caught at startup (`ConfigError`), the process refuses to start rather than serving broken routes.
  The same checks run again on every `SIGHUP` reload — a routes.json that newly fails any of them is
  refused (logged, previous configuration keeps serving), not a process restart.

## Circuit breaker and live reload (Stage 9)

**Circuit breaker** (`src/upstream-pool.js`): each `Upstream` (not each route) is `closed` (serving,
counting consecutive failures), `open` (skipped for `UPSTREAM_COOLDOWN_MS`) or `half-open` (cooldown
elapsed, exactly one probe request let through — every other concurrent selection keeps treating it
as unavailable, never as an ordinary healthy pick, until that probe settles). `now` is always
caller-supplied (never `Date.now()` read internally by the state machine itself), so the whole
transition table is exercised deterministically in tests without real timers. A probe success closes
the breaker and resets its failure count; a probe failure re-opens it and restarts the cooldown. If
every upstream on a route is `open`, the pool still returns one deterministically (round-robin
order) rather than manufacture a `503` — the pre-existing "no deadlock" guarantee — without that
ride-along attempt ever claiming a second concurrent probe on the same upstream.

**Live reload** (`Application#reload`, wired to `SIGHUP`): re-reads and validates `routes.json`
(the exact same checks as startup, including the new `failOpen`-required rule and the
policy/geo-integration cross-check) and builds an entirely new `RouteTable` + set of `UpstreamPool`s
before ever touching live state; only on full success does it atomically swap `GatewayApi`'s
`routes`/`pools`/`routesRevision` fields in one synchronous assignment. A request already being
served captured its own `route`/`pool` reference before the swap and is completely unaffected —
it finishes against the exact upstream it started with, socket never dropped. The outgoing pools'
keep-alive agents are deliberately not force-destroyed on reload (that would kill in-flight sockets)
— their own idle-socket timeout (`UPSTREAM_CONNECT_TIMEOUT_MS`) reclaims them shortly after they go
idle; only final process shutdown forcibly destroys whichever pools are current at that moment.
Circuit breaker state is **not** migrated across a reload — new pools start every upstream `closed`;
this is accepted as the minimum safe semantics (a stale breaker state describing upstream objects
that no longer exist would be meaningless) and is not a security concern in this deployment model:
`SIGHUP` requires OS-level signal privilege on the gateway process itself, never reachable from an
HTTP client. A reload that fails validation changes nothing (old config keeps serving,
`routesRevision` unchanged) and is logged as a structured error, never a crash. Overlapping `SIGHUP`s
are serialized: one in flight coalesces a second into exactly one more pass, never two concurrent
reloads racing each other's file reads. `GET /v1/info`'s `routesRevision` (`<file mtime>-<16 hex
chars of a sha256 of the exact bytes parsed>`, never a secret — `injectApiKey` values live only in
`process.env`, never in the file) changes only on a successful swap.
