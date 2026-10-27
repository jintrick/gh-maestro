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
      !state.manifest || !validateManifest(state.manifest).valid) {
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
  }
  return state;
}
function load(workspace, pr, validateManifest) {
  const pointer = path.join(root(workspace, pr), 'latest.json');
  const value = readOptional(pointer);
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
      typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id)) {
    throw new Error(`review checkpoint 参照の形式が不正です: ${pointer}`);
  }
  const file = statePath(workspace, pr, value.id);
  const state = readOptional(file);
  if (state === null) throw new Error(`review checkpoint がありません: ${file}`);
  return { id: value.id, file, state: validate(state, file, validateManifest) };
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
module.exports = { load, create, save, read, statePath };
