'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { reviewArtifactPath } = require('./review-manager-paths');
const { atomicWriteJson } = require('./atomic-write');
const { readJsonFile, JsonFileError } = require('./json-file');

function root(workspace, pr) {
  return path.join(path.dirname(reviewArtifactPath(workspace, pr, '.manifest.json')), 'runs');
}
function runnerLeaseDir(workspace, pr) {
  return path.join(path.dirname(reviewArtifactPath(workspace, pr, '.manifest.json')), 'job-runners');
}
function runnerLeasePath(workspace, pr, pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('runner PID 不正');
  return path.join(runnerLeaseDir(workspace, pr), `${pid}.running`);
}
function inspectRunners(workspace, pr) {
  const dir = runnerLeaseDir(workspace, pr);
  let names;
  try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const { inspectRunningReviewManager } = require('./running-review-managers');
  return names.map(name => {
    if (!/^[1-9][0-9]*\.running$/.test(name)) throw new Error(`runner lease 名が不正です: ${path.join(dir, name)}`);
    const record = inspectRunningReviewManager(path.join(dir, name), { onError: 'throw' });
    if (record.pid != null && record.pid !== Number(name.slice(0, -8))) throw new Error(`runner lease PID 不一致: ${path.join(dir, name)}`);
    return record;
  }).filter(item => item.status === 'live' || item.status === 'legacy-live');
}
function readOptional(file) {
  try { return readJsonFile(file); } catch (error) {
    if (error instanceof JsonFileError && error.kind === 'read' && error.code === 'ENOENT') return null;
    throw new Error(`review checkpoint 読み取り失敗: ${file}: ${error.message}`, { cause: error });
  }
}
function statePath(workspace, pr, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error(`review checkpoint ID 不正: ${id}`);
  return path.join(root(workspace, pr), `${id}.json`);
}
function validate(state, file, validateManifest) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 ||
      !Number.isInteger(state.attempts) || state.attempts < 0 || !state.results ||
      typeof state.results !== 'object' || Array.isArray(state.results) ||
      !state.manifest || !Array.isArray(state.manifest.jobs) || !validateManifest(state.manifest).valid) {
    throw new Error(`review checkpoint の形式が不正です: ${file}`);
  }
  const jobs = new Map(state.manifest.jobs.map(job => [job.id, job]));
  for (const [id, result] of Object.entries(state.results)) {
    const job = jobs.get(id);
    if (!job || !result || typeof result !== 'object' || Array.isArray(result) ||
        result.jobId !== id || !['success', 'failed'].includes(result.status) ||
        !Array.isArray(result.leaf_ids) || JSON.stringify(result.leaf_ids) !== JSON.stringify(job.leaf_ids) ||
        !Number.isInteger(result.attempt) || result.attempt < 1 ||
        (result.status === 'success' && !Array.isArray(result.findings)) ||
        (result.status === 'failed' && typeof result.error !== 'string')) {
      throw new Error(`review checkpoint ジョブ結果の形式が不正です: ${file}: ${id}`);
    }
    if (result.status === 'success') {
      try { require('../run-review-jobs').parseFindingsText(JSON.stringify(result.findings), 'checkpoint'); }
      catch (error) { throw new Error(`review checkpoint findings が不正です: ${file}: ${id}: ${error.message}`); }
    }
  }
  return state;
}
function load(workspace, pr, validateManifest) {
  const pointer = path.join(root(workspace, pr), 'latest.json');
  const value = readOptional(pointer);
  if (value === null) return null;
  if (value && value.version === 1 && value.pending === true && Object.keys(value).length === 2) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id)) {
    throw new Error(`review checkpoint 参照の形式が不正です: ${pointer}`);
  }
  const file = statePath(workspace, pr, value.id);
  const state = readOptional(file);
  if (state === null) throw new Error(`review checkpoint がありません: ${file}`);
  return { id: value.id, file, state: validate(state, file, validateManifest) };
}
function select(workspace, pr, repo, head, validateManifest) {
  const prior = load(workspace, pr, validateManifest);
  if (!prior) return null;
  if (String(prior.state.manifest.pr) !== String(pr) || prior.state.manifest.repo !== repo) {
    throw new Error(`review checkpoint PR/repo 不一致: ${prior.file}`);
  }
  return prior.state.manifest.headRefOid === head ? prior : null;
}
function begin(workspace, pr) {
  const dir = root(workspace, pr);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteJson(path.join(dir, 'latest.json'), { version: 1, pending: true });
}
function create(workspace, pr, manifest, validateManifest) {
  const id = crypto.randomBytes(16).toString('hex');
  const file = statePath(workspace, pr, id);
  const state = validate({ version: 1, manifest, attempts: 0, results: {} }, file, validateManifest);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, state);
  atomicWriteJson(path.join(root(workspace, pr), 'latest.json'), { version: 1, id });
  return { id, file, state };
}
function save(file, state, validateManifest) {
  validate(state, file, validateManifest);
  atomicWriteJson(file, state);
}
function read(workspace, pr, id, validateManifest) {
  const file = statePath(workspace, pr, id);
  const state = readOptional(file);
  if (state === null) throw new Error(`review checkpoint がありません: ${file}`);
  return { file, state: validate(state, file, validateManifest) };
}
module.exports = { load, select, begin, create, save, read, statePath, runnerLeasePath, inspectRunners };
