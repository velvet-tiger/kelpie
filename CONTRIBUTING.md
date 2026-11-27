# Contributing to Kelpie

Kelpie is open source under AGPL-3.0. This file covers what a contributor
needs to know before opening a pull request against this repository.

## Copyright assignment

Every Contribution to Kelpie assigns its copyright to the Kelpie project.
The terms are in [`CLA.md`](CLA.md). Submitting a pull request is your
agreement to them; there is no separate signature step.

The AGPL-3.0 binds the people who run Kelpie. It does not transfer or
license away the copyright of the people who wrote it. Kelpie Cloud, a
separate paid product, adds proprietary modules on top of this open-source
core.

## Working on the code

[`README.md`](README.md) covers running the service locally, its
environment variables, and the `make` targets for setup and testing. Before
opening a pull request, run:

```bash
make test
npm run lint
npm run typecheck
```
