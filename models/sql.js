const { DataTypes } = require('sequelize');
const defaultSlogans = require('../config/defaultSlogans');

async function seedDefaultSlogans(SloganModel) {
  for (const [appId, slogans] of Object.entries(defaultSlogans)) {
    for (const slogan of slogans) {
      await SloganModel.findOrCreate({
        where: { appId, hi: slogan.hi },
        defaults: { appId, hi: slogan.hi, en: slogan.en },
      });
    }
  }
}

function getSyncMode() {
  const configured = String(process.env.DB_SYNC_MODE || '').trim().toLowerCase();
  if (configured) return configured;
  return process.env.NODE_ENV === 'production' ? 'safe' : 'alter';
}

// Idempotently add a column to an existing table. Needed because safe-mode sync()
// only CREATES missing tables — it never adds columns to an existing one. Re-running is
// harmless (the duplicate-column error is swallowed). Works on MySQL (prod) and SQLite (dev).
async function ensureColumn(sequelize, table, columnDdl, columnName) {
  try {
    await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
    console.log(`✅ Added column ${table}.${columnName}`);
  } catch (e) {
    if (/duplicate column|already exists|duplicate column name/i.test(e.message || '')) {
      // Column already present — nothing to do.
    } else {
      console.warn(`ensureColumn(${table}.${columnName}) note:`, e.message);
    }
  }
}

async function syncDatabase(sequelize) {
  const syncMode = getSyncMode();

  switch (syncMode) {
    case 'off':
    case 'none':
      console.log('ℹ️ Skipping sequelize.sync() because DB_SYNC_MODE is disabled');
      return;
    case 'force':
      await sequelize.sync({ force: true });
      console.log('⚠️ SQL Models synchronized with force mode');
      return;
    case 'alter':
      await sequelize.sync({ alter: true });
      console.log('✅ SQL Models synchronized with alter mode');
      return;
    case 'safe':
    default:
      await sequelize.sync();
      console.log(`✅ SQL Models synchronized with ${syncMode === 'safe' ? 'safe' : syncMode} mode`);
      return;
  }
}

/**
 * MULTI-APP ARCHITECTURE
 *
 * This system supports multiple spiritual counter apps (Ram Counter, Hanuman Chalisa, etc.)
 * sharing one backend. Users are scoped by 'appId' field.
 *
 * CRITICAL: All user queries MUST include appId to maintain app isolation.
 * Example: User.findOne({ where: { mobile, appId: 'ram-bank' } })
 *
 * Database has UNIQUE constraint on (appId, mobile) - same mobile can exist in different apps.
 */

let User, Activity, DailySummary, Slogan, AuditLog;

async function initModels(sequelize) {
  User = sequelize.define('User', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true
    },
    mobile: {
      type: DataTypes.STRING,
      allowNull: false
    },
    pin: {
      type: DataTypes.STRING,
      allowNull: true
    },
    appId: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'ram-bank'
    },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected'),
      defaultValue: 'pending',
      allowNull: false
    },
    totalCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    lastActiveDate: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    // Soft-delete marker. Non-null = "deleted" (hidden from admin lists & blocked at
    // login) but the row and all activities/summaries are kept intact and recoverable.
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null
    }
  }, {
    tableName: 'users',
    timestamps: true,
    indexes: [
      { fields: ['email'] },
      { fields: ['mobile'] },
      { fields: ['appId'] },
      { fields: ['appId', 'mobile'], unique: true }
    ]
  });

  Activity = sequelize.define('Activity', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    appId: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'ram-bank'
    },
    activityType: {
      type: DataTypes.ENUM('COUNT_INCREMENT', 'REGISTER', 'LOGIN', 'LOGOUT', 'PROFILE_UPDATE', 'DAILY_RESET', 'APPROVAL', 'REJECTION'),
      allowNull: false
    },
    count: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    metadata: {
      type: DataTypes.JSON,
      defaultValue: {}
    },
    timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'activities',
    timestamps: false,
    indexes: [
      { fields: ['userId'] },
      { fields: ['timestamp'] },
      { fields: ['activityType'] },
      { fields: ['appId'] }
    ]
  });

  DailySummary = sequelize.define('DailySummary', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    appId: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'ram-bank'
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    dailyCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    totalCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    streak: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    firstCountAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    lastCountAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    activeDurationSeconds: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    }
  }, {
    tableName: 'dailysummaries',
    timestamps: true,
    indexes: [
      { fields: ['userId'] },
      { fields: ['date'] },
      { fields: ['appId'] },
      {
        unique: true,
        fields: ['userId', 'date']
      }
    ]
  });

  Slogan = sequelize.define('Slogan', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    appId: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'ram-bank'
    },
    hi: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    en: {
      type: DataTypes.STRING(255),
      allowNull: false
    }
  }, {
    tableName: 'slogans',
    timestamps: true,
    indexes: [
      { fields: ['appId'] },
      { fields: ['appId', 'createdAt'] },
      { unique: true, fields: ['appId', 'hi'] }
    ]
  });

  // Permanent, append-only record of admin actions — answers "who did what, when".
  AuditLog = sequelize.define('AuditLog', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    adminUser: { type: DataTypes.STRING, allowNull: true },
    action: { type: DataTypes.STRING, allowNull: false },
    targetUserId: { type: DataTypes.INTEGER, allowNull: true },
    targetMobile: { type: DataTypes.STRING, allowNull: true },
    details: { type: DataTypes.JSON, defaultValue: {} },
    ipAddress: { type: DataTypes.STRING, allowNull: true },
  }, {
    tableName: 'auditlogs',
    timestamps: true,
    indexes: [
      { fields: ['action'] },
      { fields: ['targetUserId'] },
      { fields: ['createdAt'] },
    ],
  });

  User.hasMany(Activity, { foreignKey: 'userId', constraints: false });
  Activity.belongsTo(User, { foreignKey: 'userId', constraints: false });

  User.hasMany(DailySummary, { foreignKey: 'userId', constraints: false });
  DailySummary.belongsTo(User, { foreignKey: 'userId', constraints: false });

  await syncDatabase(sequelize);
  // safe-sync doesn't add columns to an existing table, so add deletedAt explicitly.
  await ensureColumn(sequelize, 'users', 'deletedAt DATETIME NULL', 'deletedAt');
  await seedDefaultSlogans(Slogan);

  return { User, Activity, DailySummary, Slogan, AuditLog };
}

function getModels() {
  return { User, Activity, DailySummary, Slogan, AuditLog };
}

module.exports = { initModels, getModels };

