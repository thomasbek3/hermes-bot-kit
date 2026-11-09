// A faithful replica of how Hermes Desktop loads a runtime plugin, so tests
// exercise the built plugin.js exactly as the app does (fix: live Transcript
// crash). Ported from Hermes Agent (MIT, (c) Nous Research), commit 2bd378ed1b:
//
//  - apps/desktop/src/sdk/runtime.ts `pluginNamespaces` / `shimUrl` /
//    `sdkImportMap`: each bare specifier becomes a shim ESM module that
//    re-exports `globalThis.__HERMES_*__` (named exports from Object.keys of
//    the live namespace, default = `m.default ?? m`). Hermes serves the shims
//    as blob: URLs; Node cannot import blob: URLs, so these are data: URLs
//    with the identical source text.
//  - The production app builds those namespaces with rolldown's `__toESM(
//    require_react(), 1)` (dist/assets/capabilities-*.js: `Z=t(Sa(),1)`):
//    a getter per own key of module.exports plus `default`. `toEsm` below.
//  - apps/desktop/src/contrib/runtime-loader.ts `importSpecifierRe`,
//    `codeRanges`, `inCode`, `rewriteSpecifiers`: only mapped specifiers in
//    CODE (not strings or comments) are rewritten.
//
// React and react-dom come from Hermes's own node_modules when that checkout
// exists (~/.hermes/hermes-agent), else from this package's devDependencies
// (pinned to the same version, 19.3.0), always in production mode like the app.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const HERMES_ROOT = join(homedir(), '.hermes/hermes-agent')

/** require() rooted where React lives: Hermes's checkout first. */
export function reactRequire() {
  const hermes = join(HERMES_ROOT, 'node_modules/react/package.json')
  const base = existsSync(hermes) ? join(HERMES_ROOT, 'package.json') : join(HERE, '../package.json')
  return { require: createRequire(base), from: existsSync(hermes) ? 'hermes' : 'local' }
}

/** rolldown's __toESM(mod, 1): getters for every own key, plus default. */
export function toEsm(mod) {
  const target = Object.create(null)
  for (const key of Object.getOwnPropertyNames(mod)) {
    if (key === 'default') continue
    Object.defineProperty(target, key, { get: () => mod[key], enumerable: true })
  }
  Object.defineProperty(target, 'default', { value: mod, enumerable: true })
  return target
}

const identifier = /^[A-Za-z_$][\w$]*$/

/** runtime.ts shimUrl, as a data: URL. */
function shimUrl(globalKey) {
  const names = Object.keys(globalThis[globalKey]).filter(name => name !== 'default' && identifier.test(name))
  const source =
    `const m = globalThis.${globalKey};\n` +
    `export default m.default ?? m;\n` +
    (names.length ? `export const { ${names.join(', ')} } = m;\n` : '')
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

// ── runtime-loader.ts (verbatim logic) ────────────────────────────────────

const importSpecifierRe = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g
const regexKeywordRe = /^(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/

function isRegexStart(source, slash) {
  let j = slash - 1
  while (j >= 0 && /\s/.test(source[j])) j -= 1
  if (j < 0) return true
  const prev = source[j]
  if (prev === '+' || prev === '-') return source[j - 1] !== prev
  if (prev === ')' || prev === ']' || prev === "'" || prev === '"' || prev === '`') return false
  if (prev === '}') return true
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let k = j
    while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k])) k -= 1
    if (source[k] === '.') return false
    return regexKeywordRe.test(source.slice(k + 1, j + 1))
  }
  return true
}

function regexEnd(source, slash) {
  let j = slash + 1
  let inClass = false
  while (j < source.length) {
    const c = source[j]
    if (c === '\\') j += 2
    else if (c === '\n') return -1
    else if (c === '[') {
      inClass = true
      j += 1
    } else if (c === ']') {
      inClass = false
      j += 1
    } else if (c === '/' && !inClass) {
      j += 1
      while (j < source.length && /[A-Za-z]/.test(source[j])) j += 1
      return j
    } else j += 1
  }
  return -1
}

