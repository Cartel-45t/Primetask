"use strict";

(() => {
  const MAX_BYTES = 100 * 1024 * 1024;
  const REQUEST_TIMEOUT_MS = 30000;
  const UPLOAD_TIMEOUT_MS = 180000;

  const ALLOWED_FORMATS = new Set([
    "mp3", "wav", "m4a", "ogg", "flac", "webm"
  ]);

  let panel;
  let progressBar;
  let progressText;
  let stageText;

  function getProgressPanel() {
    if (panel && panel.isConnected) return panel;

    panel = document.createElement("section");
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");

    Object.assign(panel.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "99999",
      width: "min(360px, calc(100vw - 32px))",
      padding: "16px",
      borderRadius: "12px",
      background: "#08101f",
      color: "#ffffff",
      border: "1px solid #334155",
      boxShadow: "0 12px 36px rgba(0,0,0,.35)",
      font: "14px/1.5 system-ui, sans-serif"
    });

    const heading = document.createElement("strong");
    heading.textContent = "Protected audio upload";

    stageText = document.createElement("div");
    stageText.style.marginTop = "8px";
    stageText.textContent = "Preparing upload…";

    const track = document.createElement("div");
    Object.assign(track.style, {
      height: "8px",
      marginTop: "10px",
      overflow: "hidden",
      borderRadius: "99px",
      background: "#334155"
    });

    progressBar = document.createElement("div");
    Object.assign(progressBar.style, {
      width: "0%",
      height: "100%",
      background: "#f97316",
      transition: "width .15s linear"
    });

    track.appendChild(progressBar);

    progressText = document.createElement("div");
    progressText.style.marginTop = "6px";
    progressText.textContent = "Waiting for authorization";

    panel.append(heading, stageText, track, progressText);
    document.body.appendChild(panel);

    return panel;
  }

  function updateProgress(stage, percent, detail) {
    getProgressPanel();
    stageText.textContent = stage;

    if (percent === null) {
      progressBar.style.width = "100%";
      progressBar.style.opacity = ".45";
      progressText.textContent = detail || "Waiting for server response…";
      return;
    }

    const safePercent = Math.max(0, Math.min(100, percent));
    progressBar.style.opacity = "1";
    progressBar.style.width = safePercent + "%";
    progressText.textContent =
      detail || Math.round(safePercent) + "% uploaded";
  }

  async function apiRequest(apiBase, endpoint, body) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(apiBase + endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.success === false) {
        throw new Error(
          data.message || `Request failed (${response.status}).`
        );
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          "Timed out after 30 seconds at " + endpoint +
          ". Check the backend terminal and retry."
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function uploadToCloudinary(url, form) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.open("POST", url);
      xhr.timeout = UPLOAD_TIMEOUT_MS;

      xhr.upload.addEventListener("progress", event => {
        if (!event.lengthComputable || event.total <= 0) {
          updateProgress("Uploading audio to Cloudinary…", null);
          return;
        }

        const percent = (event.loaded / event.total) * 100;
        updateProgress(
          "Uploading audio to Cloudinary…",
          percent,
          `${Math.round(percent)}% uploaded`
        );
      });

      xhr.addEventListener("load", () => {
        let data = {};

        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch {
          reject(new Error("Cloudinary returned an unreadable response."));
          return;
        }

        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(
            data.error?.message || `Cloudinary upload failed (${xhr.status}).`
          ));
          return;
        }

        resolve(data);
      });

      xhr.addEventListener("error", () => {
        reject(new Error(
          "Network error during Cloudinary upload. Check your connection."
        ));
      });

      xhr.addEventListener("timeout", () => {
        reject(new Error(
          "Cloudinary upload timed out after 3 minutes. Check your connection and retry."
        ));
      });

      xhr.addEventListener("abort", () => {
        reject(new Error("Cloudinary upload was cancelled."));
      });

      xhr.send(form);
    });
  }

  async function upload(file, apiBase) {
    if (!file || !(file instanceof File)) {
      throw new Error("Choose an audio file first.");
    }

    if (!apiBase) {
      throw new Error("The backend API URL is not configured.");
    }

    const extensionMatch = /\.([a-z0-9]+)$/i.exec(file.name);
    const extension = extensionMatch ? extensionMatch[1].toLowerCase() : "";

    if (!ALLOWED_FORMATS.has(extension)) {
      throw new Error(
        "Unsupported audio format. Use MP3, WAV, M4A, OGG, FLAC, or WebM."
      );
    }

    if (file.size < 1 || file.size > MAX_BYTES) {
      throw new Error(
        "Audio must be larger than zero bytes and no more than 100 MB."
      );
    }

    try {
      updateProgress("Requesting secure upload authorization…", null);

      const authorization = await apiRequest(
        apiBase,
        "/admin/transcription/assets/audio/signature",
        {
          originalName: file.name,
          size: file.size
        }
      );

      if (
        !authorization.cloudName ||
        !authorization.apiKey ||
        !authorization.signature ||
        !authorization.params
      ) {
        throw new Error(
          "The server returned incomplete upload authorization."
        );
      }

      const form = new FormData();

      for (const [key, value] of Object.entries(authorization.params)) {
        form.append(key, String(value));
      }

      form.append("api_key", authorization.apiKey);
      form.append("signature", authorization.signature);
      form.append("file", file);

      const uploadUrl =
        "https://api.cloudinary.com/v1_1/" +
        encodeURIComponent(authorization.cloudName) +
        "/video/upload";

      updateProgress("Connecting to Cloudinary…", 0);

      const cloudinaryResult = await uploadToCloudinary(uploadUrl, form);

      if (
        cloudinaryResult.public_id !== authorization.params.public_id ||
        cloudinaryResult.resource_type !== "video" ||
        cloudinaryResult.type !== "authenticated"
      ) {
        throw new Error(
          "Cloudinary returned an unexpected asset configuration."
        );
      }

      updateProgress(
        "Upload complete. Verifying protected audio…",
        null,
        "Checking asset and duration"
      );

      const verified = await apiRequest(
        apiBase,
        "/admin/transcription/assets/audio/verify",
        {
          publicId: cloudinaryResult.public_id,
          originalName: file.name
        }
      );

      if (!verified.asset?.publicId) {
        throw new Error(
          "The server did not confirm the uploaded audio."
        );
      }

      updateProgress(
        "Audio verified successfully.",
        100,
        "Protected asset confirmed"
      );

      return verified.asset;
    } catch (error) {
      updateProgress("Upload did not finish.", null, error.message);
      throw error;
    }
  }

  window.PTWCloudinaryAudioUpload = Object.freeze({ upload });
})();
