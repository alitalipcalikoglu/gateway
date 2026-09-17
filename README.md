# gateway

The single public entry point in front of the other services. It routes by host and path prefix, verifies end-user access tokens against the auth service's JWKS, injects per-service API keys, applies rate limits, CORS, method allow-lists, body limits and timeouts, and streams requests and responses without buffering.

Runtime dependencies: `fastify`, `jose`. No database. The folder is self-contained: copy it to any host with Node 22 and run.

```
browser ──HTTPS──▶ gateway ──▶ auth   (POST /v1/auth/login …, service key injected)
                          ├──▶ media  (user JWT → X-User-*, service key injected)
                          ├──▶ media  (public /files/…, no auth)
                          └──▶ your web app / API
```

## Run

```bash
cp .env.example .env               # service keys, metrics token
cp routes.example.json routes.json # upstream addresses, prefixes, auth mode per route
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (routes mounted read-only):

```bash
docker build -t atc-gateway .
docker run -p 3000:3000 -v ./routes.json:/config/routes.json:ro --env-file .env atc-gateway
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Routes

`routes.json` is validated at startup; a bad file stops the process with the exact problem. The longest `pathPrefix` wins; a route with `host` beats one without for the same prefix.

| Field | Meaning |
|---|---|
| `id` | Lower-case identifier used in logs and metrics. |
| `host` | Optional exact host (no port). Lets one gateway front several domains. |
| `pathPrefix` | `/api/media/` matches `/api/media` and `/api/media/...`; `/` matches everything. |
| `stripPrefix` | Removed from the path before forwarding. Must be a prefix of `pathPrefix`. |
| `upstreams` | One or more origins, `http://host:port`. Round-robin; an origin that refuses connections is skipped for `UPSTREAM_COOLDOWN_MS`. |
| `methods` | Allow-list; anything else gets `405`. |
| `auth` | `none` (default) or `user`: a valid access token from the auth service is required. |
| `injectApiKey` | Name of an environment variable whose value is sent upstream as `Authorization: Bearer …`. The client's `Authorization` header is dropped. |
| `cors` | Allowed browser origins (or `*`). Preflights are answered by the gateway. Omit for non-browser routes. |
| `rateLimit`, `bodyLimit`, `timeoutMs` | Per-route overrides of the defaults in `.env`. |
| `healthPath` | Polled by `/ready`; default `/health`. |
| `policy` | `{ "name", "subject": "ip" \| "user" \| "key", "cost", "failOpen" }`: check the ratelimit service's policy per client IP, authenticated user or hashed bearer token before forwarding (`RATELIMIT_URL` / `RATELIMIT_API_KEY`). `failOpen` (default true) lets traffic through when the service is unavailable. |
| `geo` | `true` adds `X-Geo-Country`, `X-Geo-Timezone`, `X-Geo-Continent` from the geo service (`GEO_URL` / `GEO_API_KEY`), cached per address; client-sent `X-Geo-*` headers are always dropped. |

`jwt` (required when any route uses `auth: "user"`): `jwksUrl`, `issuer`, `audience` matching the auth service's configuration.

### What happens to a request

