"use strict";

require("dotenv").config({ path: ".env.migration" });

const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const MIGRATION_ID = "legacy-active-members-20261022-v1";
const ADMIN_ID = "6acf3c35cd675fec9616958b";
const BACKUP_PATH = path.join(
  process.cwd(),
  "migration-conflict-backup-2026-10-22T15-19-37-460Z.json"
);

const EXPECTED_CONFLICT_USERS = [
  "6ad33123a6d7b34052a63852",
  "6ad56aff42d12f1e0677c605",
  "6ad27a2ed79a14c82c480354",
  "6ad5670742d12f1e0677c602"
].sort();

const EXPECTED_BACKUP_MEMBERSHIPS = [
  "6ad56eba42d12f1e0677c628",
  "6ad334e3a6d7b34052a63862",
  "6ad55c1642d12f1e0677c5ff"
].sort();

const norm = value => String(value || "").trim().toLowerCase();
const id = value => String(value);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sorted(values) {
  return values.map(String).sort();
}

function splitName(fullName, username) {
  const name = String(fullName || "").trim();

  if (norm(username) === "silas" || name.toLowerCase() === "silas") {
    return { firstName: "Silas", lastName: "Kiprono" };
  }

  const parts = name.split(/\s+/).filter(Boolean);
  assert(parts.length >= 2, `Cannot safely map name for ${username}`);

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ")
  };
}

