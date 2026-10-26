"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTranscriptionJobRotationWorker
} = require("../src/services/transcriptionJobRotationWorker");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const BASE = Date.parse("2026-10-24T10:00:00Z");

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value === undefined) return undefined;
  return value;
}

function matchesValue(actual, expected) {
  if (
    expected === null &&
    (actual === null || actual === undefined)
  ) {
    return true;
  }

  if (
    expected === null ||
    typeof expected !== "object" ||
    expected instanceof Date
  ) {
    return comparable(actual) === comparable(expected);
  }

  for (const [operator, value] of Object.entries(expected)) {
    const a = comparable(actual);
    const b = comparable(value);

    if (operator === "$lte" && !(a != null && a <= b)) return false;
    if (operator === "$lt" && !(a != null && a < b)) return false;
    if (operator === "$gte" && !(a != null && a >= b)) return false;
    if (operator === "$gt" && !(a != null && a > b)) return false;
    if (operator === "$ne" && a === b) return false;

    if (operator === "$exists") {
      const exists = actual !== undefined;
      if (exists !== value) return false;
    }

    if (operator.startsWith("$") && ![
      "$lte", "$lt", "$gte", "$gt", "$ne", "$exists"
    ].includes(operator)) {
      throw new Error(`Unsupported test operator: ${operator}`);
    }
  }

  return true;
}

function matches(job, filter) {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$and") {
      if (!expected.every(part => matches(job, part))) return false;
      continue;
    }

    if (key === "$or") {
      if (!expected.some(part => matches(job, part))) return false;
      continue;
    }

    if (!matchesValue(job[key], expected)) return false;
  }

  return true;
}

function createFakeModel(initialJobs = []) {
  const jobs = initialJobs.map(job => ({ ...job }));
  let updateCount = 0;

  function findOne(filter) {
    let sortSpec = {};

    const query = {
      sort(spec) {
        sortSpec = spec;
        return query;
      },
      select() {
        return query;
      },
      async lean() {
        const found = jobs
          .filter(job => matches(job, filter))
          .sort((a, b) => {
            for (const [key, direction] of Object.entries(sortSpec)) {
              const av = comparable(a[key]);
              const bv = comparable(b[key]);

              if (av == null && bv == null) continue;
              if (av == null) return -1 * direction;
              if (bv == null) return 1 * direction;
              if (av < bv) return -1 * direction;
              if (av > bv) return 1 * direction;
            }
            return 0;
          })[0];

        return found ? { ...found } : null;
      }
    };

    return query;
  }

  async function findOneAndUpdate(filter, update) {
    const job = jobs.find(candidate => matches(candidate, filter));
    if (!job) return null;

    updateCount++;

    for (const [key, value] of Object.entries(update.$set || {})) {
      job[key] = value;
    }

    for (const key of Object.keys(update.$unset || {})) {
      delete job[key];
    }

    for (const [key, amount] of Object.entries(update.$inc || {})) {
      job[key] = (job[key] || 0) + amount;
    }

    return { ...job };
  }

  return {
    jobs,
    get updateCount() {
      return updateCount;
    },
    findOne,
    findOneAndUpdate,
    async updateMany(filter, update) {
      const matched = jobs.filter(job => matches(job, filter));
      for (const job of matched) {
        for (const [key, value] of Object.entries(update.$set || {})) {
          job[key] = value;
        }
        for (const key of Object.keys(update.$unset || {})) {
          delete job[key];
        }
      }
      return { modifiedCount: matched.length };
    }
  };
}

function quietLogger() {
  return { info() {}, error() {} };
}

function makeJob(id, overrides = {}) {
  return {
    _id: id,
    status: "open",
    assignedUserId: null,
    claimedAt: null,
    everClaimedAt: null,
    publishAt: new Date(BASE - HOUR),
    createdAt: new Date(BASE - HOUR),
    rotationAvailableAt: new Date(BASE - HOUR),
    rotationCount: 0,
    ...overrides
  };
}

function makeWorker(model, options = {}) {
  let now = options.now ?? BASE;

  const worker = createTranscriptionJobRotationWorker({
    Job: model,
    logger: quietLogger(),
    clock: () => now,
    random: options.random ?? (() => 0)
  });

  return {
    worker,
    setNow(value) {
      now = value;
    }
  };
}

