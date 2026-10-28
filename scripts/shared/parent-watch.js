'use strict';
// A transient failure to observe a parent must not terminate the child.
function createParentWatch(checker, ref) {
  const observe = checker.watchParent(ref);
  let consecutiveDead = 0;
  return () => {
    const state = observe();
    if (state === 'dead') return ++consecutiveDead < 3;
    if (state === 'alive') consecutiveDead = 0;
    return true;
  };
}
module.exports = { createParentWatch };
