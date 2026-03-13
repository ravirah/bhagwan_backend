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

let User, Activity, DailySummary, Slogan;

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
    }
  }, {
    tableName: 'users',
    timestamps: true,
    indexes: [
      { fields: ['email'] },
      { fields: ['mobile'] },
      { fields: ['appId'] },
      { fields: ['appId', 'mobile'], unique: true } // Unique mobile per app
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
      type: DataTypes.TEXT,
      allowNull: false
    },
    en: {
      type: DataTypes.TEXT,
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

  // Associations - explicit constraint names to avoid conflicts on shared hosting
  User.hasMany(Activity, { foreignKey: 'userId', constraints: false });
  Activity.belongsTo(User, { foreignKey: 'userId', constraints: false });

  User.hasMany(DailySummary, { foreignKey: 'userId', constraints: false });
  DailySummary.belongsTo(User, { foreignKey: 'userId', constraints: false });

  // Sync database
  // Use force: true for fresh database (WARNING: deletes existing data)
  // Use alter: true for migrations (can be slow/buggy with SQLite)
  // Use no options for just creating missing tables
  await sequelize.sync({ alter: true });
  await seedDefaultSlogans(Slogan);
  console.log('✅ SQL Models Synchronized');

  return { User, Activity, DailySummary, Slogan };
}

function getModels() {
  return { User, Activity, DailySummary, Slogan };
}

module.exports = { initModels, getModels };
