"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { identifyDevice } = require("../src/services/deviceIdentityService");

const androidUA = model =>
  `Mozilla/5.0 (Linux; Android 14; ${model} Build/UP1A) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36`;

const cases = [
  ["TECNO", "TECNO CK7n", "CK7n"],
  ["Infinix", "Infinix X6850", "X6850"],
  ["itel", "itel P55", "P55"],
  ["Redmi", "Redmi 15C", "Redmi 15C"],
  ["POCO", "POCO X6 Pro", "POCO X6 Pro"],
  ["Xiaomi", "Xiaomi 14", "14"],
  ["Samsung", "Samsung SM-A155F", "SM A155F"],
  ["Google", "Google Pixel 8", "Pixel 8"],
  ["OPPO", "OPPO CPH2579", "CPH2579"],
  ["vivo", "vivo V30", "V30"],
  ["OnePlus", "OnePlus Nord 4", "Nord 4"],
  ["realme", "realme C67", "C67"],
  ["Motorola", "Motorola moto g54", "g54"],
  ["Huawei", "Huawei P30", "P30"],
  ["HONOR", "HONOR X9b", "X9b"],
  ["Nokia", "Nokia G42", "G42"],
  ["Lenovo", "Lenovo Tab P12", "Tab P12"],
  ["ASUS", "ASUS ROG Phone 8", "ROG Phone 8"],
  ["Sony", "Sony Xperia 1", "Xperia 1"]
];

for (const [manufacturer, raw, expectedModel] of cases) {
  test(`identifies ${manufacturer} devices`, () => {
    const result = identifyDevice(androidUA(raw));

    assert.equal(result.manufacturer, manufacturer);
    assert.equal(result.model, expectedModel);
    assert.equal(result.platform, "Android");
    assert.equal(result.browser, "Chrome");
    assert.equal(result.deviceType, "Mobile");
  });
}

test("identifies Redmi 15C without duplicating its label", () => {
  const result = identifyDevice(androidUA("Redmi 15C"));

  assert.equal(result.label, "Redmi 15C");
});

test("identifies Android model from Client Hints", () => {
  const result = identifyDevice(
    "Mozilla/5.0 (Linux; Android 14) Chrome/140.0.0.0 Mobile",
    {
      model: '"Pixel 9"',
      platform: '"Android"',
      platformVersion: '"15"',
      mobile: "?1"
    }
  );

  assert.equal(result.manufacturer, "Google");
  assert.equal(result.model, "Pixel 9");
  assert.equal(result.osVersion, "15");
});

test("identifies iPhone without inventing an exact model", () => {
  const result = identifyDevice(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1"
  );

  assert.equal(result.manufacturer, "Apple");
  assert.equal(result.model, "iPhone");
  assert.equal(result.platform, "iOS");
  assert.equal(result.osVersion, "17.0");
  assert.equal(result.browser, "Safari");
});

test("identifies iPad", () => {
  const result = identifyDevice(
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"
  );

  assert.equal(result.manufacturer, "Apple");
  assert.equal(result.platform, "iPadOS");
  assert.equal(result.model, "iPad");
  assert.equal(result.deviceType, "Tablet");
});

test("identifies Windows and Edge", () => {
  const result = identifyDevice(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
  );

  assert.equal(result.platform, "Windows");
  assert.equal(result.osVersion, "10/11");
  assert.equal(result.browser, "Microsoft Edge");
  assert.equal(result.browserVersion, "120.0.0.0");
  assert.equal(result.deviceType, "Desktop");
});

test("identifies macOS", () => {
  const result = identifyDevice(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15"
  );

  assert.equal(result.manufacturer, "Apple");
  assert.equal(result.model, "Mac");
  assert.equal(result.platform, "macOS");
});

test("identifies Linux", () => {
  const result = identifyDevice(
    "Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0"
  );

  assert.equal(result.platform, "Linux");
  assert.equal(result.browser, "Firefox");
});

test("identifies ChromeOS", () => {
  const result = identifyDevice(
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
  );

  assert.equal(result.platform, "ChromeOS");
  assert.equal(result.osVersion, "14541.0.0");
});

test("handles missing user-agent safely", () => {
  const result = identifyDevice("");

  assert.equal(result.label, "Unknown device");
  assert.equal(result.browser, "Unknown browser");
  assert.equal(result.platform, "Unknown platform");
});

test("does not invent Android manufacturer", () => {
  const result = identifyDevice(androidUA("UnknownModel123"));

  assert.equal(result.manufacturer, "Unknown Android manufacturer");
  assert.equal(result.model, "UnknownModel123");
});
