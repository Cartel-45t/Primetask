"use strict";

require("dotenv").config({ path: ".env.migration" });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const PASSWORD = "PrimetaskV2";
const ADMIN_ID = "6acf3c35cd675fec9616958b";
const norm = v => String(v || "").trim().toLowerCase();

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function splitName(fullName, username) {
  const name = String(fullName || "").trim();

  if (norm(username) === "silas" || norm(name) === "silas") {
    return { firstName: "Silas", lastName: "Kiprono" };
  }

  const parts = name.split(/\s+/).filter(Boolean);
  assert(parts.length >= 1, `Cannot safely map name for ${username}`);

  return {
    firstName: parts[0],
    lastName: parts.length === 1 ? "😎😎" : parts.slice(1).join(" ")
  };
}

async function main() {
  let oldDb;
  let newDb;
  let session;

  try {
    assert(process.env.OLD_DATABASE_URI, "OLD_DATABASE_URI missing.");
    assert(process.env.NEW_DATABASE_URI, "NEW_DATABASE_URI missing.");

    oldDb = await mongoose.createConnection(
      process.env.OLD_DATABASE_URI,
      { serverSelectionTimeoutMS: 15000 }
    ).asPromise();

    newDb = await mongoose.createConnection(
      process.env.NEW_DATABASE_URI,
      { serverSelectionTimeoutMS: 15000 }
    ).asPromise();

    assert(oldDb.name === "PrimeTask",
      `Unexpected source database: ${oldDb.name}`);
    assert(newDb.name === "primetask_workspace_1",
      `Unexpected target database: ${newDb.name}`);

    const UserSchema = require("./src/models/User").schema;
    const User = newDb.model("User", UserSchema);

    const oldUsers = oldDb.db.collection("users");

    // Only explicitly inactive legacy membership accounts.
    const source = await oldUsers.find({
      membership: "inactive",
      username: { $nin: ["client.admin"] }
    }).toArray();

    assert(source.length === 69,
      `Expected 69 inactive accounts; found ${source.length}. Aborting.`);

    // Exclude Abby as requested; keep the original 69-account audit above.
    const migrationSource = source.filter(
      u => norm(u.username) !== "abby"
    );

    assert(migrationSource.length === 68,
      `Expected 68 accounts after excluding abby; found ${migrationSource.length}. Aborting.`);

    const usernames = new Set();
    const emails = new Set();
    const candidates = [];

    for (const u of migrationSource) {
      const username = norm(u.username);
      const email = norm(u.email);
      const phone = String(u.phone || "").trim();
      const names = splitName(u.fullName, username);

      assert(username && /^[a-z0-9_]{3,30}$/.test(username),
        `Invalid username for source ID ${u._id}`);
      assert(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
        `Invalid email for ${username}`);
      assert(phone, `Missing phone for ${username}`);
      assert(["user", "admin", "founder"].includes(u.role),
        `Unsupported role for ${username}`);
      assert(u.role !== "admin",
        `Legacy admin account found in inactive cohort: ${username}`);
      assert(names.firstName.length <= 60 && names.lastName.length <= 60,
        `Name too long for ${username}`);
      assert(!usernames.has(username), `Duplicate username: ${username}`);
      assert(!emails.has(email), `Duplicate email: ${email}`);

      usernames.add(username);
      emails.add(email);

      candidates.push({
        sourceId: String(u._id),
        username,
        email,
        phone,
        names,
        role: u.role,
        emailVerified: u.isVerified === true,
        // Preserve legacy inactivity rather than activating the account.
        status: "suspended"
      });
    }

    // Never overwrite an existing V2 account, even if only one unique
    // field conflicts.
    const conflicts = await User.find({
      $or: [
        { username: { $in: [...usernames] } },
        { email: { $in: [...emails] } }
      ]
    }).select("_id username email role").lean();

    assert(conflicts.length === 0,
      `${conflicts.length} username/email conflicts found. No writes performed.`);

    const admin = await User.findOne({
      _id: new mongoose.Types.ObjectId(ADMIN_ID),
      role: "admin"
    }).select("_id username").lean();

    assert(admin, "Approved V2 admin not found.");

    console.log("\n========== INACTIVE MEMBER MIGRATION DRY RUN ==========");
    console.log("Source database:", oldDb.name);
    console.log("Target database:", newDb.name);
    console.log("Inactive accounts found:", source.length);
    console.log("Validated import candidates:", candidates.length);
    console.log("Existing V2 conflicts:", conflicts.length);
    console.log("Administrator excluded:", admin.username);
    console.log("Password assigned to imported accounts:", PASSWORD);
    console.log("Imported status: suspended (inactive)");
    console.log("Membership grants: 0");
    console.log("Wallet/payment/referral/job changes: 0");
    console.log("No writes performed.");

    if (process.argv[2] !== "--confirm-import") {
      console.log("\nDRY RUN ONLY. Review the results before importing.");
      return;
    }

    const passwordHash = await bcrypt.hash(PASSWORD, 12);
    session = await newDb.startSession();

    let importedCount = 0;

    await session.withTransaction(async () => {
      const recheck = await User.find({
        $or: [
          { username: { $in: [...usernames] } },
          { email: { $in: [...emails] } }
        ]
      }).session(session).lean();

      assert(recheck.length === 0,
        "A V2 account appeared after preflight. Aborting.");

      const docs = candidates.map(c => ({
        firstName: c.names.firstName,
        lastName: c.names.lastName,
        username: c.username,
        email: c.email,
        phone: c.phone,
        passwordHash,
        role: c.role,
        status: c.status,
        emailVerified: c.emailVerified,
        profilePictureUrl: null,
        referredBy: null
      }));

      const inserted = await User.insertMany(docs, {
        session,
        ordered: true
      });

      importedCount = inserted.length;

      assert(importedCount === candidates.length,
        "Imported count does not match validated candidates.");

      const verified = await User.find({
        username: { $in: [...usernames] }
      }).select("_id username email role status emailVerified").session(session).lean();

      assert(verified.length === candidates.length,
        "Post-import account count mismatch.");

      assert(verified.every(u => u.status === "suspended"),
        "An imported account was not kept inactive.");

      assert(verified.every(u => u.role !== "admin"),
        "Unexpected admin role in imported cohort.");
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary"
    });

    console.log("\n========== IMPORT COMMITTED ==========");
    console.log("Imported inactive members:", importedCount);
    console.log("Password set: PrimetaskV2");
    console.log("Inactive status preserved: verified");
    console.log("Membership awards: 0");
    console.log("Wallet/payment/referral/job records created: 0");
    console.log("No existing V2 users were overwritten.");
  } finally {
    if (session) await session.endSession().catch(() => {});
    if (newDb) await newDb.close();
    if (oldDb) await oldDb.close();
  }
}

main().catch(error => {
  console.error("\nINACTIVE MEMBER MIGRATION FAILED.");
  console.error(error.name + ": " + error.message);
  console.error("If a transaction started, MongoDB should roll back its writes.");
  process.exitCode = 1;
});
