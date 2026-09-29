'use strict';

const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const addMinutes = (iso, min) => new Date(new Date(iso).getTime() + min * 60000).toISOString();

/** 简易事务：node:sqlite 无 transaction 助手，手动 BEGIN/COMMIT。 */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

module.exports = { HttpError, now, sha256, addMinutes, tx };
