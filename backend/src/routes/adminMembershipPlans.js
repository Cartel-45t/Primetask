"use strict";

const express = require("express");
const mongoose = require("mongoose");

const MembershipPlan = require("../models/MembershipPlan");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

const SERVICES = [
  "transcription",
  "note-taking",
  "data-entry",
  "academic-writing"
];

router.use(requireAuth);

router.use((req, res, next) => {
  if (!["admin", "founder"].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "Administrator access is required."
    });
  }

  next();
});

function parseUsdCents(value, fieldName, allowZero = true) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < (allowZero ? 0 : 0.01) ||
    !/^\d+(\.\d{1,2})?$/.test(String(value))
  ) {
    throw new Error(
      `${fieldName} must be a valid USD amount with no more than two decimal places.`
    );
  }

  const cents = Math.round(value * 100);

  if (!Number.isSafeInteger(cents)) {
    throw new Error(`${fieldName} is outside the permitted range.`);
  }

  return cents;
}

function validatePlanInput(body, existing = null) {
  const input = {
    key: body.key ?? existing?.key,
    name: body.name ?? existing?.name,
    description: body.description ?? existing?.description ?? "",
    price: body.price ?? (
      existing ? existing.priceCents / 100 : undefined
    ),
    mpesaAmountKes: body.mpesaAmountKes !== undefined
      ? body.mpesaAmountKes
      : (existing?.mpesaAmountKes ?? null),
    durationDays: body.durationDays ?? existing?.durationDays,
    services: body.services ?? existing?.services,
    commissionAmounts: body.commissionAmounts ?? (
      existing
        ? existing.commissionAmountsCents.map(value => value / 100)
        : [0, 0, 0, 0]
    ),
    commissionEnabled:
      body.commissionEnabled ?? existing?.commissionEnabled ?? false,
    active: body.active ?? existing?.active ?? false
  };

  if (
    typeof input.key !== "string" ||
    !/^[a-zA-Z0-9_-]{1,60}$/.test(input.key.trim())
  ) {
    throw new Error(
      "key must contain 1 to 60 letters, numbers, underscores, or hyphens."
    );
  }

  input.key = input.key.trim().toLowerCase();

  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.trim().length > 100
  ) {
    throw new Error("name is required and must not exceed 100 characters.");
  }

  if (
    typeof input.description !== "string" ||
    input.description.length > 1000
  ) {
    throw new Error("description must not exceed 1000 characters.");
  }

  const priceCents = parseUsdCents(input.price, "price", false);

  let mpesaAmountKes = null;
  if (input.mpesaAmountKes !== null && input.mpesaAmountKes !== "") {
    if (
      typeof input.mpesaAmountKes !== "number" ||
      !Number.isSafeInteger(input.mpesaAmountKes) ||
      input.mpesaAmountKes < 1
    ) {
      throw new Error(
        "mpesaAmountKes must be a positive whole number of Kenyan shillings."
      );
    }
    mpesaAmountKes = input.mpesaAmountKes;
  }

  if (input.active && mpesaAmountKes === null) {
    throw new Error(
      "Configure a positive M-Pesa amount in KSh before activating this plan."
    );
  }

  if (
    !Number.isSafeInteger(input.durationDays) ||
    input.durationDays < 1 ||
    input.durationDays > 3660
  ) {
    throw new Error("durationDays must be an integer from 1 to 3660.");
  }

  if (
    !Array.isArray(input.services) ||
    input.services.some(service => !SERVICES.includes(service)) ||
    new Set(input.services).size !== input.services.length
  ) {
    throw new Error(
      "services must contain unique supported service identifiers."
    );
  }

  if (
    !Array.isArray(input.commissionAmounts) ||
    input.commissionAmounts.length !== 4
  ) {
    throw new Error(
      "commissionAmounts must contain exactly four USD amounts, for referral levels 1 to 4."
    );
  }

  const commissionAmountsCents = input.commissionAmounts.map(
    (amount, index) =>
      parseUsdCents(amount, `commissionAmounts[${index}]`)
  );

  if (typeof input.commissionEnabled !== "boolean") {
    throw new Error("commissionEnabled must be true or false.");
  }

  if (typeof input.active !== "boolean") {
    throw new Error("active must be true or false.");
  }

  const totalCommissionCents = commissionAmountsCents.reduce(
    (sum, amount) => sum + amount,
    0
  );

  if (
    !Number.isSafeInteger(totalCommissionCents) ||
    (input.commissionEnabled && totalCommissionCents > priceCents)
  ) {
    throw new Error(
      "Enabled commission amounts must have a safe total no greater than the plan price."
    );
  }

  return {
    key: input.key,
    name: input.name.trim(),
    description: input.description.trim(),
    priceCents,
    currency: "USD",
    mpesaAmountKes,
    durationDays: input.durationDays,
    services: input.services,
    commissionAmountsCents,
    commissionEnabled: input.commissionEnabled,
    active: input.active
  };
}

