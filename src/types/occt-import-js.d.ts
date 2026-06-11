// occt-import-js ships no type declarations — declare the Emscripten factory and
// the Vite ?url import of its wasm so the STEP loader in GamepadModel3D typechecks.
declare module 'occt-import-js' {
  // The default export is an Emscripten module factory: call it (optionally with
  // { locateFile }) and await the resolved module, which exposes ReadStepFile.
  const factory: (opts?: { locateFile?: (path: string) => string }) => Promise<{
    ReadStepFile: (
      content: Uint8Array,
      params: unknown,
    ) => {
      success: boolean
      meshes: Array<{
        name?: string
        attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } }
        index?: { array: ArrayLike<number> }
      }>
    }
  }>
  export default factory
}

declare module 'occt-import-js/dist/occt-import-js.wasm?url' {
  const url: string
  export default url
}
