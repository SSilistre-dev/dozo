# Contributing to Dozo

Dozo is an independent fork of [Rakazo](https://github.com/elie222/rakazo) (Apache-2.0) that merges
upstream continuously. That shapes how changes are made here.

## Rules

- Read [`dozo/AGENTS.md`](../dozo/AGENTS.md) first. It applies to people as well as agents.
- Upstream files are not edited. Work goes into `dozo/`, or into new `dozo-*` files inside upstream
  directories. The few exceptions are listed there.
- The `CONTRIBUTING.md` at the repository root is upstream's file, kept unmodified. Its notes on the
  code and its tests still describe this tree; its contacts and its process are upstream's, not ours.

## Run and check

Everything runs in Docker; nothing is installed on the host.

- `make up` builds and starts the stack.
- `make olc` is the fast check. Run it after every change.
- `make qa` is the full gate. Run it before you open a pull request.

`make olc` needs a local `upstream-main` branch: [`dozo/SYNC.md`](../dozo/SYNC.md), Prerequisites.
Details: [`dozo/README.md`](../dozo/README.md).

## Pull requests

- One feature or fix per pull request, against `main`.
- Fill in the template: What, Why, Changes, Risk, Tested.
- The `dozo-gate` check must pass.
- This repository is public. Never commit secrets, `.env` files, private URLs or real user data.

Contributions to Dozo's own files (listed in [dozo/NOTICE](/dozo/NOTICE)) are licensed under the
Elastic License 2.0; changes to upstream's files go to upstream, under its Apache License 2.0.

## Questions and bugs

Open an [issue](https://github.com/SSilistre-dev/dozo/issues/new/choose). For a security
vulnerability, follow the [security policy](./SECURITY.md) and do not open a public issue.
