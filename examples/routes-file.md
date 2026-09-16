# Writing routes.json

The file is read once at start and validated strictly. Secrets are referenced by environment variable name, so the file can be committed.

## A minimal file

```json
{
  "routes": [
    { "id": "files", "pathPrefix": "/files/", "upstreams": ["http://10.0.0.3:3003"], "methods": ["GET", "HEAD"] }
  ]
}
```

`GET /files/abc/original` → `GET http://10.0.0.3:3003/files/abc/original`.

## Stripping a prefix

```json
{ "id": "auth", "pathPrefix": "/api/auth/", "stripPrefix": "/api/auth", "upstreams": ["http://10.0.0.2:3002"] }
```

`POST /api/auth/v1/auth/login?x=1` → `POST http://10.0.0.2:3002/v1/auth/login?x=1`. The query string is kept. `stripPrefix` must be a prefix of `pathPrefix`.

## Matching rules

- `pathPrefix: "/api/media/"` matches `/api/media` and `/api/media/…`, not `/api/mediax`.
- Longest prefix wins: `/api/media/` beats `/api/`.
- `host` restricts a route to one domain (compared without port, case-insensitive). With equal prefixes a host-bound route beats a host-agnostic one.
- `pathPrefix: "/"` is the catch-all; bind it to a `host` when the gateway fronts several domains.
- `/health`, `/ready` and `/metrics` are the gateway's own and are never forwarded.

## Several domains, one gateway

```json
{
  "routes": [
    { "id": "shop-web", "host": "shop.example.com", "pathPrefix": "/", "upstreams": ["http://10.0.0.10:8080", "http://10.0.0.11:8080"], "healthPath": "/healthz" },
    { "id": "blog-web", "host": "blog.example.com", "pathPrefix": "/", "upstreams": ["http://10.0.0.20:8080"] },
    { "id": "files",    "pathPrefix": "/files/", "upstreams": ["http://10.0.0.3:3003"], "methods": ["GET", "HEAD"] }
  ]
}
```

`/files/…` on either domain goes to media; everything else goes to the domain's web app.

## Validation

Start with a broken file and the process exits with the exact problem:

```
configuration error: routes[1].stripPrefix must be a prefix of pathPrefix
configuration error: routes[0].injectApiKey refers to MEDIA_API_KEY, which is not set
configuration error: two routes share the same host and pathPrefix
configuration error: routes with auth "user" need a top-level "jwt" section
```

Check a file without starting the server:

```bash
node --input-type=module -e "import { RouteTable } from './src/route-table.js'; RouteTable.load('./routes.json'); console.log('ok')"
```

## All fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | `[a-z0-9-]`, unique; appears in logs and metrics |
| `host` | string | optional exact host |
| `pathPrefix` | string | absolute path |
| `stripPrefix` | string | optional |
| `upstreams` | string[] | origins only, no path |
| `methods` | string[] | optional allow-list |
| `auth` | `"none"` \| `"user"` | default `none` |
| `injectApiKey` | string | env var name, UPPER_SNAKE_CASE, value ≥ 32 chars |
| `cors` | string[] | origins or `"*"` |
| `rateLimit` | int | per IP per minute |
| `bodyLimit` | int | bytes |
| `timeoutMs` | int | to first response byte |
| `healthPath` | string | default `/health` |
