"use strict";

const { test, before, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const Module = require("node:module");

const USER_ID = "111111111111111111111111";

let server;
let baseUrl;
let router;

const fakeUser = {
  _id: USER_ID,
  username: "keith20",
  referredBy: null
};

const userModelMock = {
  findById(id) {
    assert.equal(String(id), USER_ID);

    return {
      select() {
        return {
          populate() {
            return Promise.resolve({ ...fakeUser });
          }
        };
      }
    };
  },

  async countDocuments(query) {
    assert.equal(String(query.referredBy), USER_ID);
    return 0;
  }
};

const originalLoad = Module._load;
const originalNodeEnv = process.env.NODE_ENV;
const originalPublicSiteUrl = process.env.PUBLIC_SITE_URL;

before(() => {
  Module._load = function (request, parent, isMain) {
    if (request === "../middleware/requireAuth") {
      return (req, res, next) => {
        req.user = { _id: USER_ID };
        next();
      };
    }

    if (request === "../models/User") {
      return userModelMock;
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const routePath = require.resolve("../src/routes/referrals");
    delete require.cache[routePath];
    router = require(routePath);
  } finally {
    Module._load = originalLoad;
  }
});

beforeEach(async () => {
  process.env.NODE_ENV = "development";
  delete process.env.PUBLIC_SITE_URL;

  const app = express();
  app.use("/api/referrals", router);

  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) {
    const currentServer = server;
    server = null;

    await new Promise((resolve, reject) => {
      currentServer.close(error => error ? reject(error) : resolve());
      currentServer.closeAllConnections?.();
    });
  }

  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }

  if (originalPublicSiteUrl === undefined) {
    delete process.env.PUBLIC_SITE_URL;
  } else {
    process.env.PUBLIC_SITE_URL = originalPublicSiteUrl;
  }
});

after(() => {
  Module._load = originalLoad;
});

test("GET /me returns a local registration referral URL", async () => {
  const response = await fetch(`${baseUrl}/api/referrals/me`, {
    headers: { Origin: "http://127.0.0.1:8080" }
  });

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.equal(body.success, true);
  assert.equal(body.referral.username, "keith20");
  assert.equal(
    body.referral.referralLink,
    "http://127.0.0.1:8080/auth/register.html?ref=keith20"
  );
  assert.equal(body.referral.directReferrals, 0);
});

test("GET /me ignores an untrusted origin for local referral URLs", async () => {
  const response = await fetch(`${baseUrl}/api/referrals/me`, {
    headers: { Origin: "https://attacker.example" }
  });

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.equal(
    body.referral.referralLink,
    "http://127.0.0.1:8080/auth/register.html?ref=keith20"
  );
});

test("GET /me uses the explicitly configured production URL", async () => {
  process.env.NODE_ENV = "production";
  process.env.PUBLIC_SITE_URL = "https://example.vercel.app/";

  const response = await fetch(`${baseUrl}/api/referrals/me`);
  assert.equal(response.status, 200);

  const body = await response.json();

  assert.equal(
    body.referral.referralLink,
    "https://example.vercel.app/register/keith20"
  );
});

test("GET /me returns 500 when the production public URL is missing", async () => {
  process.env.NODE_ENV = "production";
  delete process.env.PUBLIC_SITE_URL;

  const response = await fetch(`${baseUrl}/api/referrals/me`);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.success, false);
  assert.equal(body.message, "Unable to load referral information.");
});

test("GET /me returns 500 when the production public URL is not HTTPS", async () => {
  process.env.NODE_ENV = "production";
  process.env.PUBLIC_SITE_URL = "http://example.vercel.app";

  const response = await fetch(`${baseUrl}/api/referrals/me`);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.success, false);
  assert.equal(body.message, "Unable to load referral information.");
});
