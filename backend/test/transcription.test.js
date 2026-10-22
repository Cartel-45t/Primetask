"use strict";

const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET =
  process.env.PTW_TEST_JWT_SECRET ||
  "ptw-v3-transcription-test-secret-only";

const mongoose = require("mongoose");
const User = require("../src/models/User");
const TranscriptionWallet = require("../src/models/TranscriptionWallet");
const TranscriptionWalletTransaction =
  require("../src/models/TranscriptionWalletTransaction");
const TranscriptionWithdrawal =
  require("../src/models/TranscriptionWithdrawal");
const adminTranscriptionRoutes =
  require("../src/routes/adminTranscription");
const transcriptionRoutes = require("../src/routes/transcription");
const TranscriptionJob = require("../src/models/TranscriptionJob");
const TranscriptionSettings = require("../src/models/TranscriptionSettings");
const cloudinary = require("cloudinary").v2;


const originalFindById = User.findById;
const originalJobFindOne = TranscriptionJob.findOne;
const originalJobCreate = TranscriptionJob.create;
const originalSettingsFindOne = TranscriptionSettings.findOne;
const originalCloudinaryResource = cloudinary.api.resource;
const originalPrivateDownloadUrl = cloudinary.utils.private_download_url;
const originalFetch = globalThis.fetch;
const originalCloudinaryEnv = {
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET
};

function setTestCloudinaryEnv() {
  process.env.CLOUDINARY_CLOUD_NAME = "ptw-test-cloud";
  process.env.CLOUDINARY_API_KEY = "ptw-test-key";
  process.env.CLOUDINARY_API_SECRET = "ptw-test-secret";
}

