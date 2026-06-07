/// <reference types="vite/client" />

// occt-import-js ships no type declarations. The real, narrowly-typed surface we
// use is defined at the import site (core/meshImport.ts via a cast); this just
// satisfies the module resolver. The default export is the WASM module factory.
declare module 'occt-import-js' {
  const factory: (moduleArg?: unknown) => Promise<unknown>
  export default factory
}