function codeRanges(source) {
  const ranges = []
  const stack = []
  let state = 'code'
  let codeStart = 0
  let i = 0
  const closeCode = end => {
    if (end > codeStart) ranges.push([codeStart, end])
  }
  while (i < source.length) {
    const ch = source[i]
    const next = i + 1 < source.length ? source[i + 1] : ''
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        closeCode(i)
        state = 'line-comment'
        i += 2
      } else if (ch === '/' && next === '*') {
        closeCode(i)
        state = 'block-comment'
        i += 2
      } else if (ch === "'") {
        closeCode(i)
        state = 'single'
        i += 1
      } else if (ch === '"') {
        closeCode(i)
        state = 'double'
        i += 1
      } else if (ch === '`') {
        closeCode(i)
        stack.push('template')
        state = 'template'
        i += 1
      } else if (ch === '/') {
        const end = isRegexStart(source, i) ? regexEnd(source, i) : -1
        if (end > 0) {
          closeCode(i)
          i = end
          codeStart = i
        } else i += 1
      } else if (ch === '}' && stack[stack.length - 1] === 'expr') {
        closeCode(i)
        stack.pop()
        state = 'template'
        i += 1
      } else i += 1
      continue
    }
    if (state === 'line-comment') {
      if (ch === '\n') {
        state = 'code'
        codeStart = i
      }
      i += 1
      continue
    }
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        i += 2
        state = 'code'
        codeStart = i
      } else i += 1
      continue
    }
    if (state === 'single' || state === 'double') {
      if (ch === '\\') i += 2
      else if (ch === (state === 'single' ? "'" : '"')) {
        i += 1
        state = 'code'
        codeStart = i
      } else if (ch === '\n') {
        i += 1
        state = 'code'
        codeStart = i
      } else i += 1
      continue
    }
    if (ch === '\\') i += 2
    else if (ch === '$' && next === '{') {
      stack.push('expr')
      state = 'code'
      i += 2
      codeStart = i
    } else if (ch === '`') {
      stack.pop()
      state = 'code'
      i += 1
      codeStart = i
    } else i += 1
  }
  closeCode(source.length)
  return ranges
}

function inCode(ranges, at) {
  for (const [start, end] of ranges) {
    if (at < start) return false
    if (at < end) return true
  }
  return false
}

export function unsupportedImports(source, map) {
  const ranges = codeRanges(source)
  const out = new Set()
  for (const m of source.matchAll(importSpecifierRe())) {
    if (m[3] && inCode(ranges, m.index ?? 0) && !map[m[3]]) out.add(m[3])
  }
  return [...out]
}

export function rewriteSpecifiers(source, map) {
  const ranges = codeRanges(source)
  return source.replace(importSpecifierRe(), (whole, pre, quote, spec, offset) =>
    map[spec] && inCode(ranges, Number(offset)) ? `${pre}${quote}${map[spec]}${quote}` : whole
  )
}

/**
 * Install the namespaces the way installPluginSdk does, then evaluate
 * `pluginFile` through the loader's rewrite. Returns { plugin, React,
 * ReactDOMClient, cleanup }.
 */
export async function loadPluginLikeHermes(pluginFile, sdkNamespace) {
  process.env.NODE_ENV = 'production'
  const { require, from } = reactRequire()
  const React = require('react')
  const jsx = require('react/jsx-runtime')
  const jsxDev = require('react/jsx-dev-runtime')
  const ReactDOMClient = require('react-dom/client')
  Object.assign(globalThis, {
    __HERMES_PLUGIN_SDK__: sdkNamespace,
    __HERMES_REACT__: toEsm(React),
    __HERMES_REACT_JSX__: toEsm(jsx),
    __HERMES_REACT_JSX_DEV__: toEsm(jsxDev)
  })
  const map = {
    '@hermes/plugin-sdk': shimUrl('__HERMES_PLUGIN_SDK__'),
    'react/jsx-dev-runtime': shimUrl('__HERMES_REACT_JSX_DEV__'),
    'react/jsx-runtime': shimUrl('__HERMES_REACT_JSX__'),
    react: shimUrl('__HERMES_REACT__')
  }
  const source = readFileSync(pluginFile, 'utf8')
  const bad = unsupportedImports(source, map)
  if (bad.length) throw new Error(`Hermes would refuse this plugin: unsupported import ${bad.join(', ')}`)
  const dir = mkdtempSync(join(tmpdir(), 'gbo-loader-'))
  const file = join(dir, 'plugin.mjs')
  writeFileSync(file, rewriteSpecifiers(source, map))
  const mod = await import(pathToFileURL(file).href)
  return { plugin: mod.default, React, ReactDOMClient, reactFrom: from, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