function restoreCloudinaryEnv() {
  for (const [key, value] of Object.entries(originalCloudinaryEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const testUserId = "507f1f77bcf86cd799439011";

let server;
let baseUrl;
let mockedRole = "user";

function cookieFor(role) {
  const token = jwt.sign(
    { sub: testUserId, role },
    process.env.JWT_SECRET,
    {
      expiresIn: "5m",
      issuer: "primetask-workspace",
      audience: "primetask-workspace-users"
    }
  );

  return `ptw_session=${token}`;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };

  if (options.role) headers.Cookie = cookieFor(options.role);

  const response = await fetch(baseUrl + path, {
    ...options,
    headers
  });

  return {
    response,
    body: await response.json()
  };
}

before(async () => {
  User.findById = () => ({
    select: async () => ({
      _id: testUserId,
      role: mockedRole,
      status: "active"
    })
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/admin/transcription", adminTranscriptionRoutes);
  app.use("/api/transcription", transcriptionRoutes);

  server = app.listen(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  mockedRole = "user";
  TranscriptionJob.findOne = originalJobFindOne;
  TranscriptionJob.create = originalJobCreate;
  TranscriptionSettings.findOne = originalSettingsFindOne;
  cloudinary.api.resource = originalCloudinaryResource;
  cloudinary.utils.private_download_url = originalPrivateDownloadUrl;
  globalThis.fetch = originalFetch;
  restoreCloudinaryEnv();
});

after(async () => {
  User.findById = originalFindById;
  TranscriptionJob.findOne = originalJobFindOne;
  TranscriptionJob.create = originalJobCreate;
  TranscriptionSettings.findOne = originalSettingsFindOne;
  cloudinary.api.resource = originalCloudinaryResource;
  cloudinary.utils.private_download_url = originalPrivateDownloadUrl;
  globalThis.fetch = originalFetch;
  restoreCloudinaryEnv();

  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
});


function validJobPayload(overrides = {}) {
  return {
    title: "sample-audio",
    description: "Transcribe the provided recording accurately.",
    instructions: "Submit a DOCX document with speaker labels.",
    audioPublicId: "primetask-workspace/transcription/audio/sample-audio",
    ...overrides
  };
}

function mockVerifiedAudio() {
  cloudinary.api.resource = async (publicId, options) => {
    assert.equal(
      publicId,
      "primetask-workspace/transcription/audio/sample-audio"
    );
    assert.equal(options.resource_type, "video");
    assert.equal(options.type, "authenticated");

    return {
      public_id: publicId,
      resource_type: "video",
      type: "authenticated",
      format: "mp3",
      duration: 61
    };
  };
}

test("custom whole-dollar reward creates a job without configured reward ranges",
  async () => {
    mockedRole = "admin";
    setTestCloudinaryEnv();
    mockVerifiedAudio();

    TranscriptionSettings.findOne = async () => null;

    TranscriptionJob.create = async data => ({
      _id: "507f1f77bcf86cd799439013",
      ...data,
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    const { response, body } = await request(
      "/api/admin/transcription/jobs",
      {
        method: "POST",
        role: "admin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validJobPayload({ rewardUsd: 6 }))
      }
    );

    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.job.reward, 6);
    assert.equal(body.job.currency, "USD");
    assert.equal(body.job.durationMinutes, 2);
  }
);

test("job without reward override continues using configured duration reward",
  async () => {
    mockedRole = "admin";
    setTestCloudinaryEnv();
    mockVerifiedAudio();

    TranscriptionSettings.findOne = async () => ({
      defaultAudioTitle: "Default Audio Task",
      durationRewardRanges: [
        { minMinutes: 1, maxMinutes: 1, rewardUsd: 3 },
        { minMinutes: 2, maxMinutes: 5, rewardUsd: 8 }
      ]
    });

    TranscriptionJob.create = async data => ({
      _id: "507f1f77bcf86cd799439014",
      ...data,
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    const payload = validJobPayload();
    delete payload.title;

    const { response, body } = await request(
      "/api/admin/transcription/jobs",
      {
        method: "POST",
        role: "admin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );

    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.job.title, "Default Audio Task");
    assert.equal(body.job.reward, 8);
    assert.equal(body.job.currency, "USD");
  }
);

test("job creation rejects a past publication time before Cloudinary lookup",
  async () => {
    mockedRole = "admin";
    setTestCloudinaryEnv();

    let resourceLookups = 0;
    cloudinary.api.resource = async () => {
      resourceLookups += 1;
      throw new Error("Cloudinary must not be called for an invalid schedule");
    };

    const { response, body } = await request(
      "/api/admin/transcription/jobs",
      {
        method: "POST",
        role: "admin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validJobPayload({
          rewardUsd: 6,
          publishAt: "2020-01-01T00:00:00.000Z"
        }))
      }
    );

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.match(body.message, /future date and time/i);
    assert.equal(resourceLookups, 0);
  }
);

test("transcription admin endpoints reject requests without a session",
  async () => {
    const { response, body } = await request("/api/admin/transcription/submissions");

    assert.equal(response.status, 401);
    assert.equal(body.success, false);
  }
);

test("ordinary users cannot access transcription admin submissions",
  async () => {
    mockedRole = "user";

    const { response, body } = await request(
      "/api/admin/transcription/submissions",
      { role: "user" }
    );

    assert.equal(response.status, 403);
    assert.equal(body.success, false);
  }
);

test("admin cannot create a transcription job with an empty payload",
  async () => {
    mockedRole = "admin";

    const { response, body } = await request(
      "/api/admin/transcription/jobs",
      {
        method: "POST",
        role: "admin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      }
    );

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
  }
);


test("transcription audio endpoint rejects requests without a session",
  async () => {
    const { response, body } = await request(
      "/api/transcription/jobs/507f1f77bcf86cd799439012/audio"
    );

    assert.equal(response.status, 401);
    assert.equal(body.success, false);
  }
);

test("transcription audio is hidden from workers without an assignment",
  async () => {
    setTestCloudinaryEnv();

    let resourceLookups = 0;
    TranscriptionJob.findOne = () => ({
      lean: async () => null
    });
    cloudinary.api.resource = async () => {
      resourceLookups += 1;
      throw new Error("Cloudinary must not be called for an unassigned job");
    };

    const { response, body } = await request(
      "/api/transcription/jobs/507f1f77bcf86cd799439012/audio",
      { role: "user" }
    );

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
    assert.equal(resourceLookups, 0);
  }
);

test("assigned worker can stream audio with HTTP range support",
  async () => {
    setTestCloudinaryEnv();

    const jobId = "507f1f77bcf86cd799439012";
    const publicId =
      "primetask-workspace/transcription/audio/test-audio";

    TranscriptionJob.findOne = query => {
      assert.equal(String(query._id), jobId);
      assert.equal(String(query.assignedUserId), testUserId);
      assert.deepEqual(query.status.$in, [
        "awarded", "submitted", "completed"
      ]);

      return {
        lean: async () => ({
          _id: jobId,
          assignedUserId: testUserId,
          status: "awarded",
          audioPublicId: publicId
        })
      };
    };

    cloudinary.api.resource = async (requestedPublicId, options) => {
      assert.equal(requestedPublicId, publicId);
      assert.equal(options.resource_type, "video");
      assert.equal(options.type, "authenticated");

      return {
        public_id: publicId,
        resource_type: "video",
        type: "authenticated",
        format: "mp3"
      };
    };

    cloudinary.utils.private_download_url = (
      requestedPublicId, format, options
    ) => {
      assert.equal(requestedPublicId, publicId);
      assert.equal(format, "mp3");
      assert.equal(options.resource_type, "video");
      assert.equal(options.type, "authenticated");
      assert.ok(options.expires_at > Math.floor(Date.now() / 1000));

      return "https://api.cloudinary.com/v1_1/test/video/download?signature=private-test-signature";
    };

    let forwardedRange;
    globalThis.fetch = async (input, options = {}) => {
      const target = input instanceof URL
        ? input.href
        : typeof input === "string"
          ? input
          : input.url;

      const parsed = new URL(target);

      if (parsed.hostname === "api.cloudinary.com") {
        forwardedRange = options.headers?.Range;

        return new Response(Buffer.from("audio-chunk"), {
          status: 206,
          headers: {
            "content-range": "bytes 0-10/100",
            "content-length": "11"
          }
        });
      }

      return originalFetch(input, options);
    };

    const response = await fetch(
      `${baseUrl}/api/transcription/jobs/${jobId}/audio`,
      {
        headers: {
          Cookie: cookieFor("user"),
          Range: "bytes=0-10"
        }
      }
    );

    const body = await response.text();

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-10/100");
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(forwardedRange, "bytes=0-10");
    assert.equal(body, "audio-chunk");
    assert.equal(body.includes("private-test-signature"), false);
  }
);

test("transcription wallet accepts USD and integer cents", async () => {
  const wallet = new TranscriptionWallet({
    userId: new mongoose.Types.ObjectId(),
    currency: "USD",
    availableBalanceCents: 1250
  });

  await wallet.validate();
  assert.equal(wallet.availableBalanceCents, 1250);
});

test("transcription wallet rejects unsupported currency", async () => {
  const wallet = new TranscriptionWallet({
    userId: new mongoose.Types.ObjectId(),
    currency: "KES"
  });

  await assert.rejects(wallet.validate(), error => Boolean(error.errors.currency));
});

test("transcription ledger rejects fractional cents", async () => {
  const transaction = new TranscriptionWalletTransaction({
    userId: new mongoose.Types.ObjectId(),
    type: "earning",
    amountCents: 10.5,
    reference: "TEST-TRANSCRIPTION-EARNING-1",
    currency: "USD"
  });

  await assert.rejects(transaction.validate(), error => Boolean(error.errors.amountCents));
});

test("transcription withdrawal rejects invalid Kenyan M-Pesa phone", async () => {
  const withdrawal = new TranscriptionWithdrawal({
    requestId: "TEST-TRANSCRIPTION-WITHDRAWAL-1",
    userId: new mongoose.Types.ObjectId(),
    amountCents: 600,
    phoneNumber: "12345",
    currency: "USD"
  });

  await assert.rejects(withdrawal.validate(), error => Boolean(error.errors.phoneNumber));
});

test("transcription withdrawal rejects amounts below six USD", async () => {
  const withdrawal = new TranscriptionWithdrawal({
    requestId: "TEST-TRANSCRIPTION-WITHDRAWAL-2",
    userId: new mongoose.Types.ObjectId(),
    amountCents: 599,
    phoneNumber: "254712345678",
    currency: "USD"
  });

  await assert.rejects(withdrawal.validate(), error => Boolean(error.errors.amountCents));
});
test("transcription withdrawal accepts the six USD minimum", async () => {
  const withdrawal = new TranscriptionWithdrawal({
    requestId: "TEST-TRANSCRIPTION-WITHDRAWAL-3",
    userId: new mongoose.Types.ObjectId(),
    amountCents: 600,
    phoneNumber: "254712345678",
    currency: "USD"
  });

  await withdrawal.validate();
});
