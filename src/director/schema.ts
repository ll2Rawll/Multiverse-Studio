/**
 * Describes a command's zod schema as JSON Schema, so the director sees exactly the arguments the
 * command layer validates. Covers the zod types the command definitions use; anything else is
 * described as "any" (and is still validated by zod when the command runs).
 */
import type { z } from 'zod';
/** JSON Schema (draft 2020-12 subset), returned to the model as text. */
export type JsonSchema = Record<string, unknown>;

type Def = { typeName?: string; [k: string]: unknown };

export function toJsonSchema(schema: z.ZodTypeAny, depth = 0): JsonSchema {
  const def = (schema as unknown as { _def: Def })._def;
  const description = (schema as unknown as { description?: string }).description;
  const withDesc = (s: JsonSchema): JsonSchema => (description ? { ...s, description } : s);
  if (depth > 12) return {};
  switch (def.typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const c of (def.checks as { kind: string; value?: number; regex?: RegExp }[]) ?? []) {
        if (c.kind === 'min') out.minLength = c.value;
        if (c.kind === 'max') out.maxLength = c.value;
        if (c.kind === 'regex' && c.regex) out.pattern = c.regex.source;
      }
      return withDesc(out);
    }
    case 'ZodNumber': {
      const checks = (def.checks as { kind: string; value?: number; inclusive?: boolean }[]) ?? [];
      const out: JsonSchema = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of checks) {
        if (c.kind === 'min') out[c.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = c.value;
        if (c.kind === 'max') out[c.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = c.value;
      }
      return withDesc(out);
    }
    case 'ZodBoolean':
      return withDesc({ type: 'boolean' });
    case 'ZodLiteral':
      return withDesc({ const: def.value as never });
    case 'ZodEnum':
      return withDesc({ type: 'string', enum: def.values as string[] });
    case 'ZodNativeEnum':
      return withDesc({ enum: Object.values(def.values as object) as never[] });
    case 'ZodArray': {
      const out: JsonSchema = { type: 'array', items: toJsonSchema(def.type as z.ZodTypeAny, depth + 1) };
      if (def.minLength) out.minItems = (def.minLength as { value: number }).value;
      if (def.maxLength) out.maxItems = (def.maxLength as { value: number }).value;
      return withDesc(out);
    }
    case 'ZodObject': {
      const shape = (typeof def.shape === 'function' ? (def.shape as () => Record<string, z.ZodTypeAny>)() : def.shape) as Record<string, z.ZodTypeAny>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = toJsonSchema(v, depth + 1);
        if (!v.isOptional()) required.push(k);
      }
      return withDesc({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
    }
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      return withDesc(toJsonSchema(def.innerType as z.ZodTypeAny, depth + 1));
    case 'ZodNullable': {
      const inner = toJsonSchema(def.innerType as z.ZodTypeAny, depth + 1);
      return withDesc({ anyOf: [inner, { type: 'null' }] });
    }
    case 'ZodEffects':
      return withDesc(toJsonSchema(def.schema as z.ZodTypeAny, depth + 1));
    case 'ZodPipeline':
      return withDesc(toJsonSchema(def.in as z.ZodTypeAny, depth + 1));
    case 'ZodLazy':
      return withDesc(toJsonSchema((def.getter as () => z.ZodTypeAny)(), depth + 1));
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = (Array.isArray(def.options) ? def.options : [...(def.options as Map<unknown, z.ZodTypeAny>).values()]) as z.ZodTypeAny[];
      return withDesc({ anyOf: options.map((o) => toJsonSchema(o, depth + 1)) });
    }
    case 'ZodRecord':
      return withDesc({ type: 'object', additionalProperties: toJsonSchema(def.valueType as z.ZodTypeAny, depth + 1) });
    case 'ZodTuple':
      return withDesc({ type: 'array', items: (def.items as z.ZodTypeAny[]).map((i) => toJsonSchema(i, depth + 1)) as never });
    case 'ZodNull':
      return withDesc({ type: 'null' });
    default:
      return withDesc({});
  }
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
  else if (Array.isArray(s.enum)) out = (s.enum as unknown[]).map((v) => JSON.stringify(v)).join('|');
  else if (Array.isArray(s.anyOf)) out = (s.anyOf as JsonSchema[]).map((o) => schemaSignature(o, depth + 1)).join(' | ');
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
