# Geo headers

With `geo: true` on a route, the gateway asks the geo service where the client address is and forwards the answer as request headers, so upstream services get a country and time zone without any geolocation code of their own.

```
GEO_URL=http://10.0.0.12:3012
GEO_API_KEY=<the gateway key from GEO_API_KEYS, role read>
GEO_CACHE_SEC=600
```

```json
{ "id": "shop", "pathPrefix": "/", "host": "shop.example.com", "upstreams": ["http://10.0.0.30:8080"], "geo": true }
```

Upstream receives:

```
X-Geo-Country: TR
X-Geo-Timezone: Europe/Istanbul
X-Geo-Continent: AS
```

- Private, loopback and otherwise special addresses, and addresses the database does not know, produce empty values (`X-Geo-Country:` with no value), so upstreams can distinguish "unknown" from "not configured" (header absent).
- Answers are cached per address for `GEO_CACHE_SEC`; failures for one minute. A geo outage never fails a request: the headers are empty and `gateway_dependency_errors_total{dependency="geo"}` grows.
- `X-Geo-*` headers sent by clients are dropped on every route, with or without `geo`, so an upstream can trust them the same way it trusts `X-User-*`.
- Behind another proxy or CDN set `TRUST_PROXY=true`, otherwise every client looks like that proxy.

Typical uses upstream: default currency and language, nearest branch, a "prices shown in TRY" banner, tax rules, and blocking regions you cannot serve (do that at the upstream, with the country as one signal, not as proof).
