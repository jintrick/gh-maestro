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
 * parseFlags の検証エラー。
 * errors プロパティに検証エラー一覧（{ message, kind, flag? }）を持つ。
 * 呼び出し側は catch して errors を表示し、自スクリプトの usage を出してから
 * そのスクリプト本来の誤用時の終了コードで終了する（終了コードはスクリプトごとに
 * 現在の値を維持する。Issue #275 で一斉変更しない）。
 */
class ArgsValidationError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.message).join('\n'));
    this.name = 'ArgsValidationError';
    this.errors = errors;
  }
}

/**
 * args 配列から名前付きフラグを抽出し、仕様オブジェクトに照らして検証する。
 *
 * 旧契約 `parseFlags(args, flags, booleanFlags)` は、値欠落を `values[flag]=null` と
 * `exitFlagMiss` の2チャネルに分けて返し、「呼び出し側が null を確認し忘れると
 * null.trim() で TypeError」という呼び出し側の注意に依存する契約だった（Issue #275 項目3）。
 * 新契約は仕様オブジェクトを必須とし、検証エラーを throw する。呼び出し側は
 * `values`（出現したフラグのみ、欠落はキー不在）か `ArgsValidationError` のどちらかだけを
 * 受け取る。
 *
 * シグネチャ検証: 旧形式（第2引数=フラグ名配列・第2引数なし・第3引数あり）は
 * 仕様オブジェクト（非配列 object）として不正のため、明確に throw する。
 * これにより移行し忘れた呼び出し元は実行時に落ちる（改名による ReferenceError 検出の代替。
 * Issue #275 round 4 確定事項）。
 *
 * @param {string[]} args  process.argv.slice(2) 相当
 * @param {{flags?: Record<string, {required?: boolean, hint?: string}>, booleans?: string[], positionals?: {min?: number, max?: number}}} spec
 *   flags:      値を取るフラグ名 → { required, hint }（hint は必須欠落メッセージに追記する文脈）
 *   booleans:   値を取らない真偽フラグ名の配列（例: ['--help', '-h']）
 *   positionals: 位置引数の個数制約（既定 {min:0, max:0}）
 * @returns {{ values: Record<string, string|boolean>, rest: string[] }}
 *   values: 出現したフラグのみ（真偽フラグは true。任意フラグの欠落はキー不在=undefined。
 *           呼び出し側は `values['--x'] ?? 既定値` で明示的に既定値を与える）
 *   rest:   位置引数（未知の -- 始まりトークンは rest に入らず errors 側）
 * @throws {ArgsValidationError} 必須欠落・値欠落・未知フラグ・位置引数違反のいずれかがある場合
 */
function parseFlags(args, spec) {
  if (arguments.length !== 2 || spec == null || Array.isArray(spec)) {
    throw new Error('parseFlags の契約が変わりました: 第2引数に仕様オブジェクトが必要です。旧形式 (args, flags, booleanFlags) は廃止されました。呼び出し元を新契約へ移行してください。');
  }

  const { flags = {}, booleans = [], positionals = { min: 0, max: 0 } } = spec;
  const values = {};
  const errors = [];
  const rest = [];
  const skipIndices = new Set();
  // 既知の全フラグ名を収集。値フラグの次トークンが既知フラグであれば値欠落と判定する。
  const allKnownFlags = new Set([...Object.keys(flags), ...booleans]);

  // 真偽フラグ: 値を消費しない。存在すれば true（欠落はキー不在）。
  for (const flag of booleans) {
    const idx = args.indexOf(flag);
    if (idx !== -1) {
      values[flag] = true;
      skipIndices.add(idx);
    }
  }

  // 値フラグ: 次トークンを値として消費する。値が欠落していたら errors に積む。
  for (const [flag, def] of Object.entries(flags)) {
    const idx = args.indexOf(flag);
    if (idx === -1) {
      if (def.required) {
        errors.push({
          message: `必須フラグがありません: ${flag}${def.hint ? `（${def.hint}）` : ''}`,
          kind: 'required-missing',
          flag,
        });
      }
      continue;
    }
    // 次トークンがない（末尾）／次トークンが既知フラグ／次トークンが -- で始まる未知の長形式フラグ → 値欠落
    // startsWith('-') による一律判定は避ける（負数 -5 や -my-branch 等の正当な値を誤検出するため）
    if (idx + 1 >= args.length || allKnownFlags.has(args[idx + 1]) || args[idx + 1].startsWith('--')) {
      errors.push({ message: `フラグ ${flag} には値が必要です`, kind: 'missing-value', flag });
      skipIndices.add(idx);
    } else {
      values[flag] = args[idx + 1];
      skipIndices.add(idx);
      skipIndices.add(idx + 1);
    }
  }

  // 未消費トークンの分類: -- 始まりは位置引数として受理しない（Issue #14 先頭の未消費フラグ誤受理）。
  // 既知フラグが未消費のまま残るのは重複指定、未知なら未知フラグ。
  const unconsumed = args.filter((_, i) => !skipIndices.has(i));
  for (const token of unconsumed) {
    if (token.startsWith('--')) {
      const known = allKnownFlags.has(token);
      errors.push({
        message: known ? `フラグが重複しています: ${token}` : `未知のフラグです: ${token}`,
        kind: known ? 'duplicate-flag' : 'unknown-flag',
        flag: token,
      });
    } else {
      rest.push(token);
    }
  }

  // 位置引数の個数検証
  if (rest.length < positionals.min) {
    errors.push({ message: '位置引数が必要です', kind: 'positional-missing' });
  }
  if (rest.length > positionals.max) {
    errors.push({ message: `予期しない位置引数です: ${rest.slice(positionals.max).join(' ')}`, kind: 'too-many-positionals' });
  }

  if (errors.length > 0) throw new ArgsValidationError(errors);
  return { values, rest };
}

/**
 * ArgsValidationError を catch した際に、`--help`/`-h` をヘルプ表示へ逸らすべきかを判定する。
 *
 * 旧契約の parseFlags は値欠落を `exitFlagMiss` で返し、全呼び出し元が「値欠落をヘルプ判定より
 * 先にエラー扱い」していた。これは値欠落時に未消費の値トークンがたまたま `--help` と一致する
 * 場合にヘルプ表示へ握りつぶされる事故（argv-parsing-pitfalls.md「フラグ/値の衝突」）を防ぐため。
 * 新契約では値欠落は ArgsValidationError の missing-value として現れるため、それが混ざっている
 * 間はヘルプを優先しない（値として `--help` を渡された可能性が高く、真のヘルプ要求と区別できない）。
 * それ以外の検証エラー（必須欠落・未知フラグ・位置引数違反）は `--help` があれば真の要求として
 * ヘルプを優先する（例: `run-review-jobs --help` は必須フラグ欠落エラーに負けずに usage を出す）。
 *
 * @param {string[]} args  process.argv.slice(2)
 * @param {{kind: string}[]} errors  ArgsValidationError の errors 一覧
 * @returns {boolean} ヘルプ表示へ逸らすべき場合 true
 */
function hasGenuineHelpRequest(args, errors) {
  if (!(args.includes('--help') || args.includes('-h'))) return false;
  return !errors.some((e) => e.kind === 'missing-value');
}

module.exports = { findWorkspaceFromCwd, resolveWorkspace, parseFlags, hasGenuineHelpRequest, ArgsValidationError };
