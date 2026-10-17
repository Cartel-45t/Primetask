"use strict";

(() => {
  const hostname = window.location.hostname;
  const isLocal = ["localhost", "127.0.0.1"].includes(hostname);
  const isHttps = window.location.protocol === "https:";

  const meta = document.querySelector('meta[name="ptw-api-base"]');
  const metaBase = meta ? meta.content.trim() : "";

  let apiBase = "";

  if (
    typeof window.PTW_API_BASE === "string" &&
    window.PTW_API_BASE.trim()
  ) {
    apiBase = window.PTW_API_BASE.trim();
  } else if (metaBase) {
    apiBase = metaBase;
  } else if (isLocal) {
    apiBase = "http://127.0.0.1:5001/api";
  }

  apiBase = apiBase.replace(/\/+$/, "");

  if (!apiBase) {
    console.error(
      "PrimeTask API is not configured. Set window.PTW_API_BASE " +
      "or add a ptw-api-base meta tag with the production API URL."
    );
    return;
  }

  let parsed;

  try {
    parsed = new URL(apiBase);
  } catch {
    console.error("PrimeTask API URL is invalid.");
    return;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    console.error("PrimeTask API must use HTTP or HTTPS.");
    return;
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    console.error(
      "PrimeTask API URL must not contain credentials, query parameters or a fragment."
    );
    return;
  }

  const pointsToLocalhost = [
    "localhost",
    "127.0.0.1",
    "::1"
  ].includes(parsed.hostname);

  if (!isLocal && pointsToLocalhost) {
    console.error("Production cannot use a localhost API URL.");
    return;
  }

  if (isHttps && parsed.protocol !== "https:") {
    console.error("An HTTPS website requires an HTTPS API URL.");
    return;
  }

  window.PTW_API_BASE = apiBase;
  window.PTW_AUTH_API_REGISTER = `${apiBase}/auth/register`;
  window.PTW_AUTH_API_LOGIN = `${apiBase}/auth/login`;
  window.PTW_AUTH_API_ME = `${apiBase}/auth/me`;
  window.PTW_AUTH_API_LOGOUT = `${apiBase}/auth/logout`;
  window.PTW_REFERRAL_API_ME = `${apiBase}/referrals/me`;
})();
