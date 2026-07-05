'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DUPLICATE_MESSAGE_ID = 'ERR_DUPLICATE_MESSAGE_ID';

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
              const err = new Error(
                `messageId "${messageId}" は既に受信者 "${entry.name}" の inbox に存在します。` +
                `messageId は全受信者を通じて一意でなければなりません。`
              );
              err.code = DUPLICATE_MESSAGE_ID;
              throw err;
            }
          }
        }
      }
    } catch (err) {
      // 安定した識別子（code プロパティ）で判定
      if (err.code === DUPLICATE_MESSAGE_ID) throw err;
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
 * Each returned message includes the absolute `path` to the inbox file.
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
      const filePath = path.join(dir, file);
      const content = withRetry(() => fs.readFileSync(filePath, 'utf8'));
      const msg = JSON.parse(content);
      msg.path = filePath;  // poller 通知が actionable なパスを表示できるように付与
      messages.push(msg);
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
 * Receive all pending messages for a specific recipient (active pull).
 *
 * Semantically identical to listPending(workspace, recipient) but framed as
 * an active receive operation — the recipient is polling their own inbox
 * rather than a third party listing messages. This is the primary delivery
 * path for workers: poll-inbox.js detects new messages by scanning the
 * inbox, and receive() reads the full message contents.
 *
 * @param {string} workspace  Absolute path to the workspace root.
 * @param {string} recipient  The recipient whose inbox to pull from (required).
 * @returns {object[]}  Array of pending messages (each with `path` set to the
 *                      absolute inbox file path). Empty if recipient has no
 *                      inbox directory or no pending messages.
 */
function receive(workspace, recipient) {
  if (!recipient) throw new Error('"recipient" is required');
  validateField('recipient', recipient);

  // readdirSync ENOENT is absorbed per queue-concurrency.md:
  // the inbox directory may not exist (no messages ever sent to this recipient)
  const inboxDir = path.join(queueDir(workspace), 'inbox', recipient);
  return readMessagesFromDir(inboxDir);
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
            // rename は mtime を保持するため、ack 時点で mtime を更新する。
            // これにより pruneAcked の保持期間が「ack 時点から」正しく計測される。
            try { fs.utimesSync(ackedFile, new Date(), new Date()); } catch {}
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
 * @returns {number}  Count of deleted files.
 */
function pruneAcked(workspace, maxAgeMs) {
  const ackedRoot = path.join(queueDir(workspace), 'acked');
  if (!fs.existsSync(ackedRoot)) return 0;

  const now = Date.now();
  let entries;
  try {
    entries = fs.readdirSync(ackedRoot, { withFileTypes: true });
  } catch {
    // TOCTOU: ackedRoot disappeared between existsSync and readdirSync
    return 0;
  }

  let deleted = 0;
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
            deleted++;
          }
        } catch {
          // best effort — skip unreadable or already-deleted files
        }
      }
    } catch {
      // best effort — skip unreachable recipient directories
    }
  }
  return deleted;
}

/**
 * Purge all pending messages for a recipient by deleting them from inbox.
 *
 * Best-effort: individual file deletion errors are silently swallowed and
 * counted as `failed`. The function never throws on IO errors — the caller
 * uses `failed > 0` to detect partial/total cleanup failure.
 *
 * Used when a worker is removed to prevent stuck message escalation.
 *
 * Idempotent and concurrency-safe: ENOENT is treated as success (another
 * process already handled it), and readdirSync/unlinkSync are wrapped in
 * try/catch per queue-concurrency.md TOCTOU/ENOENT absorption rules.
 *
 * @param {string} workspace  Absolute path to the workspace root.
 * @param {string} recipient  The recipient whose inbox to purge.
 * @returns {{ purged: number, failed: number }}
 */
function purgeInbox(workspace, recipient) {
  if (!recipient) throw new Error('"recipient" is required');
  validateField('recipient', recipient);

  const inboxDir = path.join(queueDir(workspace), 'inbox', recipient);

  let files;
  try {
    files = fs.readdirSync(inboxDir);
  } catch (err) {
    // ENOENT: inbox dir doesn't exist or was already removed — success
    if (err.code === 'ENOENT') return { purged: 0, failed: 0 };
    // Other errors (permissions, etc.) — best-effort, skip
    return { purged: 0, failed: 0 };
  }

  let purged = 0;
  let failed = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(inboxDir, file);
    try {
      withRetry(() => { fs.unlinkSync(filePath); });
      purged++;
    } catch (err) {
      // ENOENT: another process already deleted it — treat as success
      if (err.code === 'ENOENT') {
        purged++;
        continue;
      }
      // EBUSY/EPERM after retries exhausted, or other errors — best-effort
      failed++;
    }
  }

  // Best-effort: try to remove the now-empty directory
  try { fs.rmdirSync(inboxDir); } catch {}

  return { purged, failed };
}

module.exports = { enqueue, listPending, receive, ack, pruneAcked, purgeInbox };
