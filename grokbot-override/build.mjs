// Bundle src/ into the single committed plugin.js the Hermes runtime loader
// takes: plain ESM whose only imports are @hermes/plugin-sdk, react and
// react/jsx-runtime (the loader's allowlist).
//
//   node build.mjs                      write plugin.js
//   node build.mjs --check              fail if it is stale
//   node build.mjs --out <file>         write the bundle to another file
//   node build.mjs --probe ...          also run the read-only self-check
//                                       once after load (live verification)

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const check = args.includes('--check')
const probe = args.includes('--probe')
const outIndex = args.indexOf('--out')
const outFile = outIndex >= 0 ? resolve(args[outIndex + 1]) : resolve(root, 'plugin.js')

// The bundle is distributed as one file, so it carries every licence text it
// owes its recipients (Apache-2.0 §4(a), the MIT notice conditions) in a
// preserved /*! comment rather than pointing at files that may not travel with it.
const licence = file => readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n').trimEnd()
const indent = text => text.split('\n').map(line => (line ? ` * ${line}` : ' *')).join('\n')

const banner = `/*!
 * Grokbot Override — a Grok-Bot-style Bot Mode screen for Hermes Desktop.
 * BUILT FILE: edit grokbot-override/src/ and run \`npm run build\`.
 *
 * Licences of everything in this file (full texts below):
 *  - The override's own code: MIT, Copyright (c) 2026 Thomas Bekkers.
 *  - src/core/colors.js and the palette/type scale in src/ui/styles.ts are
 *    adapted from Rakazo (https://github.com/elie222/rakazo @ c800ad5),
 *    Copyright 2026 Rakazo contributors, Apache License 2.0.
 *    Modified 2026-11-08 by Thomas Bekkers: token names prefixed and scoped,
 *    colour maths takes a hex colour directly (see NOTICE.md in the source).
 *    Rakazo ships no NOTICE file. No trademark rights are granted (Apache-2.0 §6).
 *  - src/core/{routing,canonical,roster,segments}.js port small functions from
 *    Hermes Agent, MIT, Copyright (c) 2025 Nous Research; so do
 *    src/core/{botMeta,rosterView,attention,profileOps,cronOps,profileConfig,
 *    screen,usage}.js (ported from Bot Mode's own source) and the other
 *    src/core files whose header names Hermes Agent (see NOTICE.md).
 *  - The layout CSS in src/ui/styles-ref.ts is adapted from an MIT-licensed
 *    project, Copyright (c) 2026 Nick Vasilescu; its copyright and permission
 *    notice is reproduced below (LICENSE-THIRD-PARTY-MIT).
 *  - src/ui/stylesRoster.ts (menus, dialogs, form controls) adapts the look
 *    of Rakazo's packages/ui-web dialog / context-menu / dropdown-menu
 *    components, Apache License 2.0, Modified 2026-11-08 by Thomas Bekkers:
 *    rewritten as plain CSS on the --gbo-* tokens.
 *  - The bot screen bundles noVNC 1.7.0 core/rfb.js (the kit's
 *    computer-viewer/vendor/novnc-rfb.mjs), Copyright (C) The noVNC authors,
 *    Mozilla Public License 2.0 (https://www.mozilla.org/MPL/2.0/). Its Source
 *    Code Form is included unminified in this file (the module whose exports
 *    are "novnc_rfb_exports"); upstream: https://github.com/novnc/noVNC.
 *    It includes pako (MIT; Copyright (C) 1995-2013 Jean-loup Gailly and
 *    Mark Adler, (C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin), whose
 *    permission notice is the MIT text reproduced below.
 *
 * ─── MIT License (Grokbot Override / Hermes bot kit) ───────────────────────
 *
${indent(licence('../LICENSE'))}
 *
 * ─── MIT License (Hermes Agent, Nous Research) ─────────────────────────────
 *
${indent(licence('LICENSE-HERMES-AGENT-MIT'))}
 *
 * ─── MIT License (layout CSS in src/ui/styles-ref.ts) ──────────────────────
 *
${indent(licence('LICENSE-THIRD-PARTY-MIT'))}
 *
 * ─── Apache License 2.0 (Rakazo) ───────────────────────────────────────────
 *
${indent(licence('LICENSE-APACHE-2.0'))}
 */`

if (banner.slice(3, -2).includes('*/')) throw new Error('a licence text would close the banner comment early')

async function bundle() {
  const result = await build({
    entryPoints: [resolve(root, 'src/index.tsx')],
    // Source-path comments in the bundle are relative to this folder, whatever
    // the caller's working directory (review r1 #10).
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
    define: { __GBO_PROBE__: probe ? 'true' : 'false' },
    banner: { js: banner },
    legalComments: 'inline',
    charset: 'utf8',
    write: false,
    logLevel: 'warning'
  })
  return result.outputFiles[0].text
}

// The committed plugin.js is what the kit's root install.sh installs; its
// toggle starts on (a toggle the user already set wins).
for (const file of [outFile]) {
  const text = await bundle()
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (current !== text) {
      console.error(`${file} is stale: run \`npm run build\` in grokbot-override/`)
      process.exit(1)
    }
    console.log(`${basename(file)} is up to date`)
  } else {
    writeFileSync(file, text)
    console.log(`wrote ${file} (${text.length} bytes)`)
  }
}
