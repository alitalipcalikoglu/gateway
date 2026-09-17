# Central rate limit policies

The per-route `rateLimit` is a process-local guard per client IP. A `policy` is different: it asks the ratelimit service, so the limit is shared by every gateway instance, can be per user or per API key, has several windows (per minute and per day) and per-subject overrides and blocks managed from the console.

## Configure

```
RATELIMIT_URL=http://10.0.0.11:3011
RATELIMIT_API_KEY=<the gateway key from RATELIMIT_API_KEYS, role check>
```

Create the policies in the ratelimit service (or the console), then reference them:

```json
{
  "routes": [
    { "id": "api", "pathPrefix": "/api/", "upstreams": ["http://10.0.0.3:3003"], "auth": "user",
      "policy": { "name": "api", "subject": "user" } },
    { "id": "login", "pathPrefix": "/api/auth/login", "upstreams": ["http://10.0.0.2:3002"], "injectApiKey": "AUTH_API_KEY",
      "policy": { "name": "login", "subject": "ip", "failOpen": false } },
    { "id": "partners", "pathPrefix": "/partners/", "upstreams": ["http://10.0.0.20:8080"],
      "policy": { "name": "partner-api", "subject": "key", "cost": 1 } }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | Policy name in the ratelimit service. A missing policy counts as "service unavailable" (see below), so create it before deploying the route. |
| `subject` | `ip` (default): client address. `user`: the authenticated user id (`auth: "user"` required). `key`: a hash of the client's bearer token, so third-party API keys are limited without the gateway storing them; requests without a token fall back to the IP. |
| `cost` | Units per request, default 1. Heavier endpoints can charge more against the same policy. |
| `failOpen` | `true` (default): when the ratelimit service is unreachable, times out or answers 5xx, the request goes through and `gateway_dependency_errors_total{dependency="ratelimit"}` increments. `false`: the client gets `503 RATE_LIMIT_UNAVAILABLE` with `Retry-After: 5`. Use `false` for security limits (login, signup, codes), `true` for capacity limits. |

## What the client sees

Every checked request carries the standard headers of the most restrictive window:

```
RateLimit-Limit: 100
RateLimit-Remaining: 37
RateLimit-Reset: 23
```

When denied:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 23
{ "error": { "code": "RATE_LIMITED", "message": "too many requests" } }
```

A subject blocked by an override answers `429` with code `BLOCKED` and no `Retry-After`.

## Order of checks

The policy is checked after the local per-IP limit, the method allow-list and user authentication (so `subject: "user"` knows the user), and before the request is forwarded. A denied request never reaches the upstream and is counted in `gateway_rejected_total{reason="policy"}`.

## Latency

One extra round trip per request, typically under a millisecond on the same network, bounded by `RATELIMIT_TIMEOUT_MS` (300). Keep the ratelimit service close to the gateway.
