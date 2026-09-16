/** Shared JSDoc typedefs for the gateway. No runtime exports. */

/**
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {string} routesFile
 * @property {number} rateLimitMax          Default requests per minute per client IP.
 * @property {number} bodyLimit             Default request body limit in bytes.
 * @property {number} upstreamTimeoutMs     Time to first response byte.
 * @property {number} upstreamConnectTimeoutMs
 * @property {number} upstreamCooldownMs    How long a failed upstream is skipped.
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
