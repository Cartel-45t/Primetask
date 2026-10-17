"use strict";

(() => {
  if (document.body.dataset.adminPage !== "transcription-admin") return;

  const API_BASE = String(
    window.PTW_API_BASE ||
    document.body.dataset.apiBase ||
    "http://127.0.0.1:5001/api"
  ).replace(/\/+$/, "");

  const $ = (selector, root = document) => root.querySelector(selector);

  const statusBox = $("#transcriptionStatus");
  const jobForm = $("#transcriptionJobForm");
  const jobButton = $("#createTranscriptionJobButton");
  const audioFile = $("#transcriptionAudioFile");
  const audioState = $("#audioUploadState");
  const rewardPreview = $("#audioRewardPreview");
  const submissionQueue = $("#submissionQueue");
  const withdrawalQueue = $("#withdrawalQueue");
  const submissionFilter = $("#submissionStatusFilter");
  const withdrawalFilter = $("#withdrawalStatusFilter");

  function setStatus(message, kind = "info") {
    statusBox.textContent = message;
    statusBox.dataset.kind = kind;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function money(amount, currency = "USD") {
    const n = Number(amount);
    if (!Number.isFinite(n)) return "Amount unavailable";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency === "USD" ? "USD" : "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(n);
  }

  function dateText(value) {
    if (!value) return "Date unavailable";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "Date unavailable" : d.toLocaleString();
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: "include"
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.success === false) {
      const message = payload.message || `Request failed (${response.status}).`;
      if (response.status === 401) {
        throw new Error("Admin session missing or expired. Sign in again.");
      }
      if (response.status === 403) {
        throw new Error("Access denied. An admin or founder account is required.");
      }
      throw new Error(message);
    }

    return payload;
  }

  function jsonOptions(body) {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
  }

  function makeButton(label, onClick, variant = "") {
    const button = element("button", "ptw-admin-button" +
      (variant ? ` ${variant}` : ""), label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function addMeta(parent, label, value) {
    const item = element("span", "ptw-transcription-meta");
    item.append(
      element("strong", "", `${label}:`),
      document.createTextNode(` ${value || "Not provided"}`)
    );
    parent.append(item);
  }

  function makeQueueItem(title, details = []) {
    const card = element("article", "ptw-transcription-item");
    card.append(element("h3", "", title));
    if (details.length) {
      const meta = element("div", "ptw-transcription-meta");
      for (const [label, value] of details) addMeta(meta, label, value);
      card.append(meta);
    }
    return card;
  }

  async function loadSubmissions() {
    submissionQueue.replaceChildren(element("p", "ptw-transcription-muted", "Loading submissions…"));

    try {
      const status = encodeURIComponent(submissionFilter.value);
      const payload = await request(`/admin/transcription/submissions?status=${status}`);
      const submissions = Array.isArray(payload.submissions) ? payload.submissions : [];
      submissionQueue.replaceChildren();

      if (!submissions.length) {
        submissionQueue.append(element("div", "ptw-transcription-empty", "No submissions in this status."));
        return;
      }

      for (const submission of submissions) {
        const user = submission.user || {};
        const job = submission.job || {};
        const card = makeQueueItem(job.title || "Transcription submission", [
          ["Worker", user.username || user.email || "Unknown user"],
          ["Email", user.email || "Not provided"],
          ["Job ID", job.id || "Unavailable"],
          ["Submitted", dateText(submission.createdAt)],
          ["Status", submission.status || "Unknown"],
          ["Reward", money(submission.reward)]
        ]);

        if (job.id) {
          card.append(element("h4", "", "Original audio"));
          const player = element("audio", "ptw-transcription-audio");
          player.controls = true;
          player.preload = "none";
          player.crossOrigin = "use-credentials";
          player.setAttribute("aria-label", "Original transcription audio");
          player.src = `${API_BASE}/admin/transcription/jobs/${encodeURIComponent(job.id)}/audio`;
          card.append(player);
        }

        if (user.firstName || user.lastName) {
          card.append(element("p", "", `Name: ${[user.firstName, user.lastName].filter(Boolean).join(" ")}`));
        }

        const transcript = typeof submission.transcriptText === "string"
          ? submission.transcriptText.trim()
          : "";

        if (transcript) {
          card.append(element("h4", "", "Submitted transcript"));
          card.append(element("pre", "ptw-transcription-transcript", transcript));
        } else {
          card.append(element(
            "p",
            "ptw-transcription-warning",
            "No inline transcript text is available for this submission. The current admin API does not provide a document preview/download endpoint here. Review actions are disabled to avoid approving unseen work."
          ));
        }

        if (submission.reviewNote) {
          card.append(element("p", "", `Previous review note: ${submission.reviewNote}`));
        }

        if (submission.status === "submitted" && transcript) {
          const noteLabel = element("label", "ptw-transcription-note", "Review note (required when rejecting)");
          const noteInput = element("textarea");
          noteInput.rows = 3;
          noteInput.maxLength = 500;
          noteInput.placeholder = "Explain any corrections or rejection reason…";
          noteLabel.append(noteInput);
          card.append(noteLabel);

          const actions = element("div", "ptw-transcription-actions");
          actions.append(
            makeButton("Approve submission", async () => {
              if (!window.confirm("Approve this submission and credit the worker's transcription wallet?")) return;
              await reviewSubmission(submission.id, "approve", noteInput.value);
            }, "ptw-admin-button-primary"),
            makeButton("Reject submission", async () => {
              if (!noteInput.value.trim()) {
                setStatus("A review note is required before rejecting a submission.", "error");
                noteInput.focus();
                return;
              }
              if (!window.confirm("Reject this submission and return the job to the available workflow?")) return;
              await reviewSubmission(submission.id, "reject", noteInput.value);
            }, "ptw-transcription-button-danger")
          );
          card.append(actions);
        }

        submissionQueue.append(card);
      }
    } catch (error) {
      submissionQueue.replaceChildren(element("p", "ptw-transcription-error", error.message));
      setStatus(error.message, "error");
    }
  }

  async function reviewSubmission(id, decision, reviewNote) {
    setStatus(`Submitting ${decision} decision…`);
    try {
      const payload = await request(
        `/admin/transcription/submissions/${encodeURIComponent(id)}/review`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, reviewNote: reviewNote.trim() })
        }
      );
      setStatus(payload.message || "Submission review saved.", "success");
      await loadSubmissions();
    } catch (error) {
      setStatus(error.message, "error");
    }
  }

  async function loadWithdrawals() {
    withdrawalQueue.replaceChildren(element("p", "ptw-transcription-muted", "Loading withdrawals…"));

    try {
      const status = encodeURIComponent(withdrawalFilter.value);
      const payload = await request(`/admin/transcription/withdrawals?status=${status}`);
      const withdrawals = Array.isArray(payload.withdrawals) ? payload.withdrawals : [];
      withdrawalQueue.replaceChildren();

      if (!withdrawals.length) {
        withdrawalQueue.append(element("div", "ptw-transcription-empty", "No withdrawals in this status."));
        return;
      }

      for (const withdrawal of withdrawals) {
        const user = withdrawal.user || {};
        const card = makeQueueItem(`Withdrawal ${withdrawal.requestId || withdrawal.id || ""}`, [
          ["Worker", user.username || user.email || "Unknown user"],
          ["Email", user.email || "Not provided"],
          ["Amount", money(withdrawal.amount)],
          ["Phone", withdrawal.phoneNumber || "Not provided"],
          ["Requested", dateText(withdrawal.createdAt)],
          ["Status", withdrawal.status || "Unknown"],
          ["M-Pesa receipt", withdrawal.mpesaReceipt || "Not recorded"]
        ]);

        if (withdrawal.reviewNote) {
          card.append(element("p", "", `Review note: ${withdrawal.reviewNote}`));
        }

        if (withdrawal.status === "pending_review") {
          const noteLabel = element("label", "ptw-transcription-note", "Review note / rejection reason");
          const noteInput = element("textarea");
          noteInput.rows = 2;
          noteInput.maxLength = 500;
          noteInput.placeholder = "Optional for payment; required for rejection.";
          noteLabel.append(noteInput);

          const receiptLabel = element("label", "ptw-transcription-note", "M-Pesa receipt reference (required to mark paid)");
          const receiptInput = element("input");
          receiptInput.maxLength = 20;
          receiptInput.autocomplete = "off";
          receiptInput.placeholder = "e.g. QWE1234567";
          receiptInput.pattern = "[A-Za-z0-9]{8,20}";
          receiptLabel.append(receiptInput);
          card.append(noteLabel, receiptLabel);

          const actions = element("div", "ptw-transcription-actions");
          actions.append(
            makeButton("Record paid", async () => {
              const receipt = receiptInput.value.trim().toUpperCase();
              if (!/^[A-Z0-9]{8,20}$/.test(receipt)) {
                setStatus("Enter a valid M-Pesa receipt reference (8–20 letters or numbers).", "error");
                receiptInput.focus();
                return;
              }
              if (!window.confirm(
                `Confirm that ${money(withdrawal.amount)} was already paid to ${withdrawal.phoneNumber || "the listed phone"} and that this receipt is correct? This only records the completed payment.`
              )) return;
              await reviewWithdrawal(withdrawal.id, "paid", noteInput.value, receipt);
            }, "ptw-admin-button-primary"),
            makeButton("Reject & refund", async () => {
              if (!noteInput.value.trim()) {
                setStatus("A reason is required before rejecting a withdrawal.", "error");
                noteInput.focus();
                return;
              }
              if (!window.confirm("Reject this withdrawal and return the reserved funds to the worker's transcription wallet?")) return;
              await reviewWithdrawal(withdrawal.id, "reject", noteInput.value, "");
            }, "ptw-transcription-button-danger")
          );
          card.append(actions);
        }

        withdrawalQueue.append(card);
      }
    } catch (error) {
      withdrawalQueue.replaceChildren(element("p", "ptw-transcription-error", error.message));
      setStatus(error.message, "error");
    }
  }

  async function reviewWithdrawal(id, decision, reviewNote, mpesaReceipt) {
    setStatus(`Saving withdrawal decision…`);
    try {
      const payload = await request(
        `/admin/transcription/withdrawals/${encodeURIComponent(id)}/review`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, reviewNote: reviewNote.trim(), mpesaReceipt })
        }
      );
      setStatus(payload.message || "Withdrawal review saved.", "success");
      await loadWithdrawals();
    } catch (error) {
      setStatus(error.message, "error");
    }
  }


  const settingsForm = $("#transcriptionSettingsForm");
  const defaultAudioTitleInput = $("#defaultAudioTitle");
  const rewardRangesEditor = $("#rewardRangesEditor");
  const addRewardRangeButton = $("#addRewardRangeButton");
  const saveSettingsButton = $("#saveTranscriptionSettingsButton");
  const settingsSaveStatus = $("#settingsSaveStatus");
  const minutePackageForm = $("#minutePackageForm");
  const packageCreateStatus = $("#packageCreateStatus");
  const createMinutePackageButton = $("#createMinutePackageButton");
  const minutePackagesList = $("#minutePackagesList");
  const reloadMinutePackagesButton = $("#reloadMinutePackagesButton");

  function makeInput(labelText, value, type = "number", min = "1", max = "") {
    const label = element("label", "ptw-admin-field");
    label.append(element("span", "", labelText));
    const input = element("input");
    input.type = type;
    input.value = value == null ? "" : String(value);
    if (type === "number") {
      input.min = min;
      input.step = "1";
      if (max) input.max = max;
    }
    label.append(input);
    return { label, input };
  }

  function renderRewardRange(range = {}) {
    const row = element("div", "ptw-transcription-config-row");
    const min = makeInput("Minimum minutes", range.minMinutes ?? 1, "number", "1", "10000");
    const max = makeInput("Maximum minutes", range.maxMinutes ?? 5, "number", "1", "10000");
    const reward = makeInput("Reward (whole USD)", range.rewardUsd ?? 1, "number", "1", "1000000");
    row.append(min.label, max.label, reward.label);

    const remove = makeButton("Remove range", () => row.remove(), "ptw-transcription-button-danger");
    row.append(remove);
    row._rangeInputs = { min: min.input, max: max.input, reward: reward.input };
    rewardRangesEditor.append(row);
  }

  function readRewardRanges() {
    const rows = [...rewardRangesEditor.querySelectorAll(".ptw-transcription-config-row")];
    const ranges = rows.map((row) => {
      const fields = row._rangeInputs;
      if (!fields) throw new Error("A reward range editor is incomplete. Reload settings and try again.");
      const minMinutes = Number(fields.min.value);
      const maxMinutes = Number(fields.max.value);
      const rewardUsd = Number(fields.reward.value);
      if (!Number.isSafeInteger(minMinutes) || minMinutes < 1 || minMinutes > 10000 ||
          !Number.isSafeInteger(maxMinutes) || maxMinutes < minMinutes || maxMinutes > 10000 ||
          !Number.isSafeInteger(rewardUsd) || rewardUsd < 1 || rewardUsd > 1000000) {
        throw new Error("Each range needs valid whole-minute limits and a whole-dollar USD reward.");
      }
      return { minMinutes, maxMinutes, rewardUsd };
    }).sort((a, b) => a.minMinutes - b.minMinutes);

    if (!ranges.length) throw new Error("At least one reward range is required.");
    if (ranges.length > 100) throw new Error("A maximum of 100 reward ranges is allowed.");
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i - 1].maxMinutes >= ranges[i].minMinutes) {
        throw new Error("Reward ranges overlap. Adjust the boundaries before saving.");
      }
    }
    return ranges;
  }

  async function loadTranscriptionSettings() {
    settingsSaveStatus.textContent = "Loading settings…";
    try {
      const payload = await request("/admin/transcription/config/settings");
      const settings = payload.settings || {};
      defaultAudioTitleInput.value = settings.defaultAudioTitle || "";
      rewardRangesEditor.replaceChildren();
      for (const range of (settings.durationRewardRanges || [])) renderRewardRange(range);
      if (!rewardRangesEditor.children.length) renderRewardRange();
      settingsSaveStatus.textContent = "Settings loaded.";
    } catch (error) {
      settingsSaveStatus.textContent = error.message;
      setStatus(error.message, "error");
    }
  }

  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = defaultAudioTitleInput.value.trim();
    if (!title || title.length > 180) {
      settingsSaveStatus.textContent = "Enter a default title of 1–180 characters.";
      return;
    }

    let durationRewardRanges;
    try {
      durationRewardRanges = readRewardRanges();
    } catch (error) {
      settingsSaveStatus.textContent = error.message;
      return;
    }

    saveSettingsButton.disabled = true;
    settingsSaveStatus.textContent = "Saving settings…";
    try {
      const payload = await request("/admin/transcription/config/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultAudioTitle: title, durationRewardRanges })
      });
      const saved = payload.settings || {};
      defaultAudioTitleInput.value = saved.defaultAudioTitle || title;
      rewardRangesEditor.replaceChildren();
      for (const range of (saved.durationRewardRanges || durationRewardRanges)) renderRewardRange(range);
      settingsSaveStatus.textContent = payload.message || "Settings saved.";
      setStatus("Transcription settings saved.", "success");
    } catch (error) {
      settingsSaveStatus.textContent = error.message;
      setStatus(error.message, "error");
    } finally {
      saveSettingsButton.disabled = false;
    }
  });

  addRewardRangeButton.addEventListener("click", () => {
    if (rewardRangesEditor.children.length >= 100) {
      settingsSaveStatus.textContent = "A maximum of 100 reward ranges is allowed.";
      return;
    }
    renderRewardRange({ minMinutes: 1, maxMinutes: 5, rewardUsd: 1 });
  });

  function renderMinutePackage(pkg) {
    const card = element("article", "ptw-transcription-item");
    card.append(element("h3", "", pkg.name || "Minute package"));
    const name = makeInput("Package name", pkg.name || "", "text");
    name.input.maxLength = 120;
    const minutes = makeInput("Minutes", pkg.minutes, "number", "1", "10000000");
    const price = makeInput("Price (whole USD)", pkg.price, "number", "1", "1000000");
    const priceKes = makeInput("M-Pesa price (KSh)", pkg.priceKes ?? "", "number", "1", "1000000000");
    const activeLabel = element("label", "ptw-admin-field");
    activeLabel.append(element("span", "", "Available for purchase"));
    const active = element("input");
    active.type = "checkbox";
    active.checked = pkg.isActive === true;
    activeLabel.append(active);

    const fields = element("div", "ptw-transcription-form-grid");
    fields.append(name.label, minutes.label, price.label, priceKes.label, activeLabel);
    card.append(fields);

    const status = element("p", "ptw-transcription-muted", `ID: ${pkg.id}`);
    const save = makeButton("Save package changes", async () => {
      const cleanName = name.input.value.trim();
      const minutesValue = Number(minutes.input.value);
      const priceValue = Number(price.input.value);
      const priceKesValue = Number(priceKes.input.value);
      if (!cleanName || cleanName.length > 120 ||
          !Number.isSafeInteger(minutesValue) || minutesValue < 1 || minutesValue > 10000000 ||
          !Number.isSafeInteger(priceValue) || priceValue < 1 || priceValue > 1000000 ||
          !Number.isSafeInteger(priceKesValue) || priceKesValue < 1 || priceKesValue > 1000000000) {
        status.textContent = "Enter a valid name, positive whole minutes, whole-dollar USD price, and whole-number M-Pesa price in KSh."
        return;
      }

      save.disabled = true;
      status.textContent = "Saving package…";
      try {
        const payload = await request(`/admin/transcription/config/packages/${encodeURIComponent(pkg.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: cleanName,
            minutes: minutesValue,
            price: priceValue,
            priceKes: priceKesValue,
            isActive: active.checked
          })
        });
        const saved = payload.package || {};
        status.textContent = `${payload.message || "Package saved."} Current status: ${saved.isActive ? "active" : "inactive"}.`;
        card.querySelector("h3").textContent = saved.name || cleanName;
        setStatus("Minute package updated.", "success");
      } catch (error) {
        status.textContent = error.message;
        setStatus(error.message, "error");
      } finally {
        save.disabled = false;
      }
    }, "ptw-admin-button-primary");

    card.append(status, save);
    minutePackagesList.append(card);
  }

  async function loadMinutePackages() {
    minutePackagesList.replaceChildren(element("p", "ptw-transcription-muted", "Loading packages…"));
    try {
      const payload = await request("/admin/transcription/config/packages?all=true");
      const packages = Array.isArray(payload.packages) ? payload.packages : [];
      minutePackagesList.replaceChildren();
      if (!packages.length) {
        minutePackagesList.append(element("div", "ptw-transcription-empty", "No minute packages have been created."));
        return;
      }
      for (const pkg of packages) renderMinutePackage(pkg);
    } catch (error) {
      minutePackagesList.replaceChildren(element("p", "ptw-transcription-error", error.message));
      setStatus(error.message, "error");
    }
  }

  minutePackageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(minutePackageForm);
    const name = String(data.get("name") || "").trim();
    const minutes = Number(data.get("minutes"));
    const price = Number(data.get("price"));
    const priceKes = Number(data.get("priceKes"));

    if (!name || name.length > 120 ||
        !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10000000 ||
        !Number.isSafeInteger(price) || price < 1 || price > 1000000 ||
        !Number.isSafeInteger(priceKes) || priceKes < 1 || priceKes > 1000000000) {
      packageCreateStatus.textContent = "Enter a package name, positive whole minutes, whole-dollar USD price, and whole-number M-Pesa price in KSh."
      return;
    }

    createMinutePackageButton.disabled = true;
    packageCreateStatus.textContent = "Creating package…";
    try {
      const payload = await request("/admin/transcription/config/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, minutes, price, priceKes })
      });
      packageCreateStatus.textContent = payload.message || "Package created.";
      minutePackageForm.reset();
      await loadMinutePackages();
      setStatus("Minute package created.", "success");
    } catch (error) {
      packageCreateStatus.textContent = error.message;
      setStatus(error.message, "error");
    } finally {
      createMinutePackageButton.disabled = false;
    }
  });

  reloadMinutePackagesButton.addEventListener("click", loadMinutePackages);

  jobForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = audioFile.files && audioFile.files[0];
    if (!file) {
      setStatus("Select an audio file first.", "error");
      return;
    }

    const maxBytes = 100 * 1024 * 1024;
    if (file.size > maxBytes) {
      setStatus("The selected audio exceeds the 100 MB limit.", "error");
      return;
    }

    const data = new FormData(jobForm);
    const dueValue = data.get("dueAt");
    const title = String(data.get("title") || "").trim();
    const description = String(data.get("description") || "").trim();
    const instructions = String(data.get("instructions") || "").trim();

    if (!description || !instructions) {
      setStatus("Enter the job description and transcription instructions.", "error");
      return;
    }

    jobButton.disabled = true;
    jobButton.textContent = "Uploading audio…";
    audioState.textContent = "Uploading protected audio asset. Keep this page open.";
    setStatus("Uploading audio to protected storage…");

    try {
      const uploadData = new FormData();
      uploadData.append("audio", file);

      const uploadPayload = await request("/admin/transcription/assets/audio", {
        method: "POST",
        body: uploadData
      });

      const asset = uploadPayload.asset || {};
      const publicId = asset.publicId;
      if (!publicId) throw new Error("Audio upload returned no asset public ID.");

      const durationSeconds = Number(asset.durationSeconds);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("Cloudinary did not return a verified audio duration. No job was created.");
      }

      const durationMinutes = Math.ceil(durationSeconds / 60);
      const settingsPayload = await request("/admin/transcription/config/settings");
      const settings = settingsPayload.settings || {};
      const ranges = Array.isArray(settings.durationRewardRanges)
        ? settings.durationRewardRanges
        : [];
      const matching = ranges.filter((range) =>
        durationMinutes >= Number(range.minMinutes) &&
        durationMinutes <= Number(range.maxMinutes)
      );

      if (matching.length !== 1) {
        throw new Error(`No unique reward rule covers ${durationMinutes} minute(s). Update the admin reward settings.`);
      }

      const configuredReward = Number(matching[0].rewardUsd);
      if (!Number.isSafeInteger(configuredReward) || configuredReward < 1) {
        throw new Error("The configured reward is invalid. No job was created.");
      }

      if (rewardPreview) {
        rewardPreview.textContent =
          `Verified duration: ${durationMinutes} minute(s). Configured reward: ${money(configuredReward)} USD.`;
      }

      audioState.textContent = "Audio uploaded. Creating job using verified duration and configured reward…";
      jobButton.textContent = "Creating job…";

      const jobPayload = await request("/admin/transcription/jobs", jsonOptions({
        title,
        description,
        instructions,
        audioPublicId: publicId,
        ...(dueValue ? { dueAt: new Date(dueValue).toISOString() } : {})
      }));

      const job = jobPayload.job || {};
      setStatus(
        `Job created: ${job.title || title || settings.defaultAudioTitle || "Transcription job"}. Duration: ${job.durationMinutes ?? durationMinutes} minute(s). Reward: ${money(job.reward)}.`,
        "success"
      );
      audioState.textContent = "Job created and audio asset linked.";
      jobForm.reset();
      if (rewardPreview) {
        rewardPreview.textContent = "Audio duration and reward will be verified after upload.";
      }
    } catch (error) {
      setStatus(error.message, "error");
      audioState.textContent =
        "Creation did not finish. If upload succeeded before the error, the protected asset may exist without a job. Retry carefully to avoid duplicate uploads.";
    } finally {
      jobButton.disabled = false;
      jobButton.textContent = "Upload audio & create job";
    }
  });

  submissionFilter.addEventListener("change", loadSubmissions);
  withdrawalFilter.addEventListener("change", loadWithdrawals);

  loadTranscriptionSettings();
  loadMinutePackages();

  Promise.allSettled([loadSubmissions(), loadWithdrawals()]).then((results) => {
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) setStatus("Some admin queues could not be loaded. Check the session and API connection.", "error");
    else setStatus("Admin queues loaded. Review each item before taking action.", "success");
  });
})();
