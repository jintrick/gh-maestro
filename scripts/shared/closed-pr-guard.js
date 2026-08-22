'use strict';

const { spawnSync } = require('../child-process');

const GH_TIMEOUT_MS = 30000;

/**
 * 指定ブランチに紐づくPRのうち、クローズ済み（未マージ）のものを検出する。
 *
 * このガードは今回のワーカー起動・送信・再開経路専用であり、PR発見一般のAPIではない。
 * GitHubへ照会できない場合は、クローズ済みPRが無いとは判定せず、呼び出し元に停止を返す。
 *
 * @param {object} params
 * @param {string} params.repo
 * @param {string} params.branch
 * @param {string} [params.cwd]
 * @param {(repo: string, branch: string, opts?: object) => object} [params.listFn]
 * @returns {{ blocked: boolean, number?: number, reason?: string }}
 */
let _listFn = defaultList;

function checkClosedPr({ repo, branch, cwd, listFn }) {
  const list = listFn || _listFn;
  let result;
  try {
    result = list(repo, branch, { cwd });
  } catch (e) {
    return { blocked: true, reason: `クローズ済みPRの照会に失敗しました: ${e.message}` };
  }

  if (!result || result.status !== 0) {
    return {
      blocked: true,
      reason: `クローズ済みPRの照会に失敗しました: ${result?.stderr || result?.error?.message || '(empty)'}`,
    };
  }

  let prs;
  try {
    prs = JSON.parse(String(result.stdout || ''));
  } catch (e) {
    return { blocked: true, reason: `クローズ済みPRの照会結果を解釈できません: ${e.message}` };
  }
  if (!Array.isArray(prs)) {
    return { blocked: true, reason: 'クローズ済みPRの照会結果が配列ではありません' };
  }

  for (const pr of prs) {
    if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1
        || typeof pr.state !== 'string') {
      return { blocked: true, reason: 'クローズ済みPRの照会結果に不正なPR情報があります' };
    }
    const state = pr.state.toUpperCase();
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) {
      return { blocked: true, reason: `クローズ済みPRの照会結果に不明な状態があります: ${pr.state}` };
    }
    if (state === 'CLOSED') return { blocked: true, number: pr.number };
  }

  return { blocked: false };
}

function defaultList(repo, branch, opts = {}) {
  return spawnSync('gh', [
    'pr', 'list', '--repo', repo, '--head', branch, '--state', 'all',
    '--json', 'number,state',
  ], { cwd: opts.cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS });
}

module.exports = {
  checkClosedPr,
  _setListFn: (fn) => { _listFn = fn; },
  _resetListFn: () => { _listFn = defaultList; },
};
