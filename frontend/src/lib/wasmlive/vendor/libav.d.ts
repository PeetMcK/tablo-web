/**
 * The vendored libav.js build, as far as TypeScript needs to know.
 *
 * The real API surface is enormous and untyped for this variant; `libavClient`
 * is the boundary that gives the parts we use types, so these declarations say
 * only how the modules are entered.
 */

declare module "*/libav-6.10.9.0-tablo-mpeg2.mjs" {
  const libav: {
    LibAV(options?: Record<string, unknown>): Promise<unknown>;
    [key: string]: unknown;
  };
  export default libav;
}

declare module "*/libav-6.10.9.0-tablo-mpeg2.wasm.mjs" {
  const factory: unknown;
  export default factory;
}
