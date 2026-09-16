# Operations

## Probes

```bash
curl -s $GW/health
# {"status":"ok"}
curl -s $GW/ready
# {"status":"ok","upstreams":{"auth-public":"1/1","media-user":"1/1","media-files":"1/1","web":"2/2"}}
```

`/ready` polls every upstream's `healthPath` (2 s timeout, cached 15 s) and is `503` when any route has zero healthy upstreams. Point load-balancer health checks at `/ready`, liveness at `/health`.

## Metrics

Enable with `METRICS_TOKEN` (≥ 32 chars):

```bash
curl -s $GW/metrics -H "Authorization: Bearer $METRICS_TOKEN"
```

```
gateway_requests_total{route="media-files",status="2xx"} 90211
gateway_requests_total{route="auth-public",status="4xx"} 318
gateway_request_duration_ms_bucket{route="media-files",le="50"} 88012
gateway_request_duration_ms_sum{route="media-files"} 1203993.1
gateway_request_duration_ms_count{route="media-files"} 90211
gateway_bytes_total{route="media-user",direction="in"} 4193021392
gateway_upstream_errors_total{route="web"} 7
gateway_rejected_total{reason="rate_limited"} 41
gateway_rejected_total{reason="unauthorized"} 12
gateway_rejected_total{reason="no_route"} 903
```

Without `METRICS_TOKEN` the endpoint answers `404`.

## Access log

One JSON line per request, `msg: "access"`:

```json
{ "level": 30, "time": 1758000508791, "msg": "access", "route": "media-user", "method": "PUT", "path": "/api/media/v1/files",
  "status": 201, "durationMs": 17.7, "ip": "203.0.113.9", "upstream": "http://10.0.0.3:3003", "ua": "Mozilla/5.0 …", "reqId": "2b1c…" }
```

`reqId` equals the `X-Request-Id` sent to the upstream and returned to the client; grep for it across services. `Authorization` and `Cookie` are never logged.

## TLS

Terminate at the gateway:

```
TLS_CERT_PATH=/etc/letsencrypt/live/api.example.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/api.example.com/privkey.pem
```

HSTS (`max-age=31536000; includeSubDomains`) is sent automatically; set `HSTS_MAX_AGE=0` to disable. Upstream connections stay plain HTTP on the private network, or `https://` origins if the services run with their own certificates.

Behind a CDN or another TLS terminator: leave TLS off, set `TRUST_PROXY=true`.

## Process manager

```bash
pm2 start ecosystem.config.cjs
pm2 reload gateway        # zero downtime; new process signals ready after listen()
```

Changing `routes.json` needs a reload. Broken routes stop the new process with a clear error and PM2 keeps the old one running only if you use `pm2 reload` (not `restart`).

## Docker

```bash
docker build -t atc-gateway .
docker run -d -p 443:3000 -v ./routes.json:/config/routes.json:ro -v /etc/letsencrypt:/etc/letsencrypt:ro --env-file .env atc-gateway
```

## Response headers added everywhere

```
server: atc-gateway
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
strict-transport-security: max-age=31536000; includeSubDomains   (TLS only)
x-request-id: …
via: 1.1 atc-gateway
```

Upstream `Server` and `X-Powered-By` are removed.
