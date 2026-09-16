import { createRemoteJWKSet, jwtVerify } from 'jose';

export class JwtError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

/**
 * Verifies end-user access tokens against the auth service's JWKS. Keys are fetched lazily,
 * cached, and refreshed when an unknown `kid` shows up (rotation).
 */
export class JwtVerifier {
  static ALG = 'ES256';

  /** @param {import('./types.js').JwtSettings} s */
  constructor(s) {
    this.issuer = s.issuer;
    this.audience = s.audience;
    this.jwks = createRemoteJWKSet(new URL(s.jwksUrl), { cacheMaxAge: 600_000, cooldownDuration: 30_000, timeoutDuration: 5_000 });
  }

  /**
   * @param {string} token
   * @returns {Promise<{ sub: string, sid: string, email: string, email_verified: boolean, jti: string, exp: number }>}
   */
  async verify(token) {
    try {
      const { payload } = await jwtVerify(token, this.jwks, { algorithms: [JwtVerifier.ALG], issuer: this.issuer, audience: this.audience });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new JwtError('INVALID', 'token lacks sub or sid');
      return /** @type {any} */ (payload);
    } catch (err) {
      if (err instanceof JwtError) throw err;
      const code = /** @type {{ code?: string }} */ (err).code ?? '';
      if (code === 'ERR_JWT_EXPIRED') throw new JwtError('EXPIRED', 'token expired');
      if (code === 'ERR_JWKS_NO_MATCHING_KEY' || code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS') throw new JwtError('UNKNOWN_KEY', 'token signed with an unknown key');
      if (code === 'ERR_JOSE_GENERIC' || code === 'ERR_JWKS_TIMEOUT' || /fetch|ECONN|ENOTFOUND/i.test(String(err))) throw new JwtError('JWKS_UNAVAILABLE', 'could not fetch signing keys');
      throw new JwtError('INVALID', 'token invalid');
    }
  }
}
