# Rate limits, body limits, timeouts, methods

Four guard rails, each with a service-wide default in `.env` and an optional per-route override in `routes.json`.

## Rate limit (per route, per client IP, per minute)

```
RATE_LIMIT_MAX=300           # default
"rateLimit": 60              # override on a login route
```

Every response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`. Over the limit:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 37
{ "error": { "code": "RATE_LIMITED", "message": "too many requests" } }
```

Counters are per gateway process and reset on a fixed one-minute window. Behind a CDN or load balancer set `TRUST_PROXY=true` so the client IP comes from `X-Forwarded-For`; otherwise every user shares the balancer's address and one limit.

## Body limit

```
BODY_LIMIT=1048576           # 1 MB default
"bodyLimit": 26214400        # 25 MB for the media upload route
```

Checked twice: `Content-Length` up front, then the actual bytes while streaming (chunked uploads cannot cheat). Result is `413 TOO_LARGE`; nothing is buffered or forwarded beyond the limit.

## Timeout

```
UPSTREAM_TIMEOUT_MS=30000
"timeoutMs": 120000          # long uploads/downloads
```

Measured until the upstream sends response headers. On expiry: `504 UPSTREAM_TIMEOUT`, the upstream is marked down for `UPSTREAM_COOLDOWN_MS`, and safe methods are retried once elsewhere (see [failover](upstream-failover.md)). Streaming a large response body after headers is not subject to this timeout.

## Methods

```json
"methods": ["GET", "HEAD"]
```

Anything else: `405 METHOD_NOT_ALLOWED` with an `Allow` header. Without `methods` every method is forwarded. `OPTIONS` must be listed when the route also declares `cors` and you want non-preflight `OPTIONS` forwarded; preflights are handled regardless.

## Trying it

```bash
for i in $(seq 1 5); do curl -s -o /dev/null -w '%{http_code} ' $GW/files/x; done   # with "rateLimit": 3 → 200 200 200 429 429
head -c 2000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST $GW/api/auth/v1/users --data-binary @-   # 413
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $GW/files/x                        # 405
```
