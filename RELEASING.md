# Cutting a release

Releases are annotated tags named `vYYYY.MM.DD`. The install one-liners pin
that tag and check every copied file against that tag's `MANIFEST.sha256`.

## How to cut one

From a clean checkout of `master`:

```bash
bash scripts/release.sh vYYYY.MM.DD
git push origin HEAD
git push origin vYYYY.MM.DD
```

`scripts/release.sh` refuses a dirty tree and an existing tag. It rewrites
the pinned ref in the installers, root shims, README one-liners, and the
`RAW_REPO_URL` line in `computer-viewer/plugin.js`; regenerates
`MANIFEST.sha256` (strict: every path in `scripts/manifest-files.txt` must
exist); runs the same tests as CI; commits `release: <tag>`; and creates
the annotated tag. It does not push.

## What the manifest guarantees

`MANIFEST.sha256` is `sha256sum` format (`<hex>  <path>`), one line per
file any installer copies, sorted by path. `install.sh` stages every
needed file, checks each digest against the manifest, syntax-checks the
staged copies, and only then copies into `desktop-plugins/`. A digest
mismatch or a later copy failure leaves the destination unchanged (this
run's backups are restored and this run's new files are removed).

The manifest is a digest list, not a signature. Trust is the GitHub tag
plus the hashes recorded at that tag.

## How a user verifies

From a checkout at the tag:

```bash
shasum -a 256 -c MANIFEST.sha256
```

(`sha256sum -c MANIFEST.sha256` on GNU systems.) Then install from that
checkout with `KIT_SOURCE_DIR=. bash install.sh`, or use the pinned
one-liner that already fetches this file from the same tag.
