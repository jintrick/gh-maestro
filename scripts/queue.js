'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Characters that are not allowed in 'to' (recipient) and messageId fields.
 * These would allow path traversal (..) or path separator injection.
 */
const INVALID_FIELD_RE = /[\/\\:*?"<>|\x00-\x1f]/;
const PARENT_REF_RE = /(?:^|[\/\\])\.\.(?:$|[\/\\])/;

/**
 * Validate a queue field value for path-safety.
 * Throws if the value contains path separators, `..`, or other unsafe chars.
 */
function validateField(name, value) {
  if (!value) return;
  if (PARENT_REF_RE.test(value)) {
    throw new Error(`"${name}" に親ディレクトリ参照（..）は許可されません: ${JSON.stringify(value)}`);
  }
  if (INVALID_FIELD_RE.test(value)) {
    throw new Error(`"${name}" に不正な文字が含まれています: ${JSON.stringify(value)}`);
  }
}

/**
 * Synchronous sleep using Atomics.wait (available from Node 18).
 * Blocks the current thread for `ms` milliseconds without spinning.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retry wrapper for EBUSY / EPERM (Windows virus scanner temporary lock).
 * Retries up to `maxRetries` times with `delayMs` interval, then throws
 * the last error. Other errno are thrown immediately.
 */
function withRetry(fn, maxRetries = 5, delayMs = 20) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        lastError = err;
        if (attempt < maxRetries) {
          sleepSync(delayMs);
        }
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

/**
 * Generate a messageId in the form:
 *   <UTC ISO8601 alphanumeric>-<6 hex chars>
 * Example: "20260705T120000123-a1b2c3"
 */
function generateMessageId() {
  const iso = new Date().toISOString();
  const datePart = iso.replace(/[^0-9T]/g, '');
  const randomPart = crypto.randomBytes(3).toString('hex');
  return `${datePart}-${randomPart}`;
}

function queueDir(workspace) {
  return path.join(workspace, '.gh-maestro', 'queue');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Enqueue a message into the filesystem queue.
 *
 * Writes to tmp/<messageId>.json.<random> then atomically renames to
 * inbox/<to>/<messageId>.json so that observers never see a partial write.
 *
 * @param {string} workspace  Absolute path to the workspace root.
 * @param {object} msg
 * @param {string} msg.to     Recipient name (required).
 * @param {string} msg.from   Sender name (required).
 * @param {string} [msg.kind] Message kind, defaults to "instruction".
 * @param {string} msg.body   Message body text (required).
 * @param {string} [msg.messageId]  Explicit ID; generated if omitted.
 * @returns {{ messageId: string, path: string }}
 */
function enqueue(workspace, { to, from, kind, body, messageId }) {
  if (!to) throw new Error('"to" is required');
  if (!from) throw new Error('"from" is required');
  if (!body) throw new Error('"body" is required');

  validateField('to', to);
  if (messageId) {
    validateField('messageId', messageId);

    // 重複 messageId チェック: 全 inbox で同一 messageId が存在しないことを確認する
    const inboxRoot = path.join(queueDir(workspace), 'inbox');
    try {
      if (fs.existsSync(inboxRoot)) {
        const entries = fs.readdirSync(inboxRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== to) {
            if (fs.existsSync(path.join(inboxRoot, entry.name, `${messageId}.json`))) {
              throw new Error(
                `messageId "${messageId}" は既に受信者 "${entry.name}" の inbox に存在します。` +
                `messageId は全受信者を通じて一意でなければなりません。`
              );
            }
          }
        }
      }
    } catch (err) {
      // Error message:  messageId "dup-id" は既に受信者 "worker-1" の inbox に存在します。
      if (err.message && err.message.includes('は既に受信者')) throw err;
      // TOCTOU: inboxRoot dir disappeared between existsSync and readdirSync
    }
  }

  const id = messageId || generateMessageId();
  const qDir = queueDir(workspace);
  const tmpDir = path.join(qDir, 'tmp');
  const inboxDir = path.join(qDir, 'inbox', to);

  ensureDir(tmpDir);
  ensureDir(inboxDir);

  const msg = {
    messageId: id,
    from,
    to,
    createdAt: new Date().toISOString(),
    kind: kind || 'instruction',
    body,
  };

  const tmpPath = path.join(tmpDir, `${id}.json.${crypto.randomBytes(3).toString('hex')}`);
  const targetPath = path.join(inboxDir, `${id}.json`);

  const json = JSON.stringify(msg);
  withRetry(() => { fs.writeFileSync(tmpPath, json, 'utf8'); });
  withRetry(() => { fs.renameSync(tmpPath, targetPath); });

  return { messageId: id, path: targetPath };
}

/**
 * Read and parse all .json files in a single inbox directory.
 * Unparseable files are silently skipped.
 */
function readMessagesFromDir(dir) {
  let files;
  try {
    if (!fs.existsSync(dir)) return [];
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    // dir disappeared between existsSync and readdirSync (TOCTOU)
    return [];
  }

  const messages = [];
  for (const file of files) {
    try {
      const content = withRetry(() => fs.readFileSync(path.join(dir, file), 'utf8'));
      messages.push(JSON.parse(content));
    } catch {
      // skip unparseable
    }
  }
  return messages;
}

/**
 * List pending messages.
 *
 * @param {string} workspace    Absolute path to the workspace root.
 * @param {string} [recipient]  Filter to one recipient; omit for all.
 * @returns {object[]}
 */
function listPending(workspace, recipient) {
  const inboxRoot = path.join(queueDir(workspace), 'inbox');

  if (recipient) {
    return readMessagesFromDir(path.join(inboxRoot, recipient));
  }

  if (!fs.existsSync(inboxRoot)) return [];

  const entries = fs.readdirSync(inboxRoot, { withFileTypes: true });
  const messages = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      messages.push(...readMessagesFromDir(path.join(inboxRoot, entry.name)));
    }
  }
  return messages;
}

