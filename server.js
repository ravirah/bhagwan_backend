// Only load .env file in development - in production, use system env vars
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const dbFactory = require('./config/database');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware - CORS Configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Database
let db = null;

async function initializeDatabase() {
  try {
    db = await dbFactory.connect();
    console.log(`📦 Database Type: ${db.type.toUpperCase()}`);
    
    // Initialize models based on database type
    if (dbFactory.isSQL()) {
      await require('./models/sql').initModels(db.connection);
    } else {
      require('./models/mongodb');
    }
    
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/activities', require('./routes/activities'));
app.use('/api/slogans', require('./routes/slogans'));
app.use('/api/admin', require('./routes/admin'));

// Public app-config — the app polls this on launch to enforce a minimum version.
// If the installed build is below minSupportedVersion, the app shows an "Update
// required" screen. updateUrl points to the latest APK.
app.get('/api/app-config', (req, res) => {
  const { MIN_APP_BUILD } = require('./middleware/auth');
  res.json({
    success: true,
    minSupportedVersion: MIN_APP_BUILD,
    latestVersion: Number(process.env.LATEST_APP_BUILD) || MIN_APP_BUILD,
    updateUrl: process.env.APP_UPDATE_URL || '',
    message: 'A newer version of the app is required.',
  });
});

// Health Check - use /api prefix for consistency
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    database: {
      type: db ? db.type : (process.env.DB_TYPE || 'not connected'),
      connected: db ? true : false
    },
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    success: false, 
    message: err.message || 'Internal Server Error' 
  });
});

// Start Server
async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 API URL: http://localhost:${PORT}`);
  });
}

startServer();

module.exports = app;
