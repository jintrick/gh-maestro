'use strict';

// Review Manager finding ごとに安定したスレッド識別子を作る。
// marker は manager.json の元バイト列と 1 始まりの finding 番号に結び付ける。

const crypto = require('crypto');

const MARKER_RE = /<!-- gh-maestro:review-manager-finding:v1:pr=([1-9]\d*):sha256=([a-f0-9]{64}):finding=([1-9]\d*) -->/;

function reviewFindingMarker(pr, artifactBytes, findingNumber) {
  const prNumber = String(pr);
  const number = Number(findingNumber);
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error(`invalid PR number: ${JSON.stringify(pr)}`);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`invalid finding number: ${JSON.stringify(findingNumber)}`);
  const sha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');
  return `<!-- gh-maestro:review-manager-finding:v1:pr=${prNumber}:sha256=${sha256}:finding=${number} -->`;
}

function parseReviewFindingMarker(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(MARKER_RE);
  if (!match) return null;
  return { pr: match[1], sha256: match[2], finding: Number(match[3]), marker: match[0] };
}

module.exports = { reviewFindingMarker, parseReviewFindingMarker, MARKER_RE };
