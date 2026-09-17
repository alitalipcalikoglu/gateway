import { readFileSync } from 'node:fs';
import { ConfigError } from './config.js';

/** @typedef {import('./types.js').Route} Route */
/** @typedef {import('./types.js').RoutesDocument} RoutesDocument */

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * Loads and validates routes.json, resolves `injectApiKey` secrets from the environment and
 * answers "which route handles this request". Longest path prefix wins; a host-specific route
 * beats a host-agnostic one with the same prefix.
 */
export class RouteTable {
  /**
   * @param {Route[]} routes
   * @param {import('./types.js').JwtSettings|null} jwt
   */
  constructor(routes, jwt) {
    this.routes = [...routes].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length || Number(b.host !== null) - Number(a.host !== null));
    this.jwt = jwt;
    if (this.routes.some((r) => r.auth === 'user') && !jwt) throw new ConfigError('routes with auth "user" need a top-level "jwt" section');
  }

  /**
   * @param {string} path
   * @param {NodeJS.ProcessEnv} [env]
   */
  static load(path, env = process.env) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new ConfigError(`cannot read routes file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`routes file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return RouteTable.parse(doc, env);
  }

  /**
   * @param {unknown} doc
   * @param {NodeJS.ProcessEnv} env
   */
  static parse(doc, env) {
    const v = new Validator();
    const root = v.object(doc, 'routes file');
    const list = v.array(root.routes, 'routes');
    if (list.length === 0) throw new ConfigError('routes must contain at least one route');
    const routes = list.map((item, i) => RouteTable.#route(v, item, `routes[${i}]`, env));
    if (new Set(routes.map((r) => r.id)).size !== routes.length) throw new ConfigError('route ids must be unique');
    const keys = routes.map((r) => `${r.host ?? '*'}${r.pathPrefix}`);
    if (new Set(keys).size !== keys.length) throw new ConfigError('two routes share the same host and pathPrefix');
    let jwt = null;
    if (root.jwt !== undefined && root.jwt !== null) {
      const j = v.object(root.jwt, 'jwt');
      jwt = {
        jwksUrl: v.url(j.jwksUrl, 'jwt.jwksUrl'),
        issuer: v.string(j.issuer, 'jwt.issuer', 1, 500),
        audience: v.string(j.audience, 'jwt.audience', 1, 200),
      };
    }
    return new RouteTable(routes, jwt);
  }

  /**
   * @param {Validator} v
   * @param {unknown} item
   * @param {string} where
   * @param {NodeJS.ProcessEnv} env
   * @returns {Route}
   */
  static #route(v, item, where, env) {
    const o = v.object(item, where);
    const id = v.string(o.id, `${where}.id`, 1, 60);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ConfigError(`${where}.id must be lower-case letters, digits and dashes`);
    const pathPrefix = v.string(o.pathPrefix, `${where}.pathPrefix`, 1, 500);
    if (!pathPrefix.startsWith('/') || pathPrefix.includes('..') || /\s/.test(pathPrefix)) throw new ConfigError(`${where}.pathPrefix must be an absolute path`);
    let stripPrefix = o.stripPrefix === undefined || o.stripPrefix === null ? null : v.string(o.stripPrefix, `${where}.stripPrefix`, 1, 500);
    if (stripPrefix !== null) {
      stripPrefix = stripPrefix.replace(/\/+$/, '');
      if (stripPrefix !== '' && !pathPrefix.startsWith(stripPrefix)) throw new ConfigError(`${where}.stripPrefix must be a prefix of pathPrefix`);
      if (stripPrefix === '') stripPrefix = null;
    }
    const upstreams = v.array(o.upstreams, `${where}.upstreams`).map((u, i) => RouteTable.#origin(v.url(u, `${where}.upstreams[${i}]`), `${where}.upstreams[${i}]`));
    if (upstreams.length === 0) throw new ConfigError(`${where}.upstreams must contain at least one origin`);
    let methods = null;
    if (o.methods !== undefined && o.methods !== null) {
      methods = v.array(o.methods, `${where}.methods`).map((m, i) => v.string(m, `${where}.methods[${i}]`, 3, 7).toUpperCase());
      for (const m of methods) if (!METHODS.has(m)) throw new ConfigError(`${where}.methods contains unsupported method "${m}"`);
    }
    const auth = o.auth === undefined ? 'none' : v.string(o.auth, `${where}.auth`, 4, 4);
    if (auth !== 'none' && auth !== 'user') throw new ConfigError(`${where}.auth must be "none" or "user"`);
    let injectApiKey = null;
    if (o.injectApiKey !== undefined && o.injectApiKey !== null) {
      const envName = v.string(o.injectApiKey, `${where}.injectApiKey`, 1, 100);
      if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) throw new ConfigError(`${where}.injectApiKey must name an environment variable (UPPER_SNAKE_CASE)`);
      const secret = env[envName]?.trim();
      if (!secret) throw new ConfigError(`${where}.injectApiKey refers to ${envName}, which is not set`);
      if (secret.length < 32) throw new ConfigError(`${envName} must be at least 32 characters`);
      injectApiKey = secret;
    }
    let cors = null;
    if (o.cors !== undefined && o.cors !== null) {
      cors = v.array(o.cors, `${where}.cors`).map((c, i) => v.string(c, `${where}.cors[${i}]`, 1, 300).toLowerCase());
      for (const c of cors) if (c !== '*' && !/^https?:\/\/[^\s/]+$/.test(c)) throw new ConfigError(`${where}.cors entry "${c}" must be an origin or *`);
    }
    return {
      id,
      host: o.host === undefined || o.host === null ? null : v.string(o.host, `${where}.host`, 1, 253).toLowerCase(),
      pathPrefix,
      stripPrefix,
      upstreams,
      methods,
      auth: /** @type {'none'|'user'} */ (auth),
      injectApiKey,
      cors,
      rateLimit: o.rateLimit === undefined || o.rateLimit === null ? null : v.integer(o.rateLimit, `${where}.rateLimit`, 1),
      bodyLimit: o.bodyLimit === undefined || o.bodyLimit === null ? null : v.integer(o.bodyLimit, `${where}.bodyLimit`, 0),
      timeoutMs: o.timeoutMs === undefined || o.timeoutMs === null ? null : v.integer(o.timeoutMs, `${where}.timeoutMs`, 100),
      healthPath: o.healthPath === undefined || o.healthPath === null ? '/health' : v.string(o.healthPath, `${where}.healthPath`, 1, 200),
      policy: RouteTable.#policy(v, o.policy, `${where}.policy`, auth),
      geo: o.geo === undefined || o.geo === null ? false : v.boolean(o.geo, `${where}.geo`),
    };
  }

  /**
   * @param {Validator} v
   * @param {unknown} raw
   * @param {string} where
   * @param {string} auth
   * @returns {import('./types.js').RoutePolicy|null}
   */
  static #policy(v, raw, where, auth) {
    if (raw === undefined || raw === null) return null;
    const o = v.object(raw, where);
    const name = v.string(o.name, `${where}.name`, 1, 80);
    if (!/^[a-z0-9]+([.\-_][a-z0-9]+)*$/.test(name)) throw new ConfigError(`${where}.name must be a ratelimit policy name (lower-case segments)`);
    const subject = o.subject === undefined ? 'ip' : v.string(o.subject, `${where}.subject`, 2, 4);
    if (subject !== 'ip' && subject !== 'user' && subject !== 'key') throw new ConfigError(`${where}.subject must be "ip", "user" or "key"`);
    if (subject === 'user' && auth !== 'user') throw new ConfigError(`${where}.subject "user" needs auth "user" on the route`);
    return { name, subject: /** @type {'ip'|'user'|'key'} */ (subject), cost: o.cost === undefined || o.cost === null ? 1 : v.integer(o.cost, `${where}.cost`, 1), failOpen: o.failOpen === undefined || o.failOpen === null ? true : v.boolean(o.failOpen, `${where}.failOpen`) };
  }

  /**
   * @param {string} url
   * @param {string} where
   */
  static #origin(url, where) {
    const u = new URL(url);
    if (u.pathname !== '/' || u.search || u.hash || u.username) throw new ConfigError(`${where} must be a bare origin like http://host:port`);
    return u.origin;
  }

  /**
   * @param {string} host  Request host header (may carry a port).
   * @param {string} path  Request path without query.
   * @returns {Route|undefined}
   */
  match(host, path) {
    const h = host.split(':')[0].toLowerCase();
    return this.routes.find((r) => (r.host === null || r.host === h) && RouteTable.#prefixMatches(r.pathPrefix, path));
  }

  /**
   * "/api/" matches "/api/x" and "/api" (not "/apix"); "/" matches everything.
   * @param {string} prefix
   * @param {string} path
   */
  static #prefixMatches(prefix, path) {
    if (prefix === '/') return true;
    const bare = prefix.replace(/\/+$/, '');
    return path === bare || path.startsWith(`${bare}/`);
  }

  /**
   * Path to send upstream.
   * @param {Route} route
   * @param {string} path
   */
  static rewrite(route, path) {
    if (!route.stripPrefix) return path;
    const rest = path.slice(route.stripPrefix.length);
    return rest.startsWith('/') ? rest : `/${rest}`;
  }
}

