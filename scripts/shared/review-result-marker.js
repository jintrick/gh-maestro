'use strict';

// review-result-marker.js — Review Manager の最終レビュー本文に埋め込む掲載の印。
//
// review-publisher.js が manager.json のバイト列から印を作り、最終レビュー本文の末尾に付ける。
// finalize-issue.js は同じ関数で manager.json から印を作り直し、PR のレビュー本文に
// 同じ印が認証ユーザーの投稿として存在するかを照合する（ADR 0059: 掲載を確かめてから破棄する）。
//
// 最終レビュー本文はインライン指摘をすべて投稿した後にだけ投稿されるため、印が付いたレビューが
// あることは「その manager.json の投稿処理が最後まで終わった」ことを示す。
// 印は manager.json のバイト列に対する SHA-256 なので、ファイルが後から書き換わると一致しない。

const crypto = require('crypto');

/**
 * manager.json のバイト列から掲載の印（HTMLコメント）を作る。
 * @param {number|string} pr
 * @param {Buffer|Uint8Array|string} artifactBytes manager.json の内容そのもの
 * @returns {string}
 */
function reviewResultMarker(pr, artifactBytes) {
  const sha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');
  return `<!-- gh-maestro:review-manager-result:v1:pr=${pr}:sha256=${sha256} -->`;
}

module.exports = { reviewResultMarker };
