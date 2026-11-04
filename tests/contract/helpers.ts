import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { ERROR_STATUS, type ErrorCode } from '../../src/api/errors.js';

// ajv-formats is a CommonJS module; under NodeNext its default export needs this unwrap.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv) => Ajv;

const CONTRACT_PATH = fileURLToPath(
  new URL('../../specs/001-service-scheduler/contracts/openapi.yaml', import.meta.url),
);

/** Thrown when a response does not match specs/001-service-scheduler/contracts/openapi.yaml. */
export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

export interface ContractResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}

export interface ContractOperation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The path as written in the contract, e.g. `/appointments/{id}`. */
  path: string;
}

type Json = Record<string, unknown>;
interface Contract {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  components: { schemas: Record<string, Json>; responses: Record<string, unknown> };
}

let loaded: { doc: Contract; ajv: Ajv } | undefined;
const validators = new Map<string, ValidateFunction>();

function load() {
  if (loaded) return loaded;
  const doc = parse(readFileSync(CONTRACT_PATH, 'utf8')) as Contract;
  // OpenAPI 3.0 keywords such as `example` are not JSON Schema, so strict mode is off; `nullable`
  // and the string formats (uuid, date-time) are supported and enforced.
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(doc as unknown as Json, 'contract');
  loaded = { doc, ajv };
  return loaded;
}

/** Follow a local `$ref` such as `#/components/responses/Error` inside the contract. */
function resolve<T>(node: unknown): T {
  const { doc } = load();
  let current = node as { $ref?: string };
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    const pointer = current.$ref.replace(/^#\//, '').split('/');
    let target: unknown = doc;
    for (const part of pointer) target = (target as Record<string, unknown>)[part];
    current = target as { $ref?: string };
  }
  return current as T;
}

/** Point every local `$ref` at the registered contract document so Ajv can resolve it. */
function reroute(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(reroute);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        key === '$ref' && typeof value === 'string' && value.startsWith('#/')
          ? `contract${value}`
          : reroute(value),
      ]),
    );
  }
  return node;
}

function validatorFor(key: string, schema: unknown): ValidateFunction {
  let validate = validators.get(key);
  if (!validate) {
    validate = load().ajv.compile(reroute(schema) as Json);
    validators.set(key, validate);
  }
  return validate;
}

/** The error codes the contract declares. A test compares them with the code's status table. */
export function contractErrorCodes(): string[] {
  const schema = load().doc.components.schemas['Error'] as {
    properties: { error: { properties: { code: { enum: string[] } } } };
  };
  return schema.properties.error.properties.code.enum;
}

function mediaType(headers: Record<string, unknown>): string {
  const raw = headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
}

/**
 * Assert a response matches the contract for the given operation:
 *  - the status code is documented for that operation (the `default` response covers 5xx only),
 *  - the content type is one the contract lists, and
 *  - a JSON body validates against the documented schema, formats included.
 * For error bodies it also checks the error code belongs to the HTTP status.
 */
export function assertMatchesContract(
  response: ContractResponse,
  operation: ContractOperation,
): void {
  const { doc } = load();
  const label = `${operation.method} ${operation.path} -> ${response.statusCode}`;

  const pathItem = doc.paths[operation.path];
  if (!pathItem)
    throw new ContractViolation(`${label}: path ${operation.path} is not in the contract`);
  const op = pathItem[operation.method.toLowerCase()];
  if (!op)
    throw new ContractViolation(
      `${label}: ${operation.method} is not defined for ${operation.path}`,
    );

  const exact = op.responses[String(response.statusCode)];
  const fallback = response.statusCode >= 500 ? op.responses['default'] : undefined;
  if (!exact && !fallback) {
    throw new ContractViolation(
      `${label}: status ${response.statusCode} is not documented for this operation ` +
        `(documented: ${Object.keys(op.responses).join(', ')})`,
    );
  }
  const spec = resolve<{ content?: Record<string, { schema?: unknown }> }>(exact ?? fallback);

  if (!spec.content) return; // the contract documents no body for this response

  const received = mediaType(response.headers);
  const entry = spec.content[received];
  if (!entry) {
    throw new ContractViolation(
      `${label}: content-type "${received || 'none'}" is not documented (documented: ${Object.keys(spec.content).join(', ')})`,
    );
  }
  if (!entry.schema) return;

  let body: unknown = response.body;
  if (received === 'application/json') {
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new ContractViolation(`${label}: body is not valid JSON`);
    }
  }

  const validate = validatorFor(
    `${operation.path}|${operation.method}|${response.statusCode}|${received}`,
    entry.schema,
  );
  if (!validate(body)) {
    const problems = (validate.errors ?? [])
      .map(
        (e) =>
          `${e.instancePath || '(body)'} ${e.message}${e.params && 'allowedValues' in e.params ? ` ${JSON.stringify(e.params['allowedValues'])}` : ''}`,
      )
      .join('; ');
    throw new ContractViolation(`${label}: body does not match the contract: ${problems}`);
  }

  const code = (body as { error?: { code?: string } } | null)?.error?.code;
  if (code) {
    const expected = ERROR_STATUS[code as ErrorCode];
    if (expected !== response.statusCode) {
      throw new ContractViolation(
        `${label}: error code ${code} belongs to HTTP ${expected}, not ${response.statusCode}`,
      );
    }
  }
}
