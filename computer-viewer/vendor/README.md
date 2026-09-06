# Vendored noVNC RFB

`novnc-rfb.mjs` is `@novnc/novnc@1.7.0` `core/rfb.js`, bundled to a single
ESM file so Hermes Desktop does not have to `import()` an unverified CDN
build. The default export is the RFB class.

- License: MPL-2.0 (noVNC core). Bundled `vendor/pako` is MIT.
- Upstream: https://github.com/novnc/noVNC / npm `@novnc/novnc@1.7.0`
- esbuild: 0.25.12
- npm pack tarball sha256: `32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903`
- `package/core/rfb.js` sha256: `c46dfefbf869eda0c6d06c5dd86c42e96fc8a77c125e91599a2cdf3841261564`
- This file sha256: `08b527c943eb410ffa1a35d7d14c018d9eba22363150c3dc35a70327f1e88a28`

The banner's `document`/`window` guard runs only when those globals are
missing (Node's test runner). Browsers skip it.

## Rebuild

From a temp directory, with this repo as `$REPO`:

```bash
npm pack @novnc/novnc@1.7.0
tar -xf novnc-novnc-1.7.0.tgz
npx --yes esbuild@0.25.12 package/core/rfb.js \
  --bundle --format=esm --target=es2022 \
  --outfile="$REPO/computer-viewer/vendor/novnc-rfb.mjs" \
  --legal-comments=inline \
  --banner:js="/* @novnc/novnc 1.7.0 core/rfb.js, bundled by esbuild for hermes-bot-kit. MPL-2.0. See vendor/README.md */
if (typeof globalThis.document === 'undefined') {
  function el() {
    const node = {
      style: {},
      id: '',
      appendChild(child) { child.parentNode = node; return child },
      removeChild() { return null },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      setAttribute() {},
      getAttribute() { return null }
    }
    return node
  }
  globalThis.document = { documentElement: {}, body: el(), captureElement: null, createElement: el, getElementById() { return null }, addEventListener() {}, removeEventListener() {} }
  if (typeof globalThis.MutationObserver === 'undefined') globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } }
  if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = function () {}
  if (typeof globalThis.removeEventListener !== 'function') globalThis.removeEventListener = function () {}
  if (typeof globalThis.getComputedStyle !== 'function') globalThis.getComputedStyle = function () { return { cursor: '' } }
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis
}"
shasum -a 256 "$REPO/computer-viewer/vendor/novnc-rfb.mjs"
node -e "import('$REPO/computer-viewer/vendor/novnc-rfb.mjs').then(m=>console.log(typeof m.default))"
```

The last line should print `function`.

After rebuilding, update `VENDORED_RFB_SHA256` in `plugin.js`. The test
suite fails otherwise.