test("does not archive before 30 minutes; archives at the cutoff", async () => {
  const model = createFakeModel([
    makeJob("cutoff", {
      rotationAvailableAt: new Date(BASE - 30 * MINUTE + 1)
    })
  ]);
  const { worker, setNow } = makeWorker(model, { random: () => 0 });

  const early = await worker.processJobRotation();
  assert.equal(early.action, "none");
  assert.equal(model.jobs[0].status, "open");

  setNow(BASE + 1);
  const due = await worker.processJobRotation();

  assert.equal(due.action, "archived");
  assert.equal(model.jobs[0].status, "archived");
  assert.equal(model.jobs[0].rotationCount, 1);
  assert.equal(
    due.restoreAt.getTime() - (BASE + 1),
    30 * MINUTE
  );
});

test("restore delay is exactly 30 minutes", async () => {
  for (const random of [0, 0.5, 0.999999]) {
    const model = createFakeModel([
      makeJob("delay", {
        rotationAvailableAt: new Date(BASE - 31 * MINUTE)
      })
    ]);
    const { worker } = makeWorker(model, { random: () => random });

    const result = await worker.processJobRotation();

    assert.equal(
      result.action,
      "archived",
      `Expected archive for random=${random}; got ${JSON.stringify(result)}`
    );

    const delay = result.restoreAt.getTime() - BASE;
    assert.equal(delay, 30 * MINUTE);
  }
});

test("does not restore a job before its future publication time", async () => {
  const model = createFakeModel([
    makeJob("future-published-restore", {
      status: "archived",
      publishAt: new Date(BASE + MINUTE),
      archivedAt: new Date(BASE - 8 * HOUR),
      rotationRestoreAt: new Date(BASE - MINUTE)
    })
  ]);

  const { worker } = makeWorker(model);
  const result = await worker.processJobRotation();

  assert.equal(result.action, "none");
  assert.equal(model.updateCount, 0);
  assert.equal(model.jobs[0].status, "archived");
  assert.equal(
    model.jobs[0].rotationRestoreAt.getTime(),
    BASE - MINUTE
  );
});

test("restores at most one eligible archived job per cycle", async () => {
  const model = createFakeModel([
    makeJob("archived-a", {
      status: "archived",
      archivedAt: new Date(BASE - 8 * HOUR),
      rotationRestoreAt: new Date(BASE - MINUTE)
    }),
    makeJob("archived-b", {
      status: "archived",
      archivedAt: new Date(BASE - 8 * HOUR),
      rotationRestoreAt: new Date(BASE - MINUTE)
    })
  ]);

  const { worker } = makeWorker(model);
  const result = await worker.processJobRotation();

  assert.equal(result.action, "restored");
  assert.equal(model.updateCount, 1);
  assert.equal(
    model.jobs.filter(job => job.status === "open").length,
    1
  );
  assert.equal(
    model.jobs.filter(job => job.status === "archived").length,
    1
  );
});

test("never rotates previously claimed or terminal jobs", async () => {
  const model = createFakeModel([
    makeJob("previously-claimed", {
      everClaimedAt: new Date(BASE - HOUR),
      rotationAvailableAt: new Date(BASE - HOUR)
    }),
    makeJob("awarded", {
      status: "awarded",
      assignedUserId: "worker-1",
      claimedAt: new Date(BASE - HOUR),
      everClaimedAt: new Date(BASE - HOUR)
    }),
    makeJob("submitted", { status: "submitted" }),
    makeJob("completed", { status: "completed" }),
    makeJob("closed", { status: "closed" }),
    makeJob("cancelled", { status: "cancelled" }),
    makeJob("future", {
      publishAt: new Date(BASE + HOUR),
      rotationAvailableAt: new Date(BASE - HOUR)
    })
  ]);

  const { worker } = makeWorker(model);
  const result = await worker.processJobRotation();

  assert.equal(result.action, "none");
  assert.equal(model.updateCount, 0);

  for (const job of model.jobs) {
    assert.notEqual(job.status, "archived", `${job._id} was archived`);
  }
});

