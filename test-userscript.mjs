import assert from "node:assert/strict";
import fs from "node:fs";

const script = fs.readFileSync(new URL("./nilam-sqlite.user.js", import.meta.url), "utf8");

assert.match(script, /@name\s+NILAM SQLite Assistant/);
assert.match(script, /@namespace\s+https:\/\/github\.com\/cscLearn\/nilam-sqlite-assistant/);
assert.match(script, /const STORE_KEY = "nilam_sqlite_assistant_state_v1"/);
assert.match(script, /sourceType: "real"/);
assert.match(script, /sourceType: state\.sourceType/);
assert.match(script, /id="nia-source-type"/);
assert.match(script, /value="generated">AI 仿真书/);
assert.doesNotMatch(script, /nilam_api_assistant_state_v3/);
assert.doesNotMatch(script, /nilam_api_panel_[xy]/);

console.log("userscript isolation self-check OK");
