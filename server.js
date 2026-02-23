require('dotenv').config();
const express = require('express');
const cors = require('cors');
const dbFactory = require('./config/database');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware - CORS Configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Debug: log DB_TYPE to diagnose env var issues
console.log(`🔍 DB_TYPE env var: "${process.env.DB_TYPE}"`);
console.log(`🔍 NODE_ENV: "${process.env.NODE_ENV}"`);

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
app.use('/api/admin', require('./routes/admin'));

// Health Check - use /api prefix for consistency
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    database: {
      type: db ? db.type : (process.env.DB_TYPE || 'not connected'),
      connected: db ? true : false
    },
    env: {
      DB_TYPE: process.env.DB_TYPE || 'not set',
      NODE_ENV: process.env.NODE_ENV || 'not set'
    }
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
