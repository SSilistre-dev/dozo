<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/dozo/brand/assets/logo-dark.svg">
    <img src="/dozo/brand/assets/logo-light.svg" alt="Dozo" width="180">
  </picture>
</p>

Dozo is persistent AI bots, each with its own computer. This repository is its open source code.

## Use it

**Hosted.** [dozo-site.ssilistre.dev](https://dozo-site.ssilistre.dev), in closed preview.

**Desktop app.** [Latest release](https://github.com/SSilistre-dev/dozo/releases/latest), a preview
for macOS (Apple silicon) and Windows (x64).

**On your own machine.** You need Docker with the Compose v2 plugin (2.24.4 or newer), and `git`,
`make`, `tar`, `rsync`, `nc`, `openssl` and `curl`. The build needs network access and several GB of
RAM.

```
git clone https://github.com/SSilistre-dev/dozo.git
cd dozo
make up
```

`make up` builds the images, starts the stack on `127.0.0.1` and prints the address. `make down`
stops it and keeps the data. Details: [dozo/docker/README.md](/dozo/docker/README.md). Running it
on a server: [dozo/deploy/README.md](/dozo/deploy/README.md).

## Project

- [Contributing](/.github/CONTRIBUTING.md)
- [Reporting a vulnerability](/.github/SECURITY.md)
- Apache License 2.0: [LICENSE](/LICENSE), with the fork's notice of changes in
  [dozo/NOTICE](/dozo/NOTICE)

Dozo is an independent fork of [Rakazo](https://github.com/elie222/rakazo) (Apache-2.0). It is not
affiliated with or endorsed by the Rakazo project. How the fork is organised:
[dozo/README.md](/dozo/README.md).