async function main() {
  let oldDb;
  let newDb;
  let session;

  try {
    assert(process.env.OLD_DATABASE_URI, "OLD_DATABASE_URI is missing.");
    assert(process.env.NEW_DATABASE_URI, "NEW_DATABASE_URI is missing.");
    assert(fs.existsSync(BACKUP_PATH), "The required conflict backup is missing.");

    const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, "utf8"));

    assert(backup.users?.length === 4, "Backup must contain exactly 4 users.");
    assert(
      backup.memberships?.length === 3,
      "Backup must contain exactly 3 memberships."
    );

    assert(
      sorted(backup.users.map(u => u._id)).join(",") ===
        EXPECTED_CONFLICT_USERS.join(","),
      "Backup user IDs differ from the approved deletion scope."
    );

    assert(
      sorted(backup.memberships.map(m => m._id)).join(",") ===
        EXPECTED_BACKUP_MEMBERSHIPS.join(","),
      "Backup membership IDs differ from the approved deletion scope."
    );

    oldDb = await mongoose.createConnection(
      process.env.OLD_DATABASE_URI,
      { serverSelectionTimeoutMS: 15000 }
    ).asPromise();

    newDb = await mongoose.createConnection(
      process.env.NEW_DATABASE_URI,
      { serverSelectionTimeoutMS: 15000 }
    ).asPromise();

    const oldUsers = oldDb.db.collection("users");

    const UserSchema = require("./src/models/User").schema;
    const MembershipSchema = require("./src/models/Membership").schema;
    const PlanSchema = require("./src/models/MembershipPlan").schema;
    const AuditSchema = require("./src/models/AdminAuditLog").schema;

    const User = newDb.model("User", UserSchema);
    const Membership = newDb.model("Membership", MembershipSchema);
    const MembershipPlan = newDb.model("MembershipPlan", PlanSchema);
    const AdminAuditLog = newDb.model("AdminAuditLog", AuditSchema);

    // Read the eligible source cohort. Never import client.admin.
    const sourceUsers = await oldUsers.find({
      membership: { $in: ["platinum", "ascend", "elite"] },
      isSuspended: { $ne: true }
    }).toArray();

    const legacy = sourceUsers.filter(
      u => norm(u.username) !== "client.admin"
    );

    assert(legacy.length === 17,
      `Expected 17 legacy accounts, found ${legacy.length}.`);

    const sourceEmails = new Set();
    const sourceUsernames = new Set();

    for (const u of legacy) {
      const email = norm(u.email);
      const username = norm(u.username);
      const passwordHash = String(u.password || "");
      const names = splitName(u.fullName, username);

      assert(email && email.includes("@"), `Invalid email for ${username}.`);
      assert(/^[a-z0-9_]{3,30}$/.test(username),
        `Invalid V2 username for ${username}.`);
      assert(u.phone, `Missing phone for ${username}.`);
      assert(/^\$2[aby]\$\d{2}\$/.test(passwordHash),
        `Unrecognized bcrypt hash for ${username}.`);
      assert(["user", "admin", "founder"].includes(u.role),
        `Unsupported role for ${username}.`);
      assert(names.firstName.length <= 60 && names.lastName.length <= 60,
        `Name exceeds V2 limits for ${username}.`);

      assert(!sourceEmails.has(email), `Duplicate legacy email: ${email}`);
      assert(!sourceUsernames.has(username),
        `Duplicate legacy username: ${username}`);

      sourceEmails.add(email);
      sourceUsernames.add(username);
    }

    // Match conflicts on BOTH unique fields, not email alone.
    const conflicts = await User.find({
      $or: [
        { email: { $in: [...sourceEmails] } },
        { username: { $in: [...sourceUsernames] } }
      ]
    }).select("_id username email role status").lean();

    assert(
      sorted(conflicts.map(u => u._id)).join(",") ===
        EXPECTED_CONFLICT_USERS.join(","),
      "Current V2 conflicts differ from the four approved accounts. STOP."
    );

    const conflictingIds = conflicts.map(u => u._id);

    const relatedMemberships = await Membership.find({
      userId: { $in: conflictingIds }
    }).select("_id userId").lean();

    assert(
      sorted(relatedMemberships.map(m => m._id)).join(",") ===
        EXPECTED_BACKUP_MEMBERSHIPS.join(","),
      "Associated V2 membership records changed. STOP."
    );

    const admin = await User.findOne({
      _id: new mongoose.Types.ObjectId(ADMIN_ID),
      role: "admin",
      status: "active"
    }).select("_id username").lean();

    assert(admin, "Approved active V2 administrator not found.");

    const plan = await MembershipPlan.findOne({
      key: "starter",
      active: true
    }).lean();

    assert(plan, "Active starter plan not found.");
    assert(plan.durationDays === 100, "Starter duration is not 100 days.");
    assert(plan.currency === "USD", "Starter currency is not USD.");
    assert(Array.isArray(plan.services), "Starter services are invalid.");

    // Refuse to overwrite or duplicate an earlier completed migration.
    const alreadyPresent = await User.find({
      $or: [
        { email: { $in: [...sourceEmails] } },
        { username: { $in: [...sourceUsernames] } }
      ]
    }).lean();

    assert(
      alreadyPresent.length === 4,
      "Unexpected existing source-account conflicts. Refusing to continue."
    );

    console.log("\n========== APPROVED MIGRATION ==========");
    console.log("Migration:", MIGRATION_ID);
    console.log("Legacy users to import:", legacy.length);
    console.log("V2 users to replace:", conflicts.length);
    console.log("V2 memberships to remove:", relatedMemberships.length);
    console.log("Memberships to grant:", legacy.length);
    console.log("Administrator:", admin.username);
    console.log("Plan:", plan.key, "| USD cents:", plan.priceCents);
    console.log("Duration:", plan.durationDays, "days");
    console.log("Backup verified:", path.basename(BACKUP_PATH));
    console.log("\nStarting transaction. No writes occur outside it.");

    session = await newDb.startSession();
    let importedCount = 0;
    let membershipCount = 0;
    let deletedUserCount = 0;
    let deletedMembershipCount = 0;

    await session.withTransaction(async () => {
      // Recheck critical state inside the transaction.
      const currentConflicts = await User.find({
        _id: { $in: conflictingIds }
      }).session(session).lean();

      assert(currentConflicts.length === 4,
        "Conflict records changed before transaction.");

      const currentMemberships = await Membership.find({
        userId: { $in: conflictingIds }
      }).session(session).lean();

      assert(
        sorted(currentMemberships.map(m => m._id)).join(",") ===
          EXPECTED_BACKUP_MEMBERSHIPS.join(","),
        "Membership records changed before transaction."
      );

      const deleteMembershipResult = await Membership.deleteMany({
        _id: { $in: relatedMemberships.map(m => m._id) }
      }, { session });

      deletedMembershipCount = deleteMembershipResult.deletedCount;

      assert(deletedMembershipCount === 3,
        "Did not delete exactly the approved 3 membership records.");

      const deleteUserResult = await User.deleteMany({
        _id: { $in: conflictingIds }
      }, { session });

      deletedUserCount = deleteUserResult.deletedCount;

      assert(deletedUserCount === 4,
        "Did not delete exactly the approved 4 user records.");

      const now = new Date();
      const userMappings = [];

      // Insert accounts with fresh V2 IDs while preserving login credentials.
      for (const source of legacy) {
        const username = norm(source.username);
        const email = norm(source.email);
        const names = splitName(source.fullName, username);

        const created = await User.create([{
          firstName: names.firstName,
          lastName: names.lastName,
          username,
          email,
          phone: String(source.phone).trim(),
          passwordHash: String(source.password),
          role: source.role,
          status: "active",
          emailVerified: source.isVerified === true,
          profilePictureUrl: null,
          selectedService: null,
          referredBy: null,
          lastLoginAt: null,
          createdAt: source.createdAt || now,
          updatedAt: now
        }], { session });

        userMappings.push({
          source,
          user: created[0]
        });

        importedCount++;
      }

      const startsAt = new Date();
      const expiresAt = new Date(
        startsAt.getTime() +
        Number(plan.durationDays) * 24 * 60 * 60 * 1000
      );

      for (const entry of userMappings) {
        const source = entry.source;
        const user = entry.user;
        const grantReason =
          "Legacy active member migration from PrimeTask database; " +
          "no payment or commission created.";
        const grantIdempotencyKey =
          `${MIGRATION_ID}-${String(source._id)}`;

        const createdMembership = await Membership.create([{
          userId: user._id,
          planId: plan._id,
          planKey: plan.key,
          priceCents: plan.priceCents,
          currency: "USD",
          services: plan.services,
          status: "active",
          purchaseId: null,
          grantSource: "admin_award",
          grantReason,
          grantedByAdminId: admin._id,
          grantIdempotencyKey,
          startsAt,
          expiresAt,
          activatedAt: startsAt
        }], { session });

        const membership = createdMembership[0];

        await AdminAuditLog.create([{
          adminId: admin._id,
          targetUserId: user._id,
          action: "membership.legacy_migration",
          reason: grantReason,
          before: {
            legacyUserId: String(source._id),
            legacyTier: source.membership
          },
          after: {
            membershipId: String(membership._id),
            planKey: plan.key,
            durationDays: plan.durationDays,
            currency: "USD",
            startsAt,
            expiresAt,
            grantSource: "admin_award",
            migrationId: MIGRATION_ID
          },
          ipAddress: "migration-script"
        }], { session });

        membershipCount++;
      }

      // Verify imported records and grants before commit.
      const importedUsers = await User.find({
        email: { $in: [...sourceEmails] }
      }).session(session).lean();

      assert(importedUsers.length === 17,
        "Verification failed: expected 17 imported users.");

      const importedIds = importedUsers.map(u => u._id);

      const activeGrants = await Membership.find({
        userId: { $in: importedIds },
        planKey: "starter",
        status: "active",
        grantSource: "admin_award",
        grantedByAdminId: admin._id,
        expiresAt: { $gt: startsAt }
      }).session(session).lean();

      assert(activeGrants.length === 17,
        "Verification failed: expected 17 active starter grants.");

      const excluded = await User.findOne({
        username: "client.admin"
      }).session(session).lean();

      assert(!excluded || !sourceUsernames.has(norm(excluded.username)),
        "client.admin must not be included in the migration cohort.");
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary"
    });

    console.log("\n========== MIGRATION COMMITTED ==========");
    console.log("Imported users:", importedCount);
    console.log("Removed conflicting V2 users:", deletedUserCount);
    console.log("Removed associated memberships:", deletedMembershipCount);
    console.log("Granted active starter memberships:", membershipCount);
    console.log("Wallet/payment/referral/job records were not migrated or deleted.");
    console.log("No purchases or commissions were created.");
    console.log("Migration completed successfully.");
  } finally {
    if (session) await session.endSession().catch(() => {});
    if (newDb) await newDb.close();
    if (oldDb) await oldDb.close();
  }
}

main().catch(error => {
  console.error("\nMIGRATION FAILED.");
  console.error(error.name + ": " + error.message);
  console.error("If the transaction aborted, its database changes were rolled back.");
  process.exitCode = 1;
});