/**
 * Acknowledge a message by moving it from inbox/<recipient>/ to acked/<recipient>/.
 *
 * Idempotent: if the message is already in acked, returns true without error.
 *
 * @param {string} workspace  Absolute path to the workspace root.
 * @param {string} messageId  The message ID to acknowledge.
 * @returns {boolean}  true if the message was found (inbox or acked), false otherwise.
 */
function ack(workspace, messageId) {
  const inboxRoot = path.join(queueDir(workspace), 'inbox');
  const ackedRoot = path.join(queueDir(workspace), 'acked');

  // Search all inbox directories for the message
  try {
    if (fs.existsSync(inboxRoot)) {
      const entries = fs.readdirSync(inboxRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const inboxFile = path.join(inboxRoot, entry.name, `${messageId}.json`);
        if (fs.existsSync(inboxFile)) {
          const ackedDir = path.join(ackedRoot, entry.name);
          ensureDir(ackedDir);
          const ackedFile = path.join(ackedDir, `${messageId}.json`);
          try {
            withRetry(() => { fs.renameSync(inboxFile, ackedFile); });
          } catch (err) {
            // ENOENT: another process already acked this message — treat as success
            if (err.code === 'ENOENT') return true;
            throw err;
          }
          return true;
        }
      }
    }
  } catch {
    // TOCTOU: inboxRoot dir disappeared between existsSync and readdirSync
  }

  // Not found in any inbox — check if already acked
  try {
    if (fs.existsSync(ackedRoot)) {
      const entries = fs.readdirSync(ackedRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (fs.existsSync(path.join(ackedRoot, entry.name, `${messageId}.json`))) {
            return true;
          }
        }
      }
    }
  } catch {
    // TOCTOU: ackedRoot dir disappeared
  }

  return false;
}

/**
 * Prune acknowledged messages older than maxAgeMs.
 *
 * Best-effort: deletion errors are silently swallowed.
 * Never touches pending (inbox) files.
 *
 * @param {string} workspace  Absolute path to the workspace root.
 * @param {number} maxAgeMs   Maximum age in milliseconds.
 */
function pruneAcked(workspace, maxAgeMs) {
  const ackedRoot = path.join(queueDir(workspace), 'acked');
  if (!fs.existsSync(ackedRoot)) return;

  const now = Date.now();
  let entries;
  try {
    entries = fs.readdirSync(ackedRoot, { withFileTypes: true });
  } catch {
    // TOCTOU: ackedRoot disappeared between existsSync and readdirSync
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(ackedRoot, entry.name);

    // Per-recipient processing: failures are best-effort, never propagate
    try {
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        try {
          const filePath = path.join(dirPath, file);
          const stat = fs.statSync(filePath);
          if (stat.isFile() && (now - stat.mtimeMs) > maxAgeMs) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // best effort — skip unreadable or already-deleted files
        }
      }
    } catch {
      // best effort — skip unreachable recipient directories
    }
  }
}

module.exports = { enqueue, listPending, ack, pruneAcked };
