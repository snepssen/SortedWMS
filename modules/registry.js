/*
 * The module registry. Core modules are the files in this folder. A site can
 * add its own from a directory (SORTED_MODULES, or useDirectory): plain files,
 * no download and no install. See docs/MODULES.md.
 *
 * Each module is data: id, name, description, version, dependencies,
 * conflicts, permissions, routes, menu entries, settings and upgrade steps.
 * This file does not turn a module on or off. The warehouse does that.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const extra = [];
  let configured = null;

  function check(mod, file) {
    if (!mod || typeof mod !== 'object') throw new Error(`${file}: a module file must export an object`);
    for (const key of ['id', 'name', 'description', 'version']) {
      if (mod[key] == null || mod[key] === '') throw new Error(`${file}: missing ${key}`);
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(mod.id)) throw new Error(`${file}: id ${mod.id} must be lowercase letters, digits or hyphens`);
    if (!Number.isInteger(mod.version) || mod.version < 1) throw new Error(`${file}: version must be a whole number from 1`);
    for (const step of mod.upgrades || []) {
      if (!Number.isInteger(step.version) || !step.id || typeof step.up !== 'function') throw new Error(`${file}: an upgrade needs version, id and up`);
    }
  }

  function fromDisk(dir) {
    if (typeof require !== 'function') return [];
    let fs; let path;
    try { fs = require('node:fs'); path = require('node:path'); } catch (e) { return []; }
    if (!dir || !fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js') && name !== 'registry.js' && !name.startsWith('_')).sort();
    return files.map((name) => {
      const mod = require(path.join(dir, name));
      check(mod, name);
      return mod;
    });
  }

  function coreDir() {
    if (typeof require !== 'function') return null;
    try { return require('node:path').join(__dirname); } catch (e) { return null; }
  }

  function thirdPartyDir() {
    if (configured) return configured;
    if (typeof process !== 'undefined' && process.env && process.env.SORTED_MODULES) return process.env.SORTED_MODULES;
    return null;
  }

  /** Point at a folder of third-party module files. Pass null to use only the core. */
  function useDirectory(dir) {
    configured = dir || null;
  }

  /** Test hook. Returns a function that removes the module again. */
  function register(mod) {
    check(mod, 'register');
    extra.push(mod);
    return () => {
      const at = extra.indexOf(mod);
      if (at >= 0) extra.splice(at, 1);
    };
  }

  function modules() {
    const list = [...fromDisk(coreDir()), ...fromDisk(thirdPartyDir()), ...((typeof globalThis !== 'undefined' && globalThis.SortedModules) || []), ...extra];
    const seen = new Map();
    for (const mod of list) {
      if (seen.has(mod.id)) throw new Error(`Two modules are named ${mod.id}`);
      seen.set(mod.id, mod);
    }
    const all = [...seen.values()];
    const ids = new Set(all.map((mod) => mod.id));
    for (const mod of all) {
      for (const dep of mod.dependencies || []) if (!ids.has(dep)) throw new Error(`${mod.id} depends on unknown module ${dep}`);
      for (const other of mod.conflicts || []) if (!ids.has(other)) throw new Error(`${mod.id} conflicts with unknown module ${other}`);
    }
    const colour = {};
    const visit = (id, stack) => {
      if (colour[id] === 1) throw new Error(`Module cycle: ${stack.concat(id).join(' -> ')}`);
      if (colour[id] === 2) return;
      colour[id] = 1;
      for (const dep of (seen.get(id).dependencies || [])) visit(dep, stack.concat(id));
      colour[id] = 2;
    };
    for (const mod of all) visit(mod.id, []);
    return all.sort((a, b) => a.id.localeCompare(b.id));
  }

  function get(id) {
    return modules().find((mod) => mod.id === id) || null;
  }

  /** What a preset turns on. A module that does not mention the preset stays on. */
  function presetModules(presetId) {
    const out = {};
    for (const mod of modules()) {
      const listed = mod.presets && Object.prototype.hasOwnProperty.call(mod.presets, presetId);
      out[mod.id] = listed ? Boolean(mod.presets[presetId]) : true;
    }
    return out;
  }

  function upgradeModules() {
    return modules().map((mod) => ({ id: mod.id, upgrades: mod.upgrades || [] }));
  }

  /**
   * Apply a patch to the on/off map. `current` and the result use false for off
   * and anything else for on, which is how a warehouse that never chose behaves.
   * Throws Unknown module, a dependency error (err.needs, err.offer) or a conflict.
   */
  function resolveChange(manifests, current, patch, options = {}) {
    const byId = new Map(manifests.map((mod) => [mod.id, mod]));
    const next = { ...(current || {}) };
    for (const [key, value] of Object.entries(patch || {})) {
      if (key === 'simple') { next.simple = Boolean(value); continue; }
      if (!byId.has(key)) throw new Error(`Unknown module ${key}`);
      next[key] = Boolean(value);
    }
    // A missing key is on, except a module that stays off until someone turns it on.
    const on = (id) => {
      if (Object.prototype.hasOwnProperty.call(next, id)) return next[id] !== false;
      const mod = byId.get(id);
      return !(mod && mod.defaultOn === false);
    };
    if (options.enableDependencies) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const mod of manifests) {
          if (!on(mod.id)) continue;
          for (const dep of mod.dependencies || []) {
            if (!on(dep)) { next[dep] = true; changed = true; }
          }
        }
      }
    }
    if (options.disableDependents) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const mod of manifests) {
          if (!on(mod.id)) continue;
          for (const dep of mod.dependencies || []) {
            if (!on(dep)) { next[mod.id] = false; changed = true; }
          }
        }
      }
    }
    for (const mod of manifests) {
      if (!on(mod.id)) continue;
      const missing = (mod.dependencies || []).filter((dep) => !on(dep));
      if (missing.length) {
        const names = missing.map((id) => byId.get(id).name);
        const err = new Error(`${mod.name} needs ${names.join(' and ')}`);
        err.needs = missing;
        err.dependents = [mod.id];
        const switchedOff = missing.some((id) => patch && Object.prototype.hasOwnProperty.call(patch, id) && patch[id] === false);
        err.offer = switchedOff ? 'disable' : 'enable';
        throw err;
      }
      for (const other of mod.conflicts || []) {
        if (!on(other)) continue;
        const name = byId.has(other) ? byId.get(other).name : other;
        const err = new Error(`${mod.name} conflicts with ${name}`);
        err.conflicts = [other];
        throw err;
      }
    }
    return next;
  }

  function routeWeight(route) {
    return route.weight || route.pattern.length;
  }

  /** The module that owns this request, or null when it is core. The longer pattern wins. */
  function routeModule(method, pathname) {
    let best = null;
    for (const mod of modules()) {
      for (const route of mod.routes || []) {
        if (route.method !== '*' && route.method !== method) continue;
        const re = route.compiled || (route.compiled = new RegExp(route.pattern));
        if (!re.test(pathname)) continue;
        const weight = routeWeight(route);
        if (!best || weight > best.weight) best = { id: mod.id, weight };
      }
    }
    return best ? best.id : null;
  }

  /**
   * When the module is off: 404 for a read, 403 for a write.
   * The body names the module so a screen can say why.
   */
  function denial(wh, method, pathname) {
    if (!wh || typeof wh.module !== 'function') return null;
    const id = routeModule(method, pathname);
    if (!id || wh.module(id)) return null;
    const mod = get(id);
    const read = method === 'GET' || method === 'HEAD';
    return {
      status: read ? 404 : 403,
      body: {
        error: `${mod.name} is switched off for this warehouse. An administrator can turn it on in setup.`,
        module: id,
      },
    };
  }

  function hiddenPermissions(wh) {
    const hidden = new Set();
    if (!wh || typeof wh.module !== 'function') return hidden;
    for (const mod of modules()) {
      if (wh.module(mod.id)) continue;
      for (const perm of mod.permissions || []) hidden.add(typeof perm === 'string' ? perm : perm.id);
    }
    return hidden;
  }

  function describe(wh) {
    const on = (id) => (!wh || typeof wh.module !== 'function' ? true : wh.module(id));
    return modules().map((mod) => ({
      id: mod.id,
      name: mod.name,
      label: mod.name,
      description: mod.description,
      hint: mod.description,
      version: mod.version,
      dependencies: mod.dependencies || [],
      conflicts: mod.conflicts || [],
      permissions: (mod.permissions || []).map((perm) => (typeof perm === 'string' ? { id: perm, label: perm } : { id: perm.id, label: perm.label || perm.id })),
      menu: mod.menu || [],
      handheld: mod.handheld || [],
      settings: mod.settings || null,
      presets: mod.presets || {},
      on: on(mod.id),
    }));
  }

  return {
    useDirectory, register, modules, get, presetModules, upgradeModules, resolveChange, routeModule, denial, hiddenPermissions, describe,
  };
});
