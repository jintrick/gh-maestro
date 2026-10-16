'use strict';

const os = require('os');

/**
 * 起動時のCPU数と稼働中review-job数から、テスト層の並列数を決める。
 * 入力を取得できない場合は宣言済みの下限へ落とし、取得できなかった入力を返す。
 *
 * @param {{declaration:object,workspace:string|null}} params
 * @param {{availableParallelismFn?:Function,findRunningInstancesFn?:Function}} [deps]
 * @returns {{value:number,cpuCount:number|null,reviewJobCount:number|null,status:'complete'|'unavailable',unavailableInputs:string[]}}
 */
function resolveDynamicConcurrency({ declaration, workspace }, deps = {}) {
  const unavailableInputs = [];
  let cpuCount = null;
  let reviewJobCount = null;

  try {
    const availableParallelismFn = deps.availableParallelismFn || os.availableParallelism;
    if (typeof availableParallelismFn !== 'function') throw new Error('unavailable');
    const detected = availableParallelismFn();
    if (!Number.isSafeInteger(detected) || detected < 1) throw new Error('unavailable');
    cpuCount = detected;
  } catch {
    unavailableInputs.push('cpuCount');
  }

  try {
    if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('unavailable');
    const findRunningInstancesFn = deps.findRunningInstancesFn
      || require('../process-lifecycle').findRunningInstances;
    const runningJobs = findRunningInstancesFn(workspace, {
      script: 'review-job',
      failOnReadError: true,
    });
    if (!Array.isArray(runningJobs)) throw new Error('unavailable');
    reviewJobCount = runningJobs.length;
  } catch {
    unavailableInputs.push('reviewJobCount');
  }

  const status = unavailableInputs.length === 0 ? 'complete' : 'unavailable';
  const value = status === 'complete'
    ? Math.max(
      declaration.minimum,
      cpuCount - declaration.cpuReserve - reviewJobCount * declaration.reviewJobCost,
    )
    : declaration.minimum;

  return {
    value,
    cpuCount,
    reviewJobCount,
    status,
    unavailableInputs,
  };
}

function dynamicConcurrencyArgs(declaration, concurrency) {
  return declaration.args.map(arg => arg.replace('{value}', String(concurrency.value)));
}

module.exports = {
  resolveDynamicConcurrency,
  dynamicConcurrencyArgs,
};
