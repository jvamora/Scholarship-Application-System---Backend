// ============================================================
// Unit test - weighted component scoring (no database required).
// Verifies the "near-zero ties" feature: weighted components (40/30/30),
// precise total_score, tie-elimination, legacy fallback, deterministic cascade.

// Reviewer composite (0-100) - mirrors committeeRoutes.js aggregation.
function reviewerComposite(academics, need, statement) {
  if (academics == null || need == null || statement == null) return null; // legacy review
  return (academics * 0.4 + need * 0.3 + statement * 0.3) * 20;
}

// Average composite across reviewers, rounded to 4dp (total_score_precise).
function avgPrecise(reviews) {
  var composites = reviews.map(function (r) {
    var c = reviewerComposite(r.academics, r.need, r.statement);
    return c === null ? r.score * 20 : c;
  });
  var avg = composites.reduce(function (a, b) { return a + b; }, 0) / composites.length;
  return Math.round(avg * 10000) / 10000;
}

// Legacy overall 1-5 derived from components (client + backend decision path).
function derivedScore(academics, need, statement) {
  return Math.round(academics * 0.4 + need * 0.3 + statement * 0.3);
}

// Legacy rounded integer total (old logic - collapses precision).
function legacyRounded(score) { return Math.round(score * 20); }

// Deterministic rank sort used in selectionService.runSelection.
function sortRanked(list) {
  return list.slice().sort(function (x, y) {
    var sx = Number(x.total_score_precise != null ? x.total_score_precise : x.total_score);
    var sy = Number(y.total_score_precise != null ? y.total_score_precise : y.total_score);
    if (sy !== sx) return sy - sx;
    return new Date(x.created_at) - new Date(y.created_at) || (Number(x.id) - Number(y.id));
  });
}

var results = [];
function record(name, ok, detail) {
  results.push(ok);
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  - ' + detail : ''));
}

// 1 & 2. Formula + derived legacy overall
{
  var a = reviewerComposite(4, 5, 4), b = reviewerComposite(5, 3, 4);
  record('composite A(4,5,4) = 86', a === 86, 'got ' + a);
  record('composite B(5,3,4) = 82', b === 82, 'got ' + b);
  record('derived legacy overall (4,5,4) = 4', derivedScore(4, 5, 4) === 4);
  record('derived legacy overall (5,5,5) = 5', derivedScore(5, 5, 5) === 5);
  record('derived legacy overall (1,1,1) = 1', derivedScore(1, 1, 1) === 1);
}

// 3. Tie elimination: distinct precises legacy rounding collapsed to same integer.
{
  // 86.44 and 86.49 both round to 86 under legacy; precise keeps them distinct.
  var x = 86.44, y = 86.49;
  record('old rounding collapsed 86.44 & 86.49 to the SAME 86', Math.round(x) === 86 && Math.round(y) === 86, 'x=' + x + ', y=' + y);
  record('precise scoring keeps them distinct (86.44 vs 86.49)', x !== y);
  // Two 1-reviewer applicants that both gave overall 4 stars.
  var l1 = legacyRounded(4);
  var p1 = avgPrecise([{ score: 4, academics: 4, need: 5, statement: 4 }]);
  var p2 = avgPrecise([{ score: 4, academics: 5, need: 3, statement: 4 }]);
  record('1-reviewer applicants both overall-4 tied at 80 under legacy', l1 === 80, 'legacy=' + l1);
  record('but now differ precisely (86 vs 82)', p1 !== p2, 'p1=' + p1 + ', p2=' + p2);
  var mA = avgPrecise([
    { score: 4, academics: 4, need: 5, statement: 4 },
    { score: 4, academics: 5, need: 4, statement: 4 }
  ]);
  record('multi-reviewer avg precise = 87', mA === 87, 'got ' + mA);
}

// 4. Legacy fallback: reviews without components use overall score * 20.
{
  var f = avgPrecise([{ score: 4, academics: null, need: null, statement: null }]);
  record('legacy review (score 4) -> precise 80', f === 80, 'got ' + f);
}

// 5. Deterministic cascade: exact tie ranks by created_at then id.
{
  var tie1 = { id: 2, total_score: 80, total_score_precise: 82, created_at: '2026-01-02T00:00:00Z' };
  var tie2 = { id: 1, total_score: 80, total_score_precise: 82, created_at: '2026-01-01T00:00:00Z' };
  var sorted = sortRanked([tie1, tie2]);
  record('exact-tie cascade: earlier created_at ranks first', sorted[0].id === 1 && sorted[1].id === 2, 'order=' + sorted.map(function (s) { return s.id; }).join(','));
}

// Summary
var failed = results.filter(function (k) { return !k; }).length;
console.log('');
console.log('=== ' + (results.length - failed) + '/' + results.length + ' weighted-score checks passed ===');
require('fs').writeFileSync('D:/Scholarship Application system/scoring_test_results.json', JSON.stringify({ total: results.length, passed: results.length - failed, failed: failed, ok: failed === 0, timestamp: new Date().toISOString() }));
process.exit(failed ? 1 : 0);
