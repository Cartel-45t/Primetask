"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("./src/models/User");

const TEMP_PASSWORD = "PrimetaskV2";
const BCRYPT_ROUNDS = 12;

async function main() {
  if (!process.env.DATABASE_URI && !process.env.MONGODB_URI) {
    throw new Error("Database URI is missing from backend environment.");
  }

  await mongoose.connect(
    process.env.DATABASE_URI || process.env.MONGODB_URI
  );

  const dbName = mongoose.connection.name;

  console.log("Connected database:", dbName);

  if (dbName !== "primetask_workspace_1") {
    throw new Error(
      `Wrong database "${dbName}". No passwords were changed.`
    );
  }

  const targets = await User.find({
    role: { $ne: "admin" }
  })
    .select("_id username role")
    .lean();

  const admins = await User.countDocuments({ role: "admin" });

  console.log("Non-admin accounts to reset:", targets.length);
  console.log("Admin accounts excluded:", admins);

  if (targets.length === 0) {
    throw new Error("No eligible accounts found. Aborting.");
  }

  const confirmation = process.argv[2];

  if (confirmation !== "--confirm-reset") {
    console.log("DRY RUN ONLY. No passwords changed.");
    console.log("To execute, rerun with --confirm-reset");
    return;
  }

  const hash = await bcrypt.hash(TEMP_PASSWORD, BCRYPT_ROUNDS);

  const result = await User.updateMany(
    { role: { $ne: "admin" } },
    { $set: { passwordHash: hash } }
  );

  console.log("Matched:", result.matchedCount);
  console.log("Modified:", result.modifiedCount);

  const remaining = await User.countDocuments({
    role: { $ne: "admin" },
    passwordHash: { $ne: hash }
  });

  const adminCheck = await User.countDocuments({
    role: "admin",
    passwordHash: hash
  });

  console.log("Non-admin accounts not matching new hash:", remaining);
  console.log("Admin accounts matching new hash:", adminCheck);

  if (
    result.matchedCount !== targets.length ||
    remaining !== 0 ||
    adminCheck !== 0
  ) {
    throw new Error("Verification failed. Review results before proceeding.");
  }

  console.log("SUCCESS: All non-admin passwords reset and verified.");
  console.log("Temporary password: PrimetaskV2");
  console.log("Change this shared password as soon as possible.");
}

main()
  .catch(error => {
    console.error("RESET FAILED:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
