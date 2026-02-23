const { DataTypes } = require('sequelize');

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

let User, Activity, DailySummary;

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
    totalCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    lastActiveDate: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
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
      allowNull: false,
      references: {
        model: 'Users',
        key: 'id'
      }
    },
    appId: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'ram-bank'
    },
    activityType: {
      type: DataTypes.ENUM('COUNT_INCREMENT', 'REGISTER', 'LOGIN', 'LOGOUT', 'PROFILE_UPDATE', 'DAILY_RESET'),
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
      allowNull: false,
      references: {
        model: 'Users',
        key: 'id'
      }
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

  // Associations
  User.hasMany(Activity, { foreignKey: 'userId' });
  Activity.belongsTo(User, { foreignKey: 'userId' });
  
  User.hasMany(DailySummary, { foreignKey: 'userId' });
  DailySummary.belongsTo(User, { foreignKey: 'userId' });

  // Sync database
  // Use force: true for fresh database (WARNING: deletes existing data)
  // Use alter: true for migrations (can be slow/buggy with SQLite)
  // Use no options for just creating missing tables
  await sequelize.sync({ alter: true });
  console.log('✅ SQL Models Synchronized');

  return { User, Activity, DailySummary };
}

function getModels() {
  return { User, Activity, DailySummary };
}

module.exports = { initModels, getModels };