/** Tiny structural validator producing ConfigError messages with a location. */
class Validator {
  /** @param {unknown} v @param {string} where */
  boolean(v, where) {
    if (typeof v !== 'boolean') throw new ConfigError(`${where} must be true or false`);
    return v;
  }

  /**
   * @param {unknown} v
   * @param {string} where
   * @returns {Record<string, any>}
   */
  object(v, where) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
    return /** @type {Record<string, any>} */ (v);
  }

  /**
   * @param {unknown} v
   * @param {string} where
   * @returns {unknown[]}
   */
  array(v, where) {
    if (!Array.isArray(v)) throw new ConfigError(`${where} must be an array`);
    return v;
  }

  /**
   * @param {unknown} v
   * @param {string} where
   * @param {number} min
   * @param {number} max
   */
  string(v, where, min, max) {
    if (typeof v !== 'string' || v.length < min || v.length > max) throw new ConfigError(`${where} must be a string of ${min}..${max} characters`);
    return v;
  }

  /**
   * @param {unknown} v
   * @param {string} where
   * @param {number} min
   */
  integer(v, where, min) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new ConfigError(`${where} must be an integer >= ${min}`);
    return v;
  }

  /**
   * @param {unknown} v
   * @param {string} where
   */
  url(v, where) {
    const s = this.string(v, where, 1, 2000);
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new ConfigError(`${where} must be an absolute URL`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`${where} must use http or https`);
    return s;
  }
}
