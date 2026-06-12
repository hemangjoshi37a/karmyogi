/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

// Build identity injected by Vite `define` (see vite.config.ts). The running
// bundle compares `__APP_VERSION__` against the server's build-info.json to
// detect when a newer deploy is available, and the About modal shows them.
declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string

// occt-import-js ships no type declarations. The real, narrowly-typed surface we
// use is defined at the import site (core/meshImport.ts via a cast); this just
// satisfies the module resolver. The default export is the WASM module factory.
declare module 'occt-import-js' {
  const factory: (moduleArg?: unknown) => Promise<unknown>
  export default factory
}
