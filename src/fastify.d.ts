// Type-only augmentation for request decorators. No runtime code.
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId: string;
    /** Set in an onRequest hook in http/gateway-api.js, before any route handler runs. */
    trace: import('./trace-context.js').TraceContext;
  }
}
