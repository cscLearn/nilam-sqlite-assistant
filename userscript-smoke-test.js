const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("nilam-sqlite.user.js", "utf8");
const start = source.indexOf("function countTodaySubmissions");
const end = source.indexOf("\n  function extractTodayCountFromCounter", start);
assert.ok(start >= 0 && end > start, "countTodaySubmissions must remain extractable");

const countTodaySubmissions = Function(
  `let loggedRecordSample = true; ${source.slice(start, end)}; return countTodaySubmissions;`
)();
const counts = countTodaySubmissions({
  data: [{ attributes: { date: "2026-07-12", createdAt: "2026-07-12T09:00:00" } }]
}, "2026-07-12");

assert.deepEqual(counts, { realWorld: 1, readDate: 1 });
assert.ok(source.includes('state.authHeader = authHeader;'));
assert.ok(!source.includes("Auto-construct apiTemplate"));
console.log("userscript smoke test passed");
