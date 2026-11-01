# Contributing to SortedWMS

Thanks for helping. SortedWMS aims to be a WMS any warehouse can run: a wall of bins at home as much as a reach-truck distribution centre. Changes that make it better for one kind of warehouse should not make it worse for the others.

## Getting started

You need Node.js 22.13 or newer, and nothing else.

```
git clone https://github.com/snepssen/SortedWMS.git
cd SortedWMS
npm test                    # every test
./start.sh sample home      # a sample warehouse at http://localhost:8080/login
npm run load-test           # how it holds up at size
```

## How the code is laid out

- **`src/`** holds the warehouse rules. Each file is a module that runs both in Node and in the browser (the GitHub Pages build runs the whole WMS client-side), so it has no dependencies and no `require` outside its loader. `src/engine.js` is the core; the other files install onto `Warehouse.prototype` from `src/foundation.js`.
- **Every change is a command** in `server/commands.js`. Commands are written to the journal, which is both the audit trail and how state is rebuilt on restart, so a command must give the same result when it is replayed. Reading state must never change it.
- **Every API route** is in `server/api.js` and **names a permission** in `server/permissions.js`; a test fails if one doesn't. `server/api.js` also runs in the browser, so no `require` at request time there either.
- **Screens** are plain HTML in `server/public/`, with no build step.
- **A new file in `src/`** goes into the copy list and the script list in `scripts/build-pages.js`, and into `src/foundation.js`'s loaders.

## What a change needs

- **Tests.** Add or change tests in `test/` for what you change, and run `npm test`. Many build on the made-up warehouse in `test/fixtures/`.
- **Made-up data only.** No real company, product, customer, location or barcode in code, tests or docs. For GS1 numbers use GS1's documentation prefix (`0614141`) with real check digits: `GS1.makeGtin13('614141', n)` and `GS1.makeSscc(0, '0614141', n)`.
- **Plain words** in screens and docs: the people using it are on the floor, not reading a manual.
- **No new dependencies**, and nothing that needs Docker or sudo to run.

## Reporting a problem

Open an issue with what you did, what you expected and what happened. A screenshot of the screen, or the error the screen or server printed, helps.

## Licence

By contributing you agree that your contribution is released under the [MIT License](LICENSE).
