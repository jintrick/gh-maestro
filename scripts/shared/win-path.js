'use strict';
// Git Bash の POSIX パス（/tmp/foo, /c/Users/...）を Windows パスに変換する。
// cygpath が使えればそれを優先し、なければ汎用フォールバックで処理する。

const { spawnSync } = require('./child-process');

function toWinPath(p) {
  if (!p.startsWith('/')) return p;
  const r = spawnSync('cygpath', ['-w', p], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  // /c/Users/... → C:\Users\...
  const drive = p.match(/^\/([a-zA-Z])(\/|$)/);
  if (drive) return `${drive[1].toUpperCase()}:${p.slice(2).replace(/\//g, '\\')}`;
  // /tmp/... → %TEMP%\...
  const temp = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
  if (p === '/tmp') return temp;
  if (p.startsWith('/tmp/')) return `${temp}${p.slice(4).replace(/\//g, '\\')}`;
  return p;
}

module.exports = { toWinPath };
