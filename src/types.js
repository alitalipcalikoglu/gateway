/** Shared JSDoc typedefs for the gateway. No runtime exports. */

/**
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {string} routesFile
 * @property {{ url: string, apiKey: string, timeoutMs: number }|null} ratelimit   Ratelimit service for route policies; null = off.
 * @property {{ url: string, apiKey: string, timeoutMs: number, cacheSec: number }|null} geo   Geo service for X-Geo-* headers; null = off.
 * @property {number} rateLimitMax          Default requests per minute per client IP.
 * @property {number} bodyLimit             Default request body limit in bytes.
 * @property {number} upstreamTimeoutMs     Time to first response byte.
 * @property {number} upstreamConnectTimeoutMs
 * @property {number} upstreamCooldownMs    How long a failed upstream is skipped.
 * @property {number} upstreamBreakerThreshold  Consecutive failures before the breaker opens.
 * @property {string|null} metricsToken     Bearer token for /metrics; null disables the endpoint.
 * @property {number} hstsMaxAge            0 disables HSTS.
 * @property {string} serverName            Value of the Via / Server headers.
 */

/** @typedef {import('./config.js').Config} Config */

/**
 * One entry of routes.json after validation and secret resolution.
 * @typedef {object} Route
 * @property {string} id
 * @property {string|null} host            Exact host to match (lower-case, no port), null = any.
 * @property {string} pathPrefix           Must start with "/". "/" matches everything.
 * @property {string|null} stripPrefix     Removed from the path before forwarding.
 * @property {string[]} upstreams          Origins like http://10.0.0.3:3003.
 * @property {string[]|null} methods       Allowed methods, null = any.
 * @property {'none'|'user'} auth          "user" = a valid end-user JWT is required.
 * @property {string|null} injectApiKey    Secret forwarded as Authorization: Bearer to the upstream.
 * @property {string[]|null} cors          Allowed origins ("*" allowed), null = no CORS headers.
 * @property {number|null} rateLimit       Per-IP requests per minute override.
 * @property {number|null} bodyLimit       Bytes override.
 * @property {number|null} timeoutMs       Upstream timeout override.
 * @property {string} healthPath           Upstream path polled by /ready.
 * @property {RoutePolicy|null} policy     Central rate limit policy checked through the ratelimit service.
 * @property {boolean} geo                 Add X-Geo-Country / X-Geo-Timezone / X-Geo-Continent from the geo service.
 */

/**
 * @typedef {object} RoutePolicy
 * @property {string} name                 Policy name in the ratelimit service.
 * @property {'ip'|'user'|'key'} subject   What is limited: client IP, authenticated user id, or the client's bearer token (hashed).
 * @property {number} cost
 * @property {boolean} failOpen            Let the request through when the ratelimit service is unavailable.
 */

/**
 * @typedef {object} JwtSettings
 * @property {string} jwksUrl
 * @property {string} issuer
 * @property {string} audience
 */

/**
 * @typedef {object} RoutesDocument
 * @property {Route[]} routes
 * @property {JwtSettings|null} jwt
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
