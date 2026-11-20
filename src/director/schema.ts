import { z } from 'zod';

/** JSON Schema sent to the director and external AI clients. */
export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema, ...description } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override: ({ jsonSchema }) => {
      // The director should only propose named arguments for fixed-shape objects.
      if (jsonSchema.type === 'object' && jsonSchema.properties && jsonSchema.additionalProperties === undefined) {
        jsonSchema.additionalProperties = false;
      }
    },
  });
  return description;
}

/**
 * The same schema as a compact, TypeScript-like signature (every type, bound, pattern and enum kept),
 * e.g. `{sequence: string /^[a-z0-9-]+$/, start: int(≥0), text: string(1–500), template?: "title-card"|"lower-third"}`.
 * Roughly a third of the size of the JSON Schema text, which matters when the director lists commands.
 */
export function schemaSignature(s: JsonSchema, depth = 0): string {
  if (depth > 12) return 'any';
  const desc = typeof s.description === 'string' && s.description ? ` /* ${s.description} */` : '';
  const range = (lo: unknown, hi: unknown, exLo?: unknown, exHi?: unknown): string => {
    const l = typeof lo === 'number' ? lo : typeof exLo === 'number' ? `>${exLo}` : null;
    const h = typeof hi === 'number' ? hi : typeof exHi === 'number' ? `<${exHi}` : null;
    if (l !== null && h !== null) return typeof l === 'number' && typeof h === 'number' ? `${l}–${h}` : `${l},${h}`;
    if (l !== null) return typeof l === 'number' ? `≥${l}` : `${l}`;
    if (h !== null) return typeof h === 'number' ? `≤${h}` : `${h}`;
    return '';
  };
  let out: string;
  if ('const' in s) out = JSON.stringify(s.const);
  else if (Array.isArray(s.type)) out = s.type.map((type) => schemaSignature({ ...s, type, description: undefined }, depth + 1)).join(' | ');
  else if (Array.isArray(s.enum)) out = (s.enum as unknown[]).map((v) => JSON.stringify(v)).join('|');
  else if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) out = ((s.oneOf ?? s.anyOf) as JsonSchema[]).map((o) => schemaSignature(o, depth + 1)).join(' | ');
  else
    switch (s.type) {
      case 'string': {
        const r = range(s.minLength, s.maxLength);
        out = `string${r ? `(${r})` : ''}${typeof s.pattern === 'string' ? ` /${s.pattern}/` : ''}`;
        break;
      }
      case 'integer':
      case 'number':
        {
          const r = range(s.minimum, s.maximum, s.exclusiveMinimum, s.exclusiveMaximum);
          out = `${s.type === 'integer' ? 'int' : 'number'}${r ? `(${r})` : ''}`;
        }
        break;
      case 'boolean':
        out = 'boolean';
        break;
      case 'null':
        out = 'null';
        break;
      case 'array': {
        let items: string;
        if (Array.isArray(s.items)) items = `[${(s.items as JsonSchema[]).map((i) => schemaSignature(i, depth + 1)).join(', ')}]`;
        else {
          const inner = schemaSignature((s.items as JsonSchema) ?? {}, depth + 1);
          items = inner.includes('|') && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`;
        }
        const r = range(s.minItems, s.maxItems);
        out = `${items}${r ? `(${r} items)` : ''}`;
        break;
      }
      case 'object': {
        const props = (s.properties ?? null) as Record<string, JsonSchema> | null;
        if (props) {
          const req = new Set((s.required as string[] | undefined) ?? []);
          out = `{${Object.entries(props)
            .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${schemaSignature(v, depth + 1)}`)
            .join(', ')}}`;
        } else if (s.additionalProperties && typeof s.additionalProperties === 'object') out = `{[key: string]: ${schemaSignature(s.additionalProperties as JsonSchema, depth + 1)}}`;
        else out = 'object';
        break;
      }
      default:
        out = 'any';
    }
  return `${out}${desc}`;
}
