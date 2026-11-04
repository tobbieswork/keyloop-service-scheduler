import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import type { Config } from '../config.js';

const SERVICE_NAME = 'keyloop-service-scheduler';

/**
 * Run `fn` inside a span. The span records an error status and the exception if `fn` throws,
 * then the error is rethrown unchanged. Does nothing extra when tracing is not started, so it
 * is safe to use everywhere, including in tests.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return trace
    .getTracer(SERVICE_NAME)
    .startActiveSpan(name, { ...(attributes && { attributes }) }, async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}

/**
 * Start OpenTelemetry for the real server. Returns a function that flushes and stops it.
 * Spans go to the console unless OTEL_EXPORTER_OTLP_ENDPOINT is set, in which case the SDK's
 * default OTLP exporter reads that variable. Skipped in tests and when OTEL_SDK_DISABLED=true.
 */
export function startTracing(
  config: Pick<Config, 'nodeEnv' | 'otlpEndpoint'>,
): () => Promise<void> {
  if (config.nodeEnv === 'test' || process.env['OTEL_SDK_DISABLED'] === 'true') {
    return async () => {};
  }
  const sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
    ...(config.otlpEndpoint
      ? {}
      : { spanProcessors: [new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() })] }),
  });
  sdk.start();
  return () => sdk.shutdown();
}
