const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

test("frontend API config supports explicit production configuration", () => {
  const source = fs.readFileSync(
    path.join(root, "frontend/assets/js/config.js"),
    "utf8"
  );

  assert.match(source, /window\.PTW_API_BASE/);
  assert.match(source, /ptw-api-base/);
  assert.match(source, /Production cannot use a localhost API URL/);
  assert.match(source, /An HTTPS website requires an HTTPS API URL/);
});

test("Vercel configuration is valid and preserves registration rewrite", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "frontend/vercel.json"), "utf8")
  );

  assert.ok(
    config.rewrites.some(
      item =>
        item.source === "/register/:username" &&
        item.destination === "/auth/register.html"
    )
  );
});

test("Vercel includes baseline security headers", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "frontend/vercel.json"), "utf8")
  );

  const headers = config.headers.flatMap(item => item.headers);
  const names = headers.map(item => item.key.toLowerCase());

  for (const name of [
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "permissions-policy"
  ]) {
    assert.ok(names.includes(name), `Missing header: ${name}`);
  }
});

test("backend refuses to start without required production secrets", () => {
  const source = fs.readFileSync(
    path.join(root, "backend/src/server.js"),
    "utf8"
  );

  assert.match(source, /JWT_SECRET/);
  assert.match(source, /MONGODB_URI/);
  assert.match(source, /length < 32/);
});

test("Daraja callbacks do not directly trust callback data for wallet credit", () => {
  const source = fs.readFileSync(
    path.join(root, "backend/src/routes/darajaCallbacks.js"),
    "utf8"
  );

  assert.match(source, /reconciliation_required/);
  assert.match(source, /Independent reconciliation is required before wallet credit/i);
});
