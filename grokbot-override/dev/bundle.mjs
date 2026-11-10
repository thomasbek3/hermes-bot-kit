// Bundle dev/preview-entry.tsx with the fake SDK for node (render test,
// preview page) into dev/.out/ (git-ignored). Returns the bundle's path;
// callers delete its folder when done.

import { mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function bundlePreview() {
  const { build } = await import('esbuild')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  mkdirSync(join(root, 'dev/.out'), { recursive: true })
  const out = join(mkdtempSync(join(root, 'dev/.out/preview-')), 'preview.mjs')
  await build({
    entryPoints: [join(root, 'dev/preview-entry.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile: out,
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    alias: { '@hermes/plugin-sdk': join(root, 'dev/fake-sdk.ts') },
    define: { __GBO_PROBE__: 'false', 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error'
  })
  return out
}
