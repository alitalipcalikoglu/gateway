// Type-only augmentation for the `apiKeyId` request decorator set in auth.js. No runtime code.
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId: string;
  }
}
