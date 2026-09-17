# gateway examples

Scenario-driven walkthroughs of every feature. The gateway itself has no API key; callers are browsers and public clients. Base URL below is `http://localhost:3000`; upstreams are the other services on a private network.

| Example | Shows |
|---|---|
| [Writing routes.json](routes-file.md) | Prefix and host matching, prefix stripping, several upstreams, validation errors |
| [Public route with an injected service key](public-route-with-injected-key.md) | Login/registration through the gateway; the browser never sees the auth key |
| [User-authenticated route](user-authenticated-route.md) | JWT verified against auth's JWKS, `X-User-*` headers, media uploads by end users |
| [CORS](cors.md) | Preflights answered at the edge, per-route origins |
| [Rate limits, body limits, timeouts, methods](limits.md) | The four guard rails and their error responses |
| [Upstream failover](upstream-failover.md) | Round-robin, cooldown, retry rules, 502 vs 504 |
| [Central rate limit policies](policies.md) | Per-user, per-key and per-IP quotas checked in the ratelimit service, fail-open vs fail-closed, headers |
| [Geo headers](geo-headers.md) | Country and time zone of the client on every request, cache, spoofing protection |
| [Operations](operations.md) | Readiness by upstream health, metrics, access logs, TLS, PM2, Docker |

Set up once:

```bash
export GW=http://localhost:3000
```
