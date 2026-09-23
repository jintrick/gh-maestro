'use strict';

// pane-launch の4つの低レベル WezTerm 差し替え口を、期待呼び出し付きで登録する
// テストヘルパー。テスト本文に assertComplete の呼び出しを要求すると、その呼び忘れ
// 自体が新しい抜け道になるため、登録した port は afterEach で必ず完了確認する。

const { afterEach } = require('node:test');
const paneLaunch = require('../scripts/shared/pane-launch');

const SETTERS = Object.freeze({
  spawnWindow: ['_setWeztermSpawnWindow', 'spawn-window'],
  splitPane: ['_setWeztermSplitPane', 'split-pane'],
  listPanes: ['_setWeztermListPanes', 'list-panes'],
  killPane: ['_setWeztermKillPane', 'kill-pane'],
});

const active = [];

/**
 * 期待する1回の WezTerm 呼び出しを宣言する。
 *
 * @param {string[]} args
 * @param {object} result
 * @param {object} [options={}]
 * @returns {{args:string[], options:object, result:object}}
 */
function weztermCall(args, result, options = {}) {
  return { args, options, result };
}

/**
 * 指定した低レベル WezTerm 口へ期待呼び出しを登録する。
 * 指定しなかった口は変更しない。空配列は「その口を呼ばない」契約である。
 *
 * @param {{spawnWindow?: object[], splitPane?: object[], listPanes?: object[], killPane?: object[]}} expectations
 * @returns {void}
 */
function installWeztermCommandPorts(expectations = {}) {
  const registrations = [];
  for (const [name, [setterName, operation]] of Object.entries(SETTERS)) {
    if (!Object.prototype.hasOwnProperty.call(expectations, name)) continue;
    const port = paneLaunch._createWeztermCommandPort(operation, expectations[name]);
    paneLaunch[setterName](port);
    registrations.push({ setterName, port });
  }
  active.push(...registrations);
}

afterEach(() => {
  const errors = [];
  try {
    for (const { port } of active) {
      try {
        port.assertComplete();
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    for (const { setterName } of active) paneLaunch[setterName](null);
    active.length = 0;
  }
  if (errors.length > 0) throw errors[0];
});

module.exports = { installWeztermCommandPorts, weztermCall };