test("restored jobs can be archived again after another 30 minutes", async () => {
  const model = createFakeModel([
    makeJob("repeat", {
      status: "archived",
      archivedAt: new Date(BASE - 7 * HOUR),
      rotationRestoreAt: new Date(BASE - MINUTE),
      rotationCount: 1
    })
  ]);

  const { worker, setNow } = makeWorker(model);

  const restored = await worker.processJobRotation();
  assert.equal(restored.action, "restored");
  assert.equal(model.jobs[0].status, "open");

  setNow(BASE + 30 * MINUTE - 1);
  const early = await worker.processJobRotation();
  assert.equal(early.action, "none");
  assert.equal(model.jobs[0].status, "open");

  setNow(BASE + 30 * MINUTE);
  const archivedAgain = await worker.processJobRotation();

  assert.equal(archivedAgain.action, "archived");
  assert.equal(model.jobs[0].status, "archived");
  assert.equal(model.jobs[0].rotationCount, 2);
});

test("a due restoration is not starved by a newer overdue job", async () => {
  const model = createFakeModel([
    makeJob("old-overdue", {
      rotationAvailableAt: new Date(BASE - 2 * HOUR)
    }),
    makeJob("due-restore", {
      status: "archived",
      rotationAvailableAt: new Date(BASE - 8 * HOUR),
      rotationRestoreAt: new Date(BASE - 91 * MINUTE),
      archivedAt: new Date(BASE - 8 * HOUR)
    })
  ]);

  const { worker } = makeWorker(model);
  const result = await worker.processJobRotation();

  assert.equal(result.action, "restored");
  assert.equal(result.jobId, "due-restore");
  assert.equal(model.jobs.find(job => job._id === "old-overdue").status, "open");
});

test("does not rotate a future-published job", async () => {
  const model = createFakeModel([
    makeJob("scheduled", {
      publishAt: new Date(BASE + 10 * MINUTE),
      rotationAvailableAt: new Date(BASE - 2 * HOUR)
    })
  ]);

  const { worker } = makeWorker(model);
  const result = await worker.processJobRotation();

  assert.equal(result.action, "none");
  assert.equal(model.jobs[0].status, "open");
});


test("disabled worker skips rotation", async () => {
  const model = createFakeModel([
    makeJob("must-stay-open", {
      rotationAvailableAt: new Date(BASE - 2 * HOUR)
    })
  ]);
  const { worker } = makeWorker(model);

  await worker.setTranscriptionJobRotationWorkerEnabled(false);
  const result = await worker.processJobRotation();

  assert.equal(result.action, "disabled");
  assert.equal(model.jobs[0].status, "open");
  assert.equal(model.updateCount, 0);
});

test("deactivation restores only eligible rotation-archived jobs", async () => {
  const model = createFakeModel([
    makeJob("rotation-archived", {
      status: "archived",
      archivedAt: new Date(BASE - HOUR),
      rotationRestoreAt: new Date(BASE + HOUR)
    }),
    makeJob("manual-archive", {
      status: "archived",
      archivedAt: new Date(BASE - HOUR)
    }),
    makeJob("claimed-job", {
      status: "archived",
      assignedUserId: "worker-1",
      claimedAt: new Date(BASE - HOUR),
      rotationRestoreAt: new Date(BASE + HOUR)
    }),
    makeJob("previously-claimed", {
      status: "archived",
      everClaimedAt: new Date(BASE - HOUR),
      rotationRestoreAt: new Date(BASE + HOUR)
    }),
    makeJob("future-published", {
      status: "archived",
      publishAt: new Date(BASE + 2 * HOUR),
      rotationRestoreAt: new Date(BASE + HOUR)
    })
  ]);
  const { worker } = makeWorker(model);

  const result = await worker.restoreRotationArchivedJobs();

  assert.equal(result.restoredCount, 1);

  const restored = model.jobs.find(job => job._id === "rotation-archived");
  assert.equal(restored.status, "open");
  assert.equal(restored.rotationAvailableAt.getTime(), BASE);
  assert.equal("archivedAt" in restored, false);
  assert.equal("rotationRestoreAt" in restored, false);

  assert.equal(model.jobs.find(job => job._id === "manual-archive").status, "archived");
  assert.equal(model.jobs.find(job => job._id === "claimed-job").status, "archived");
  assert.equal(model.jobs.find(job => job._id === "previously-claimed").status, "archived");

  const futurePublished = model.jobs.find(job => job._id === "future-published");
  assert.equal(futurePublished.status, "archived");
  assert.ok(futurePublished.rotationRestoreAt instanceof Date);
  assert.equal(futurePublished.rotationRestoreAt.getTime(), BASE + HOUR);
});
