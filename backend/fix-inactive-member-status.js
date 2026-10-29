"use strict";

require("dotenv").config({ path: ".env.migration" });

const mongoose = require("mongoose");

const norm = value => String(value || "").trim().toLowerCase();

async function main() {
  let oldDb;
  let newDb;
  let session;

  try {
    if (!process.env.OLD_DATABASE_URI || !process.env.NEW_DATABASE_URI) {
      throw new Error("Migration database credentials are missing.");
    }

    oldDb = await mongoose.createConnection(
      process.env.OLD_DATABASE_URI,
      { serverSelectionTimeoutMS: 15000 }
    ).asPromise();

    newDb = await mongoose.createConnection(
      process.env.NEW_DATABASE_URI,
      { serverSelectionTimeoutMS: 15000 }
    ).asPromise();

    if (oldDb.name !== "PrimeTask") {
      throw new Error(`Unexpected source database: ${oldDb.name}`);
    }

    if (newDb.name !== "primetask_workspace_1") {
      throw new Error(`Unexpected target database: ${newDb.name}`);
    }

    const User = newDb.model(
      "User",
      require("./src/models/User").schema
    );

    const legacyUsers = oldDb.db.collection("users");

    const source = await legacyUsers.find({
      membership: "inactive",
      username: { $nin: ["client.admin"] }
    }).toArray();

    if (source.length !== 69) {
      throw new Error(
        `Expected 69 legacy inactive accounts; found ${source.length}.`
      );
    }

    const cohort = source.filter(
      user => norm(user.username) !== "abby"
    );

    if (cohort.length !== 68) {
      throw new Error(
        `Expected 68 eligible accounts; found ${cohort.length}.`
      );
    }

    const usernames = cohort.map(user => norm(user.username));

    if (new Set(usernames).size !== 68 || usernames.some(u => !u)) {
      throw new Error("Duplicate or missing usernames in source cohort.");
    }

    const targets = await User.find({
      username: { $in: usernames }
    }).select("_id username email role status").lean();

    if (targets.length !== 68) {
      throw new Error(
        `Expected 68 target accounts; found ${targets.length}.`
      );
    }

    const targetByUsername = new Map(
      targets.map(user => [norm(user.username), user])
    );

    for (const legacy of cohort) {
      const username = norm(legacy.username);
      const target = targetByUsername.get(username);

      if (!target) {
        throw new Error(`Target account missing: ${username}`);
      }

      if (norm(target.email) !== norm(legacy.email)) {
        throw new Error(`Email mismatch for ${username}. Aborting.`);
      }

      if (target.status !== "suspended") {
        throw new Error(
          `${username} has status "${target.status}", not "suspended". Aborting.`
        );
      }

      if (target.role === "admin") {
        throw new Error(`Administrator found in cohort: ${username}`);
      }
    }

    console.log("========== PRE-UPDATE VERIFICATION ==========");
    console.log("Source database:", oldDb.name);
    console.log("Target database:", newDb.name);
    console.log("Legacy inactive accounts:", source.length);
    console.log("Abby excluded:", true);
    console.log("Matched target accounts:", targets.length);
    console.log("Email matches:", 68);
    console.log("Currently suspended:", 68);
    console.log("Administrator accounts in cohort:", 0);
    console.log("No unrelated accounts selected.");

    if (process.argv[2] !== "--confirm") {
      console.log("\nDRY RUN ONLY. No database records changed.");
      console.log("Run with --confirm only after reviewing this output.");
      return;
    }

    session = await newDb.startSession();

    await session.withTransaction(async () => {
      // Recheck every record inside the transaction before writing.
      const current = await User.find({
        username: { $in: usernames }
      }).session(session).select("_id username email role status").lean();

      if (current.length !== 68) {
        throw new Error("Cohort changed during verification.");
      }

      const currentByUsername = new Map(
        current.map(user => [norm(user.username), user])
      );

      for (const legacy of cohort) {
        const username = norm(legacy.username);
        const target = currentByUsername.get(username);

        if (
          !target ||
          norm(target.email) !== norm(legacy.email) ||
          target.status !== "suspended" ||
          target.role === "admin"
        ) {
          throw new Error(
            `Safety recheck failed for ${username}. Transaction aborted.`
          );
        }
      }

      const result = await User.updateMany(
        {
          username: { $in: usernames },
          status: "suspended",
          role: { $ne: "admin" }
        },
        { $set: { status: "inactive" } },
        { session, runValidators: true }
      );

      if (result.matchedCount !== 68 || result.modifiedCount !== 68) {
        throw new Error(
          `Expected 68 matched and modified; got ` +
          `${result.matchedCount} matched, ${result.modifiedCount} modified.`
        );
      }

      const verified = await User.find({
        username: { $in: usernames }
      }).session(session).select("username email role status").lean();

      if (
        verified.length !== 68 ||
        !verified.every(user => user.status === "inactive")
      ) {
        throw new Error("Post-update verification failed.");
      }

      console.log("\nVerified inside transaction: all 68 accounts inactive.");
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary"
    });

    const finalUsers = await User.find({
      username: { $in: usernames }
    }).select("username status").lean();

    console.log("\n========== STATUS CORRECTION COMPLETE ==========");
    console.log("Accounts corrected:", finalUsers.length);
    console.log(
      "Inactive:",
      finalUsers.filter(user => user.status === "inactive").length
    );
    console.log(
      "Still suspended:",
      finalUsers.filter(user => user.status === "suspended").length
    );
    console.log("Memberships awarded: 0");
    console.log("Wallet/payment/referral/job records changed: 0");
  } finally {
    if (session) await session.endSession();
    if (oldDb) await oldDb.close();
    if (newDb) await newDb.close();
  }
}

main().catch(error => {
  console.error("\nSTATUS CORRECTION ABORTED:", error.message);
  process.exitCode = 1;
});
