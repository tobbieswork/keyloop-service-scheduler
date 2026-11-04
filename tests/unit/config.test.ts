import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const valid = {
  DATABASE_URL: 'postgres://scheduler:s3cret-pw@localhost:5432/scheduler',
};

describe('loadConfig', () => {
  it('applies defaults when only the required variable is set', () => {
    const config = loadConfig(valid);
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      databaseUrl: valid.DATABASE_URL,
    });
    expect(config.otlpEndpoint).toBeUndefined();
  });

  it('reads explicit values and converts PORT to a number', () => {
    const config = loadConfig({
      ...valid,
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      port: 8080,
      logLevel: 'debug',
      otlpEndpoint: 'http://localhost:4318',
    });
  });

  it('rejects a missing DATABASE_URL and names the variable', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '80.5'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'loud'],
    ['DATABASE_URL', 'mysql://localhost/db'],
    ['DATABASE_URL', 'not a url'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'nope'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => loadConfig({ ...valid, [key]: value })).toThrow(new RegExp(key));
  });

  it('reports every problem at once, not just the first', () => {
    try {
      loadConfig({ PORT: 'abc', LOG_LEVEL: 'loud' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toMatch(/DATABASE_URL/);
      expect(message).toMatch(/PORT/);
      expect(message).toMatch(/LOG_LEVEL/);
    }
  });

  it('never leaks a secret value into the error message', () => {
    const secretUrl = 'mysql://scheduler:s3cret-pw@localhost/db'; // wrong scheme, has a password
    try {
      loadConfig({ DATABASE_URL: secretUrl });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('s3cret-pw');
      expect(message).not.toContain(secretUrl);
      expect(message).toMatch(/DATABASE_URL/);
    }
  });

  it('treats empty strings as unset so an empty .env line uses the default', () => {
    const config = loadConfig({ ...valid, PORT: '', LOG_LEVEL: '' });
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
  });
});
