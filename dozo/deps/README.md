# Fork dependencies

A fork feature that needs a package upstream does not ship lists it in `mobile.json`. The upstream
`package.json` and `pnpm-lock.yaml` stay untouched; the brand step (`dozo/docker/build.sh brand`)
adds the list to the staged tree, so every frozen install after it gets the packages: the unit
gate, the images and the iOS build (`dozo/mobile/build.sh`).

```json
{
  "importer": "apps/mobile",
  "add": ["name@1.2.3"],
  "integrity": { "name@1.2.3": "sha512-...", "its-dependency@4.5.6": "sha512-..." }
}
```

- `add`: exact versions, added to the importer's `dependencies`.
- `integrity`: every package the lockfile gains, the listed ones and their own dependencies, with
  its `dist.integrity` from the registry (`npm view name@1.2.3 dist.integrity`). A package upstream
  already locks needs no entry.

`apply.mjs` writes the staged manifest, lets pnpm (the version upstream pins) rewrite the staged
lockfile, and fails with exit 2 unless the result installs everything upstream's lockfile installs,
at the same versions and integrity, plus only the listed packages with the listed integrity. pnpm
may recompute an entry's peer context or registry metadata while rewriting the file; that changes
no version and no tarball, and is allowed. Choose versions that do not make pnpm move an upstream
one: a version of a package upstream already locks at another version usually does, because pnpm
dedupes it across the workspace, and the step then fails naming the package.

Resolving needs the npm registry. Each result is cached in the stage area (`dozo/.stage/deps-cache`,
or `deps-cache` under `DOZO_STAGE_DIR`) per input (upstream's lockfile, the importer's manifest and
the list), so the same input stages again offline; without a cached result and without a network
the step fails and says so. An empty `add` starts no container and leaves the staged tree as
upstream's.

The working tree's tools (tsc, Biome, an editor) do not see these packages: only the staged tree
has them. The fork's code that imports them is checked there, by the unit gate.
