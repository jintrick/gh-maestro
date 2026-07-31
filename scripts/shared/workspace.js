'use strict';
// 共有: workspace 解決と簡易フラグパース
//
// queue-send.js / queue-ack.js / queue-status.js / send-pane.js に重複していた
// ロジックを1箇所に集約する。
//
// workspace 解決順（全ツール共通）:
//   GH_MAESTRO_WORKSPACE env > --workspace 引数 > CWD から上方探索

const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalWorkspace, assertValidWorkspace } = require('./storage-layout');

/**
 * CWD から上方に遡り、.gh-maestro ディレクトリを持つ最初のディレクトリを返す。
 * 見つからなければ null。
 *
 * ホームディレクトリ自体は候補として認定しない。~/.gh-maestro は install.js の
 * managed root であり、実行時のワークスペースではない（Issue #214: CWD がホーム
 * ディレクトリ配下のどこかにある場合、この上方探索が `~/.gh-maestro` を「見つけて」
 * ホームディレクトリを workspace として返してしまい、PID registry 等の実行時状態が
 * managed root 配下に作られてしまう事故があった）。
 */
function findWorkspaceFromCwd() {
  const home = canonicalWorkspace(os.homedir());
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.gh-maestro')) && canonicalWorkspace(dir) !== home) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 引数・env・CWD探索から workspace 絶対パスを解決する。
 *
 * 解決結果は必ず assertValidWorkspace で検証し、ホームディレクトリや managed root
 * （~/.gh-maestro/）と衝突する場合は null を返す（CWD探索由来だけでなく、
 * `GH_MAESTRO_WORKSPACE=~` や `--workspace ~` のような明示指定でホームを
 * 指してしまった場合も同様に扱う）。
 *
 * こうして無効化を resolveWorkspace() 側で一元化することで、この関数の戻り値を
 * `if (!workspace) { ...エラー...; process.exit(1); }` という既存の定型パターンで
 * 使っている全呼び出し元（poll-pr.js / poll-reviews.js / msg-poll.js /
 * inbox-supervisor.js 等）が、個別に try/catch を書かなくても自動的に
 * 「ワークスペースを解決できません」という通常のエラーパスへ倒れる
 * （process-lifecycle.js の pidsDir()/legacyPidsDir() 内の assertValidWorkspace throw を、
 * 呼び出し側ごとに捕捉し忘れるリスクを構造的に無くす）。
 *
 * @param {string|null} workspaceArg  --workspace の値、または null
 * @returns {string|null} 解決済み絶対パス、または null
 */
function resolveWorkspace(workspaceArg) {
  const fromEnv = process.env.GH_MAESTRO_WORKSPACE;
  const candidate = fromEnv ? path.resolve(fromEnv)
    : workspaceArg ? path.resolve(workspaceArg)
    : findWorkspaceFromCwd();

  if (!candidate) return null;

  try {
    assertValidWorkspace(candidate);
  } catch {
    return null;
  }

  return candidate;
}

/**
 * args 配列から名前付きフラグを抽出する。
 *
 * @param {string[]} args  process.argv.slice(2) 相当
 * @param {string[]} flags 値を取るフラグ名の配列（例: ['--workspace', '--kind', '--message-id']）
 * @param {string[]} [booleanFlags=[]] 値を取らない真偽フラグ名の配列（例: ['--verbose', '--dry-run']）
 * @returns {{ values: Record<string,string|boolean|null>, rest: string[] }}
 *   values: 各フラグ → 値（値フラグは string|null、真偽フラグは boolean|null。フラグなしは null。
 *           値フラグの値不足は null で exitFlagMiss を true に）
 *   rest:   フラグとその値を除いた位置引数
 *   exitFlagMiss: boolean — 値フラグがあったが値がない場合 true（真偽フラグは対象外）
 */
function parseFlags(args, flags, booleanFlags = []) {
  const values = {};
  const skipIndices = new Set();
  let exitFlagMiss = false;
  // 既知の全フラグ名を収集。値フラグの次トークンが既知フラグであれば値欠落と判定する。
  const allKnownFlags = new Set([...flags, ...booleanFlags]);

  // 真偽フラグ: 値を消費しない。存在すれば true、なければ null。
  for (const flag of booleanFlags) {
    const idx = args.indexOf(flag);
    if (idx === -1) {
      values[flag] = null;
    } else {
      values[flag] = true;
      skipIndices.add(idx);
    }
  }

  // 値フラグ: 次トークンを値として消費する。値が欠落していたら exitFlagMiss。
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx === -1) {
      values[flag] = null;
      continue;
    }
    // 次トークンがない（末尾）／次トークンが既知フラグ／次トークンが -- で始まる未知の長形式フラグ → 値欠落
    // startsWith('-') による一律判定は避ける（負数 -5 や -my-branch 等の正当な値を誤検出するため）
    if (idx + 1 >= args.length || allKnownFlags.has(args[idx + 1]) || args[idx + 1].startsWith('--')) {
      values[flag] = null;
      exitFlagMiss = true;
      skipIndices.add(idx);
    } else {
      values[flag] = args[idx + 1];
      skipIndices.add(idx);
      skipIndices.add(idx + 1);
    }
  }

  const rest = args.filter((_, i) => !skipIndices.has(i));

  return { values, rest, exitFlagMiss };
}

/**
 * parseFlags の `rest`（フラグ・値として消費されなかった残り）に対して
 * --help/-h が含まれるか判定する。
 *
 * `rest` は既に他フラグの値として消費されたトークンを含まないため、
 * 他オプションの値がたまたま "--help" と一致しても誤検出しない
 * （生の argv 全体を対象にした `argv.includes('--help')` が引き起こす
 * フラグ/値衝突を避けるための共通ヘルパー）。
 *
 * @param {string[]} rest  parseFlags が返す rest 配列
 * @returns {boolean}
 */
function hasHelpFlag(rest) {
  return rest.includes('--help') || rest.includes('-h');
}

module.exports = { findWorkspaceFromCwd, resolveWorkspace, parseFlags, hasHelpFlag };