1. Match a route, else `404`.
2. CORS: if the route has `cors` and the request is a preflight, answer `204` here. Otherwise remember to add `Access-Control-Allow-Origin` for allowed origins.
3. Method allow-list → `405`.
4. Rate limit per route and client IP (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` on `429`).
5. `policy`: ask the ratelimit service (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; `429 RATE_LIMITED` or `BLOCKED`; `503 RATE_LIMIT_UNAVAILABLE` when the service is down and `failOpen` is false).
6. `geo`: look up the client address in the geo service and set the `X-Geo-*` headers.
5. `auth: "user"`: verify `Authorization: Bearer <jwt>` (ES256, issuer, audience, expiry) against the cached JWKS. On success the upstream receives `X-User-Id`, `X-User-Session`, `X-User-Email`, `X-User-Email-Verified`. Failure → `401` with `WWW-Authenticate`; JWKS unreachable → `503`.
6. Body limit: declared `Content-Length` checked up front, streamed bytes counted during upload → `413`.
7. Forward: hop-by-hop headers removed (including anything listed in `Connection`), client-supplied `X-Forwarded-*`, `X-Real-IP`, `X-Client-IP`, `X-User-*`, `X-Geo-*`, `Via` dropped and replaced with the gateway's own values, `Host` set to the upstream. `X-Request-Id` and `traceparent` are attached: a client-supplied value for either is honoured only when `TRUST_PROXY=true` (and, for `traceparent`, well-formed); otherwise a fresh one is generated. Both are echoed back on the response. Response is streamed back with `Server`/`X-Powered-By` removed and `Via` appended.
8. Connection failures mark the upstream down and retry once on another upstream for `GET`, `HEAD` and `OPTIONS` (never after the request body started). Otherwise `502 UPSTREAM_UNREACHABLE`. No response headers within the timeout → `504 UPSTREAM_TIMEOUT`.

Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Server: <SERVER_NAME>` and, with TLS, `Strict-Transport-Security`. Upstream-set values win.

### Gateway's own endpoints

| Path | Purpose |
|---|---|
| `GET /health` | Process is up. |
| `GET /ready` | Every route has at least one upstream answering its `healthPath` (cached 15 s). Returns per-route `healthy/total`. |
| `GET /metrics` | Prometheus text: requests by route and status class, latency histogram, bytes, upstream errors, rejections. Needs `Authorization: Bearer $METRICS_TOKEN`; disabled when unset. |

These three paths are reserved and never forwarded.

## Working with the other services

- Give the gateway its own key in each service (`AUTH_API_KEYS=gateway:…`, `MEDIA_API_KEYS=gateway:…`) and reference them from `routes.json` via `injectApiKey`. Rotating a key is a `.env` change and a restart.
- The auth service reads the end user's address from `X-Client-IP`, which the gateway always sets from the real client (spoof-proof). Set `TRUST_PROXY=true` only when a CDN or load balancer in front of the gateway sets `X-Forwarded-For`.
- Point the auth service's `JWT_ISSUER` at the gateway's public URL and expose `/.well-known/jwks.json` through a route (see the example), so any consumer can verify tokens.
- WebSockets and HTTP/2 to upstreams are not proxied; upstream connections are HTTP/1.1 keep-alive.

## Examples

Scenario walkthroughs for every feature live in [examples/](examples/README.md).

## Configuration

See [.env.example](.env.example). Nothing is required except the environment variables named by `injectApiKey` entries in your routes. `METRICS_TOKEN` enables `/metrics`.

## Security notes

- Secrets never live in `routes.json`; it only names environment variables, so the file can be versioned.
- Routes with `injectApiKey` and `auth: "none"` hand the service key to anonymous traffic. Use them only for endpoints designed for that (login, registration, public downloads) and constrain `methods` and `rateLimit`.
- Request bodies are streamed, never buffered; limits are enforced while streaming so an oversized upload is cut, not stored.
- Rate limiting and cooldown state are per process. Behind a TCP balancer with several gateway instances, limits apply per instance.
- Metrics token compared in constant time. `Authorization` and `Cookie` are redacted from logs.
- Container runs as the unprivileged `node` user.

## Code layout

Class-based; dependencies are injected through constructors, `src/application.js` is the composition root.

| Class | File | Role |
|---|---|---|
| `Application` | `src/application.js` | Wiring, startup, graceful shutdown |
| `Config` | `src/config.js` | Validated environment |
| `RouteTable` | `src/route-table.js` | routes.json validation, secret resolution, matching, rewriting |
| `UpstreamPool`, `Upstream` | `src/upstream-pool.js` | Round-robin, keep-alive agents, passive cooldown |
| `Proxy` | `src/proxy.js` | Header hygiene, streaming, limits, timeout, retry |
| `JwtVerifier` | `src/jwt-verifier.js` | JWKS-backed access token verification |
| `RateLimiter` | `src/rate-limiter.js` | Fixed-window per-client counters |
| `Metrics` | `src/metrics.js` | Counters, histograms, Prometheus rendering |
| `GatewayApi` | `src/http/gateway-api.js` | Request pipeline, CORS, probes, metrics endpoint |

## Out of scope by design

- WebSocket and gRPC proxying.
- Response caching and compression: keep them at the CDN or in the upstream.
- Shared (cross-instance) rate limiting: needs a shared store; add when running more than one gateway instance for the same clients.
- Hot reload of `routes.json`: restart (PM2 `reload` is zero-downtime thanks to `wait_ready`).

## Scaling model

Stateless and horizontally scalable: any number of instances behind a load balancer works, nothing
is written to disk. The local per-IP rate limiter, the passive upstream-cooldown state and the geo
lookup cache are per-instance, not shared — a route's local `rateLimit` is therefore not a hard
ceiling across instances. The central `policy` check (via ratelimit) is shared correctly by design.

## Observability

Accepts and generates `X-Request-Id` and `traceparent` under the same `TRUST_PROXY` trust boundary
(honoured only when set, generated fresh otherwise), forwards both to the matched upstream, and
echoes them on the response. Custom access-log line with `route`, `status`, `durationMs`, `reqId`,
`traceId`. `/metrics` (bearer `METRICS_TOKEN`) exposes per-route counters, a duration histogram and
rejection/dependency-error counters — all process-local, reset on restart.

## Backup / restore

No database. The only state to keep under version control is `routes.json` itself; restoring means
redeploying it and restarting.

See [docs/READINESS.md](docs/READINESS.md) for the full contract.

## License

MIT, see [LICENSE](LICENSE).