function serializePlan(plan) {
  return {
    id: String(plan._id),
    key: plan.key,
    name: plan.name,
    description: plan.description,
    price: Number((plan.priceCents / 100).toFixed(2)),
    currency: "USD",
    mpesaAmountKes: Number.isSafeInteger(plan.mpesaAmountKes)
      ? plan.mpesaAmountKes
      : null,
    durationDays: plan.durationDays,
    services: plan.services,
    commissionAmounts: plan.commissionAmountsCents.map(
      amount => Number((amount / 100).toFixed(2))
    ),
    commissionEnabled: plan.commissionEnabled,
    active: plan.active,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  };
}

router.get("/", async (req, res) => {
  try {
    const plans = await MembershipPlan.find({})
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    return res.json({
      success: true,
      currency: "USD",
      commissionLevels: [1, 2, 3, 4],
      plans: plans.map(serializePlan)
    });
  } catch (error) {
    console.error("Admin membership plan list error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load membership plans."
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const data = validatePlanInput(req.body);

    const plan = new MembershipPlan(data);
    await plan.save();

    return res.status(201).json({
      success: true,
      message: "Membership plan created.",
      plan: serializePlan(plan)
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A membership plan with that key already exists."
      });
    }

    if (error.name === "ValidationError" || error.message) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    console.error("Admin membership plan creation error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not create the membership plan."
    });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid membership plan ID."
      });
    }

    if (typeof req.body.active !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "active must be true or false."
      });
    }

    const plan = await MembershipPlan.findById(req.params.id);

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Membership plan not found."
      });
    }

    if (
      req.body.active === true &&
      (!Number.isSafeInteger(plan.mpesaAmountKes) ||
        plan.mpesaAmountKes < 1)
    ) {
      return res.status(400).json({
        success: false,
        message: "Configure a positive M-Pesa amount in KSh before activating this plan."
      });
    }

    plan.active = req.body.active;
    await plan.save();

    return res.json({
      success: true,
      message: plan.active
        ? "Membership plan activated."
        : "Membership plan deactivated.",
      plan: serializePlan(plan)
    });
  } catch (error) {
    console.error("Admin membership plan status error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not update plan status."
    });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid membership plan ID."
      });
    }

    const plan = await MembershipPlan.findById(req.params.id);

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Membership plan not found."
      });
    }

    const data = validatePlanInput(req.body, plan);

    // Avoid silently ignoring misspelled or unsupported fields.
    const allowedFields = new Set([
      "key",
      "name",
      "description",
      "price",
      "mpesaAmountKes",
      "durationDays",
      "services",
      "commissionAmounts",
      "commissionEnabled",
      "active"
    ]);

    const unsupportedFields = Object.keys(req.body).filter(
      field => !allowedFields.has(field)
    );

    if (unsupportedFields.length) {
      return res.status(400).json({
        success: false,
        message: "Unsupported fields in request.",
        fields: unsupportedFields
      });
    }

    Object.assign(plan, data);
    await plan.save();

    return res.json({
      success: true,
      message: "Membership plan updated.",
      plan: serializePlan(plan)
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A membership plan with that key already exists."
      });
    }

    if (error.name === "ValidationError" || error.message) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    console.error("Admin membership plan update error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not update the membership plan."
    });
  }
});

module.exports = router;
