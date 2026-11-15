'use strict';

// Restoring account data must not revive an earlier login or pairing attempt.
const TRANSIENT = ['sessions', 'mfa_challenges', 'pair_tokens', 'pair_failures'];

function clearTransient(db) {
  for (const name of TRANSIENT) {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)) db.exec(`DELETE FROM ${name}`);
  }
}

module.exports = { TRANSIENT, clearTransient };
