"use strict";

const BRANDS = [
  ["Samsung", ["samsung", "sm-", "gt-"]],
  ["TECNO", ["tecno"]],
  ["Infinix", ["infinix"]],
  ["itel", ["itel"]],
  ["Redmi", ["redmi"]],
  ["POCO", ["poco"]],
  ["Xiaomi", ["xiaomi", "mi "]],
  ["Google", ["pixel", "google"]],
  ["OnePlus", ["oneplus"]],
  ["OPPO", ["oppo"]],
  ["vivo", ["vivo"]],
  ["realme", ["realme"]],
  ["Motorola", ["motorola", "moto "]],
  ["Huawei", ["huawei"]],
  ["HONOR", ["honor"]],
  ["Nokia", ["nokia"]],
  ["HMD", ["hmd"]],
  ["Lenovo", ["lenovo"]],
  ["ASUS", ["asus"]],
  ["Sony", ["sony", "xperia"]]
];

function clean(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectManufacturer(model) {
  const value = String(model || "").toLowerCase();

  for (const [brand, prefixes] of BRANDS) {
    if (prefixes.some(prefix => value.startsWith(prefix))) {
      return brand;
    }
  }

  return null;
}

function normalizeManufacturerModel(manufacturer, rawModel) {
  let model = clean(rawModel);

  if (!manufacturer || !model) return model || null;

  const prefixes = {
    Samsung: /^(samsung\s*)/i,
    TECNO: /^(tecno\s*)/i,
    Infinix: /^(infinix\s*)/i,
    itel: /^(itel\s*)/i,
    Redmi: /^(redmi\s*)/i,
    POCO: /^(poco\s*)/i,
    Xiaomi: /^(xiaomi\s*)/i,
    Google: /^(google\s*)/i,
    OnePlus: /^(oneplus\s*)/i,
    OPPO: /^(oppo\s*)/i,
    vivo: /^(vivo\s*)/i,
    realme: /^(realme\s*)/i,
    Motorola: /^(?:motorola\s*)?(?:moto\s*)?/i,
    Huawei: /^(huawei\s*)/i,
    HONOR: /^(honor\s*)/i,
    Nokia: /^(nokia\s*)/i,
    HMD: /^(hmd\s*)/i,
    Lenovo: /^(lenovo\s*)/i,
    ASUS: /^(asus\s*)/i,
    Sony: /^(sony\s*|xperia\s*)/i
  };

  if (["Redmi", "POCO"].includes(manufacturer)) {
    return model;
  }

  return model.replace(prefixes[manufacturer] || /$^/, "").trim() || model;
}

function getPlatform(ua, hints) {
  const hinted = String(hints.platform || "").replace(/["']/g, "").trim();

  if (/android/i.test(ua) || /android/i.test(hinted)) return "Android";
  if (/iphone|ipad|ipod/i.test(ua) || /ios/i.test(hinted)) {
    return /ipad/i.test(ua) ? "iPadOS" : "iOS";
  }
  if (/windows/i.test(ua) || /windows/i.test(hinted)) return "Windows";
  if (/cros/i.test(ua) || /chrome os/i.test(hinted)) return "ChromeOS";
  if (/macintosh|mac os/i.test(ua) || /macos|mac os/i.test(hinted)) return "macOS";
  if (/linux/i.test(ua) || /linux/i.test(hinted)) return "Linux";

  return "Unknown platform";
}

function getOSVersion(ua, platform, hints) {
  const hinted = String(hints.platformVersion || "")
    .replace(/["']/g, "")
    .trim();

  if (hinted) return hinted;

  let match;

  if (platform === "Android") {
    match = ua.match(/Android\s+([\d.]+)/i);
    return match?.[1] || null;
  }

  if (platform === "iOS" || platform === "iPadOS") {
    match = ua.match(/(?:CPU (?:iPhone )?OS|iPhone OS)\s+([\d_]+)/i);
    return match?.[1]?.replace(/_/g, ".") || null;
  }

  if (platform === "Windows") {
    match = ua.match(/Windows NT\s+([\d.]+)/i);

    const versions = {
      "10.0": "10/11",
      "6.3": "8.1",
      "6.2": "8",
      "6.1": "7",
      "6.0": "Vista",
      "5.1": "XP"
    };

    return match
      ? (versions[match[1]] || match[1])
      : null;
  }

  if (platform === "macOS") {
    match = ua.match(/Mac OS X\s+([\d_]+)/i);
    return match?.[1]?.replace(/_/g, ".") || null;
  }

  if (platform === "ChromeOS") {
    match = ua.match(/CrOS\s+\S+\s+([\d.]+)/i);
    return match?.[1] || null;
  }

  return null;
}

function getBrowser(ua, hints) {
  const checks = [
    [/Edg(?:A|iOS)?\/([\d.]+)/i, "Microsoft Edge"],
    [/SamsungBrowser\/([\d.]+)/i, "Samsung Internet"],
    [/OPR\/([\d.]+)/i, "Opera"],
    [/Opera\/([\d.]+)/i, "Opera"],
    [/Vivaldi\/([\d.]+)/i, "Vivaldi"],
    [/YaBrowser\/([\d.]+)/i, "Yandex Browser"],
    [/UCBrowser\/([\d.]+)/i, "UC Browser"],
    [/Firefox\/([\d.]+)/i, "Firefox"],
    [/FxiOS\/([\d.]+)/i, "Firefox"],
    [/CriOS\/([\d.]+)/i, "Chrome"],
    [/Chrome\/([\d.]+)/i, "Chrome"],
    [/Version\/([\d.]+).*Safari/i, "Safari"]
  ];

  for (const [pattern, name] of checks) {
    const match = ua.match(pattern);
    if (match) {
      return { browser: name, browserVersion: match[1] };
    }
  }

  const brands = String(hints.fullVersionList || hints.brands || "");
  const brandMatch = brands.match(/"([^"]+)";v="([^"]+)"/);

  if (brandMatch) {
    const name = brandMatch[1];
    if (/edge/i.test(name)) return { browser: "Microsoft Edge", browserVersion: brandMatch[2] };
    if (/opera/i.test(name)) return { browser: "Opera", browserVersion: brandMatch[2] };
    if (/chrom/i.test(name)) return { browser: "Chrome", browserVersion: brandMatch[2] };
  }

  return { browser: "Unknown browser", browserVersion: null };
}

function identifyDevice(userAgent, clientHints = {}) {
  const ua = String(userAgent || "");
  const hints = clientHints || {};

  const platform = getPlatform(ua, hints);

  let manufacturer = null;
  let model = null;

  const hintedModel = String(hints.model || "")
    .replace(/["']/g, "")
    .trim();

  if (hintedModel) {
    model = clean(hintedModel);
    manufacturer = detectManufacturer(model);
  }

  if (!model && platform === "Android") {
    const match = ua.match(
      /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]+)?\s*[;)]/i
    );

    if (match) {
      const raw = clean(match[1]);

      if (
        raw &&
        !/^(?:wv|k|mobile|tablet|arm|x86|unknown)$/i.test(raw)
      ) {
        model = raw;
        manufacturer = detectManufacturer(raw);
      }
    }

  }

  if (model && manufacturer) {
    model = normalizeManufacturerModel(manufacturer, model);
  }

  if (platform === "Android" && model && !manufacturer) {
    manufacturer = "Unknown Android manufacturer";
  }

  if (platform === "iOS" || platform === "iPadOS") {
    manufacturer = "Apple";
    model = platform === "iPadOS" ? "iPad" : "iPhone";
  }

  if (platform === "macOS") {
    manufacturer = "Apple";
    model = "Mac";
  }

  if (platform === "Windows" || platform === "Linux" || platform === "ChromeOS") {
    model = null;
  }

  const osVersion = getOSVersion(ua, platform, hints);
  const { browser, browserVersion } = getBrowser(ua, hints);

  const mobileHint = String(hints.mobile || "").toLowerCase();

  let deviceType = "Unknown";

  if (/ipad|tablet/i.test(ua)) {
    deviceType = "Tablet";
  } else if (
    /mobile|iphone|ipod|android/i.test(ua) ||
    mobileHint === "?1" ||
    mobileHint === "true"
  ) {
    deviceType = "Mobile";
  } else if (
    /windows|macintosh|linux|cros/i.test(ua) ||
    mobileHint === "?0" ||
    mobileHint === "false"
  ) {
    deviceType = "Desktop";
  }

  let label = model || manufacturer || (
    platform !== "Unknown platform"
      ? `${platform} device`
      : "Unknown device"
  );

  if (manufacturer && model && manufacturer !== "Apple") {
    if (!model.toLowerCase().startsWith(manufacturer.toLowerCase())) {
      label = `${manufacturer} ${model}`;
    }
  }

  return {
    manufacturer,
    model,
    platform,
    osVersion,
    browser,
    browserVersion,
    deviceType,
    label
  };
}

module.exports = {
  identifyDevice,
  detectManufacturer
};
