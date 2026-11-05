# Modules

A module is one feature a warehouse can switch on or off: kitting, billing, bins, camera scanning. The core stays on. That is locations, items, holders and their labels (PAL, MASTER, ST, INB, OUT, with a counter per warehouse that only goes up), stock, moves, users and roles, and the journal.

Switching a module off hides it. It does not delete anything. Switching it on brings the same data back. How a warehouse turns modules on and off is described with the settings screen; this page is how a module is written.

## Where modules live

Core modules are the files in `modules/`. One file, one module. `modules/registry.js` loads every other file in that folder.

A third-party module is the same kind of file in a folder you choose. There is no network install and no package to download.

- Environment: `SORTED_MODULES=/path/to/my-modules`
- Or, from code that starts the store: `require('./modules/registry').useDirectory('/path/to/my-modules')`

The server reads that folder from disk at start. A file that appears later is picked up on the next start.

## The file

The file is plain JavaScript, with no dependencies, so it loads in Node and in the browser. Copy `modules/returns.js` and change the fields.

```javascript
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SortedModules = root.SortedModules || []).push(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return {
    id: 'returns',                 // lowercase, stable, never renamed
    name: 'Returns',               // shown on the Modules screen
    description: 'Receive a return against a shipped order and grade it.',
    version: 1,                    // the module's own version, not the schema version
    dependencies: [],              // ids that must be on while this is on
    conflicts: [],                 // ids that cannot be on at the same time
    permissions: [                 // hidden from role editing while this is off
      { id: 'returns.write', label: 'Receive and grade returns' },
    ],
    routes: [                      // off: GET is 404, other methods are 403
      { method: '*', pattern: '^/api/returns(?:/|$)' },
    ],
    menu: [                        // removed from that slot while this is off
      { id: 'returns', label: 'Returns', slot: 'app' },
    ],
    handheld: [],                  // mode ids removed from the truck handheld
    settings: {                    // shown on the Modules screen
      type: 'object',
      properties: {
        restock: { type: 'boolean', title: 'Offer restock as a grade', default: true },
      },
    },
    presets: {                     // default for a new warehouse of that type
      'chilled-dc': true,
      'high-value': true,
      'home-garage': false,
      'small-maker': true,
      '3pl': true,
    },
    upgrades: [                    // data steps, run even while the module is off
      { version: 1, id: 'returns-kept', up(db) { /* CREATE TABLE IF NOT EXISTS … */ } },
    ],
  };
});
```

| Field | Meaning |
| --- | --- |
| `id` | Stable name. The warehouse stores this. Do not rename it. |
| `name`, `description` | What an administrator reads before switching it on. |
| `version` | Your module's version. Independent of every other module. |
| `dependencies` | Modules that must be on. Enabling this one can enable them too. Disabling one of them is refused while this is still on. |
| `conflicts` | Modules that cannot be on together. |
| `permissions` | Permission ids this module adds. They disappear from the role editor while the module is off, and the role keeps them for when it comes back. Use an id that already exists, or add it in `server/permissions.js`. |
| `routes` | `method` is `GET`, `POST`, `DELETE` or `*`. `pattern` is a regular expression matched against the path. A longer pattern wins when two modules could match, or set `weight`. |
| `menu` | `slot` is where it is drawn: `app` (role screens), `office` (the office tabs), `handheld`, `scan` (the camera button), `simple`, `station`, `demo`. |
| `handheld` | Truck modes (`auto`, `shift`, `pick`, `putaway`) that disappear with the module. |
| `settings` | A small JSON schema. `type`, and `properties` of `boolean`, `integer`, `number` or `string`, each with `title` and `default`. |
| `presets` | `chilled-dc`, `high-value`, `home-garage`, `small-maker`, `3pl`. Omit a preset and the module stays on for it. |
| `upgrades` | Schema steps for this module. See [UPGRADES.md](UPGRADES.md). They run on start and on backup import even while the module is off, so the data is ready when it is switched on. Do not delete rows in an upgrade. |

The behaviour (the warehouse methods) can live in `src/`, which is what the core modules do, because those files already load in the browser and in Node. A new module can keep its behaviour in the same file as the manifest, or in a file next to it that the manifest's methods call. The registry only requires the manifest.

## Rules that keep a module safe to switch

- Off means the routes answer **404** for a read and **403** for a write, the menu entries and handheld actions are not drawn, and the permissions are not listed. The rows stay.
- On again shows the same rows. Do not archive or clear them in the off switch.
- A dependency is declared here, not in a help sentence. `3PL billing` depends on `Clients`. `Transfers` depends on `More warehouses`.
- Two modules cannot use the same `id`. A cycle in `dependencies` is refused at start.
- A third-party file is trusted local code. Do not fetch it, and do not take a module from a URL.

## What the registry gives the server

`modules/registry.js`:

- `modules()` — the core modules, then the configured folder
- `get(id)`
- `presetModules(presetId)` — the on/off map for a preset
- `upgradeModules()` — the steps the store runs
- `resolveChange(manifests, current, patch, options)` — dependencies, conflicts, and the offer to enable or disable the related modules
- `routeModule(method, path)`, `denial(warehouse, method, path)`
- `hiddenPermissions(warehouse)`
- `describe(warehouse)` — the list the Modules screen shows
- `useDirectory(dir)` and `register(mod)` (the second is for tests)

A warehouse that has never chosen has every module on (`modules[id] !== false`). A preset writes an explicit true or false for each one.
