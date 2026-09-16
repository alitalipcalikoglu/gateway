# User-authenticated route

Scenario: logged-in users upload images from the browser. media needs a service key; the gateway verifies the user's access token and injects the key.

## Route

```json
{ "id": "media-user", "pathPrefix": "/api/media/", "stripPrefix": "/api/media",
  "upstreams": ["http://10.0.0.3:3003"], "auth": "user", "injectApiKey": "MEDIA_API_KEY",
  "cors": ["https://shop.example.com"], "bodyLimit": 26214400, "timeoutMs": 120000 }
```

```json
"jwt": { "jwksUrl": "http://10.0.0.2:3002/.well-known/jwks.json", "issuer": "https://api.example.com", "audience": "shop" }
```

`issuer` and `audience` must equal auth's `JWT_ISSUER` and `JWT_AUDIENCE`.

## From the browser

```js
await fetch('https://api.example.com/api/media/v1/files?visibility=public', {
  method: 'PUT',
  headers: { authorization: `Bearer ${accessToken}`, 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) },
  body: file,
});
```

## What media receives

```
PUT /v1/files?visibility=public
Authorization: Bearer <MEDIA_API_KEY>       ← user token replaced by the service key
X-User-Id: 313e3f1a-…                       ← from the verified JWT (sub)
X-User-Session: 9b6f…                       ← sid
X-User-Email: ali@example.com
X-User-Email-Verified: true
X-Client-IP: 203.0.113.9
X-Request-Id: …
```

Any `X-User-*` header sent by the client is discarded before these are set, so upstreams can trust them.

## Verification details

- Signature checked against the JWKS fetched from `jwksUrl` (cached 10 min; unknown `kid` triggers a refetch, so key rotation needs no gateway restart).
- Algorithm pinned to ES256, `iss`, `aud` and `exp` enforced, `sub` and `sid` required.
- The gateway does **not** call auth's introspection: a session revoked seconds ago still passes until the token expires (15 min by default). Upstreams that need instant revocation call `POST /v1/auth/introspect` themselves.

## Failures

| Status | Code | `WWW-Authenticate` | When |
|---|---|---|---|
| 401 | `UNAUTHORIZED` | `Bearer error="invalid_request"` | No `Authorization: Bearer` header |
| 401 | `INVALID` | `Bearer error="invalid_token"` | Bad signature, wrong issuer/audience, malformed |
| 401 | `EXPIRED` | `Bearer error="invalid_token"` | Token past `exp` → client should refresh and retry |
| 401 | `UNKNOWN_KEY` | | Signed by a key not in the JWKS |
| 503 | `AUTH_UNAVAILABLE` | | JWKS could not be fetched |

Client pattern: on `401 EXPIRED`, call the refresh endpoint (through the public auth route) and retry once.

## Using the headers in your own upstream

```js
app.addHook('onRequest', async (req, reply) => {
  if (req.headers.authorization !== `Bearer ${process.env.GATEWAY_KEY}`) return reply.code(401).send();
  req.userId = req.headers['x-user-id'];
});
```

Trust `X-User-*` only when the request carries the gateway's key; anything reaching the upstream by another path must not be trusted.
