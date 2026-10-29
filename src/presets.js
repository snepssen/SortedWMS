/*
 * Starting points for whoever deploys SortedWMS. A preset turns category
 * features on or off and suggests a location plan. It does not delete stock.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SortedPresets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FEATURES = [
    ['temperatureZones', 'Temperature zones', 'Chill, frozen and ambient checks. Off for a garage or a dry goods room.'],
    ['lotExpiry', 'Lot and expiry', 'Batch numbers and best-before dates. Off when the goods do not expire.'],
    ['fefo', 'FEFO allocation', 'Ship the earliest expiry first. Needs lot and expiry. Off uses oldest receipt first.'],
    ['highValueSecurity', 'High-value plates', 'A full pallet gets a PAL and a MASTER. Consolidation keeps one of those MASTER plates and lists the PAL numbers on it.'],
  ];

  function plan(levels) {
    return { separator: '-', levels };
  }

  const PRESETS = [
    {
      id: 'chilled-dc',
      name: 'Chilled distribution centre',
      summary: 'Food, with temperature zones, lots and first-expired-first-out. Frozen can sit in its own zone.',
      features: { temperatureZones: true, lotExpiry: true, fefo: true, highValueSecurity: false },
      categories: { CHILL: 'Chilled', FROZEN: 'Frozen', AMBIENT: 'Ambient' },
      zones: ['chill', 'frozen', 'ambient'],
      locationPlan: plan([
        { key: 'cell', scheme: 'number', from: 1, to: 1, pad: 2 },
        { key: 'aisle', scheme: 'number', from: 1, to: 2, pad: 2 },
        { key: 'bay', scheme: 'number', from: 1, to: 2, pad: 2 },
        { key: 'position', scheme: 'number', from: 1, to: 2, pad: 1 },
        { key: 'height', scheme: 'number', from: 1, to: 2, pad: 1 },
      ]),
      virtual: [
        { code: 'CONSO00', role: 'consolidation', name: 'Consolidation' },
        { code: 'STAGE01', role: 'staging', name: 'Staging' },
      ],
    },
    {
      id: 'high-value',
      name: 'High-value warehouse',
      summary: 'Electronics and similar goods. PAL and MASTER plates, consolidation, optional lots. No temperature rules.',
      features: { temperatureZones: false, lotExpiry: true, fefo: false, highValueSecurity: true },
      categories: { ELEC: 'Electronics', COMP: 'Computers' },
      zones: [],
      locationPlan: plan([
        { key: 'cell', scheme: 'letter', from: 'A', to: 'A' },
        { key: 'aisle', scheme: 'number', from: 1, to: 2, pad: 2 },
        { key: 'bay', scheme: 'alphanumeric', letterFrom: 'A', letterTo: 'B', numberFrom: 1, numberTo: 2, pad: 0 },
        { key: 'position', scheme: 'number', from: 1, to: 2, pad: 0 },
        { key: 'height', scheme: 'letter', from: 'A', to: 'B' },
      ]),
      virtual: [{ code: 'CONSO00', role: 'consolidation', name: 'Consolidation conso00' }],
    },
    {
      id: 'home-garage',
      name: 'Home garage',
      summary: 'Shelves in a room or a garage. Names are words. No expiry, no temperature, no high-value plates.',
      features: { temperatureZones: false, lotExpiry: false, fefo: false, highValueSecurity: false },
      categories: { HOME: 'Household' },
      zones: [],
      locationPlan: plan([
        { key: 'cell', skip: true },
        { key: 'aisle', skip: true },
        { key: 'bay', scheme: 'word', words: ['Left', 'Right'] },
        { key: 'position', skip: true },
        { key: 'height', scheme: 'word', words: ['Floor', 'Middle', 'Top'] },
      ]),
      virtual: [],
    },
    {
      id: 'small-maker',
      name: 'Small maker',
      summary: 'Self-produced goods sold online. Lots and oldest-expiry-first, without a temperature regime.',
      features: { temperatureZones: false, lotExpiry: true, fefo: true, highValueSecurity: false },
      categories: { MADE: 'Made here', PACK: 'Packaging' },
      zones: [],
      locationPlan: plan([
        { key: 'cell', scheme: 'word', words: ['Workshop'] },
        { key: 'aisle', skip: true },
        { key: 'bay', scheme: 'number', from: 1, to: 3, pad: 0 },
        { key: 'position', skip: true },
        { key: 'height', scheme: 'word', words: ['Shelf', 'Bin'] },
      ]),
      virtual: [{ code: 'STAGE01', role: 'staging', name: 'Packing table' }],
    },
  ];

  return { FEATURES, PRESETS };
});
