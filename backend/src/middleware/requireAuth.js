const jwt = require("jsonwebtoken");
const User = require("../models/User");

module.exports = async function requireAuth(req, res, next) {
  const audioDebug = req.baseUrl === "/api/admin/transcription/assets" &&
    req.path === "/audio/signature";
  const audioStartedAt = Date.now();
  if (audioDebug) console.log("[audio-signature-debug] authentication entered");

  try {
    const token = req.cookies?.ptw_session;
    if (audioDebug) {
      console.log("[audio-signature-debug] session cookie present:", Boolean(token));
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Please sign in to continue."
      });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: "primetask-workspace",
      audience: "primetask-workspace-users"
    });

    if (audioDebug) console.log("[audio-signature-debug] MongoDB lookup started");
    const user = await User.findById(payload.sub)
      .select("_id role status firstName lastName username email");
    if (audioDebug) {
      console.log("[audio-signature-debug] MongoDB lookup finished", {
        elapsedMs: Date.now() - audioStartedAt,
        userFound: Boolean(user),
        active: user?.status === "active"
      });
    }

    if (!user || user.status !== "active") {
      return res.status(401).json({
        success: false,
        message: "Your session is invalid or your account is inactive."
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError"
    ) {
      return res.status(401).json({
        success: false,
        message: "Your session has expired. Please sign in again."
      });
    }

    console.error("Authentication middleware error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Authentication could not be verified."
    });
  }
};
