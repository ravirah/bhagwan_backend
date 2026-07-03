const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        message: 'No token provided' 
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user && req.user.isAdmin) {
    next();
  } else {
    return res.status(403).json({ 
      success: false, 
      message: 'Admin access required' 
    });
  }
};

// Helper: parse an env build number, honoring an explicit 0. `Number('0') || d` returns d
// (0 is falsy), which silently ignored MIN_APP_BUILD=0 — this avoids that trap.
const envBuild = (name, def) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
};

// SOFT app floor — the minimum build for the app to run at all. Drives the client
// force-update screen (via /api/app-config minSupportedVersion). Keep this LOW: a hard
// block strands sideloaded users who have no in-app update channel. Only raise it for a
// genuinely breaking change AND once a working update path exists. Default 1 (= off).
// Set env MIN_APP_BUILD to override (0 is honored).
const MIN_APP_BUILD = envBuild('MIN_APP_BUILD', 1);

// STRICT gate for DESTRUCTIVE ADMIN ops (delete/edit/restore/status). Protects user data
// from old APKs — the "old apps must not delete users" guarantee — WITHOUT blocking normal
// users or login. Default 10. Set env MIN_ADMIN_APP_BUILD to override.
const MIN_ADMIN_APP_BUILD = envBuild('MIN_ADMIN_APP_BUILD', 10);

// Soft version gate: blocks ONLY when the client reports a build below the floor. A missing
// or unparseable X-App-Version header is allowed (fail open) so old apps that predate
// version reporting are never locked out of normal use (e.g. login).
const requireMinAppVersion = (req, res, next) => {
  const build = parseInt(req.headers['x-app-version'], 10);
  if (Number.isFinite(build) && build < MIN_APP_BUILD) {
    return res.status(426).json({
      success: false,
      code: 'UPDATE_REQUIRED',
      minSupportedVersion: MIN_APP_BUILD,
      message: 'Please update to the latest version of the app to continue.',
    });
  }
  next();
};

// Strict version gate for destructive admin actions: blocks old OR unversioned apps
// (missing header). Use this to keep old APKs from mutating/deleting user data.
const requireMinAdminAppVersion = (req, res, next) => {
  const build = parseInt(req.headers['x-app-version'], 10);
  if (!Number.isFinite(build) || build < MIN_ADMIN_APP_BUILD) {
    return res.status(426).json({
      success: false,
      code: 'UPDATE_REQUIRED',
      minSupportedVersion: MIN_ADMIN_APP_BUILD,
      message: 'Please update the app to the latest version to perform this action.',
    });
  }
  next();
};

module.exports = { authMiddleware, adminMiddleware, requireMinAppVersion, requireMinAdminAppVersion, MIN_APP_BUILD, MIN_ADMIN_APP_BUILD };
