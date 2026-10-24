"use strict";

const TranscriptionJob = require("../models/TranscriptionJob");

const INTERVAL_MS = 60 * 1000;
const AVAILABLE_WINDOW_MS = 30 * 60 * 1000;
const MIN_RESTORE_DELAY_MS = 6 * 60 * 60 * 1000;
const MAX_RESTORE_DELAY_MS = 8 * 60 * 60 * 1000;

function createTranscriptionJobRotationWorker({
  Job = TranscriptionJob,
  logger = console,
  clock = Date.now,
  random = Math.random
} = {}) {
  let timer = null;
  let running = false;

  function restoreDelayMs() {
    const range = MAX_RESTORE_DELAY_MS - MIN_RESTORE_DELAY_MS;
    return MIN_RESTORE_DELAY_MS +
      Math.floor(random() * (range + 1));
  }

  async function processJobRotation() {
    if (running) {
      return { skipped: true, action: "none" };
    }

    running = true;

    try {
      const nowMs = clock();
      const now = new Date(nowMs);
      const cutoff = new Date(nowMs - AVAILABLE_WINDOW_MS);

      const overdueFilter = {
        status: "open",
        assignedUserId: null,
        claimedAt: null,
        everClaimedAt: null,
        $and: [
          {
            $or: [
              { publishAt: null },
              { publishAt: { $exists: false } },
              { publishAt: { $lte: now } }
            ]
          },
          {
            $or: [
              { rotationAvailableAt: { $lte: cutoff } },
              {
                rotationAvailableAt: null,
                createdAt: { $lte: cutoff }
              }
            ]
          }
        ]
      };

      const [overdue, dueToRestore] = await Promise.all([
        Job.findOne(overdueFilter)
          .sort({ rotationAvailableAt: 1, createdAt: 1, _id: 1 })
          .select("_id rotationAvailableAt createdAt")
          .lean(),

        Job.findOne({
          status: "archived",
          assignedUserId: null,
          claimedAt: null,
          everClaimedAt: null,
          rotationRestoreAt: { $lte: now }
        })
          .sort({ rotationRestoreAt: 1, _id: 1 })
          .select("_id rotationRestoreAt")
          .lean()
      ]);

      const archiveDueAt = overdue
        ? new Date(
            new Date(
              overdue.rotationAvailableAt || overdue.createdAt
            ).getTime() + AVAILABLE_WINDOW_MS
          ).getTime()
        : Infinity;

      const restoreDueAt = dueToRestore
        ? new Date(dueToRestore.rotationRestoreAt).getTime()
        : Infinity;

      // Process the action that became due first to avoid restoration starvation.
      if (overdue && archiveDueAt <= restoreDueAt) {
        const restoreAt = new Date(nowMs + restoreDelayMs());

        const archived = await Job.findOneAndUpdate(
          { _id: overdue._id, ...overdueFilter },
          {
            $set: {
              status: "archived",
              archivedAt: now,
              rotationRestoreAt: restoreAt
            },
            $inc: { rotationCount: 1 }
          },
          { returnDocument: "after", runValidators: true }
        );

        if (archived) {
          logger.info(
            "Transcription job temporarily archived:",
            String(archived._id),
            "restoreAt:",
            restoreAt.toISOString()
          );

          return {
            action: "archived",
            jobId: String(archived._id),
            restoreAt
          };
        }
      }

      if (dueToRestore) {
        const restored = await Job.findOneAndUpdate(
          {
            _id: dueToRestore._id,
            status: "archived",
            assignedUserId: null,
            claimedAt: null,
            everClaimedAt: null,
            rotationRestoreAt: { $lte: now }
          },
          {
            $set: {
              status: "open",
              rotationAvailableAt: now
            },
            $unset: {
              archivedAt: "",
              rotationRestoreAt: ""
            }
          },
          { returnDocument: "after", runValidators: true }
        );

        if (restored) {
          logger.info(
            "Transcription job restored:",
            String(restored._id)
          );

          return {
            action: "restored",
            jobId: String(restored._id)
          };
        }
      }

      return { action: "none" };
    } catch (error) {
      logger.error(
        "Transcription job rotation failed:",
        error.message
      );
      return { action: "error", error: error.message };
    } finally {
      running = false;
    }
  }

  function startTranscriptionJobRotationWorker() {
    if (timer) return;

    logger.info("Transcription job rotation worker started.");
    void processJobRotation();

    timer = setInterval(() => {
      void processJobRotation();
    }, INTERVAL_MS);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  function stopTranscriptionJobRotationWorker() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    processJobRotation,
    startTranscriptionJobRotationWorker,
    stopTranscriptionJobRotationWorker
  };
}

const productionWorker = createTranscriptionJobRotationWorker();

module.exports = {
  ...productionWorker,
  createTranscriptionJobRotationWorker
};
