/**
 * The TypeScript type of a value that the literal JSON Schema `S` describes.
 *
 * It maps only the features that the manifest tool schemas use: `enum`,
 * `type: "string"`, and `type: "object"` with `properties` and `required`.
 * A property that is not in `required` is optional. A schema with another
 * feature maps to `unknown`, so code that reads that value fails the type check.
 */
export type FromSchema<S> = S extends { enum: readonly (infer E)[] }
  ? E
  : S extends { type: "string" }
    ? string
    : S extends { type: "object"; properties: infer P }
      ? ObjectFromSchema<P, S extends { required: readonly (infer R)[] } ? R : never>
      : unknown;

type ObjectFromSchema<P, Required> = Flatten<
  { -readonly [K in Extract<keyof P, Required>]: FromSchema<P[K]> } & {
    -readonly [K in Exclude<keyof P, Required>]?: FromSchema<P[K]>;
  }
>;

type Flatten<T> = { [K in keyof T]: T[K] };
