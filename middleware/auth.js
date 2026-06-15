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

// Minimum app build (Android versionCode) allowed to perform gated operations.
// Override via env MIN_APP_BUILD (e.g. set to 0 in Render to disable the gate instantly
// as a safety valve, without a code change). Clients send their build in X-App-Version.
const MIN_APP_BUILD = Number(process.env.MIN_APP_BUILD) || 10;

// Rejects requests from app versions below MIN_APP_BUILD (or that send no version —
// i.e. old APKs predating version reporting). Blocks old apps from destructive actions
// and forces an update. Pass it BEFORE the route handler.
const requireMinAppVersion = (req, res, next) => {
  const raw = req.headers['x-app-version'];
  const build = parseInt(raw, 10);
  // Missing/old version → block. (New apps always send a numeric build.)
  if (!Number.isFinite(build) || build < MIN_APP_BUILD) {
    return res.status(426).json({
      success: false,
      code: 'UPDATE_REQUIRED',
      minSupportedVersion: MIN_APP_BUILD,
      message: 'Please update to the latest version of the app to continue.',
    });
  }
  next();
};

module.exports = { authMiddleware, adminMiddleware, requireMinAppVersion, MIN_APP_BUILD };
