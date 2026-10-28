/**
 * Client chunk build.
 *
 * The core client (`lib/client.js`) stays a hand-written single file; only the
 * heavy editor slice is bundled here — CodeMirror 6 + Java syntax — into
 * `lib/client-codemirror.js`. The core fetches it on first use from
 * `GET /dsh-ris-ide/bundle/codemirror`, so the chunk never goes through the DSH
 * module loader (a chunk id is not in its resolution graph).
 *
 * Output shape: a browser CJS closure factory parked on the plugin-owned global
 * registry (`globalThis.__dshRisIdeChunks__.codemirror`), matching the pattern
 * DSH plugins use for lazy chunks.
 */
export default [
  {
    entry: { 'client-codemirror': 'src/chunks/codemirror.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    clean: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    inputOptions: {
      resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
    },
    noExternal: () => true,
    outputOptions: {
      entryFileNames: 'client-codemirror.js',
      codeSplitting: false,
      banner: 'globalThis.__dshRisIdeChunks__ = globalThis.__dshRisIdeChunks__ || {};\nglobalThis.__dshRisIdeChunks__.codemirror = (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; };',
    },
  },
]
