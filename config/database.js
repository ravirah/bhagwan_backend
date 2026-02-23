const mongoose = require('mongoose');
const { Sequelize } = require('sequelize');

class DatabaseFactory {
  constructor() {
    this.dbType = process.env.DB_TYPE || 'mongodb';
    this.connection = null;
  }

  async connect() {
    switch (this.dbType) {
      case 'mongodb':
        return this.connectMongoDB();
      case 'mysql':
        return this.connectMySQL();
      case 'postgres':
        return this.connectPostgres();
      case 'sqlite':
        return this.connectSQLite();
      default:
        throw new Error(`Unsupported database type: ${this.dbType}`);
    }
  }

  async connectMongoDB() {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      console.log('✅ MongoDB Connected');
      this.connection = mongoose.connection;
      return { type: 'mongodb', connection: this.connection };
    } catch (error) {
      console.error('❌ MongoDB Connection Error:', error);
      throw error;
    }
  }

  async connectMySQL() {
    try {
      const sequelize = new Sequelize(
        process.env.MYSQL_DATABASE,
        process.env.MYSQL_USER,
        process.env.MYSQL_PASSWORD,
        {
          host: process.env.MYSQL_HOST,
          port: process.env.MYSQL_PORT || 3306,
          dialect: 'mysql',
          logging: process.env.NODE_ENV === 'development' ? console.log : false,
          pool: {
            max: 5,
            min: 0,
            acquire: 30000,
            idle: 10000
          }
        }
      );
      await sequelize.authenticate();
      console.log('✅ MySQL Connected');
      this.connection = sequelize;
      return { type: 'mysql', connection: sequelize };
    } catch (error) {
      console.error('❌ MySQL Connection Error:', error);
      throw error;
    }
  }

  async connectPostgres() {
    try {
      const sequelize = new Sequelize(
        process.env.POSTGRES_DATABASE,
        process.env.POSTGRES_USER,
        process.env.POSTGRES_PASSWORD,
        {
          host: process.env.POSTGRES_HOST,
          port: process.env.POSTGRES_PORT || 5432,
          dialect: 'postgres',
          logging: process.env.NODE_ENV === 'development' ? console.log : false,
          pool: {
            max: 5,
            min: 0,
            acquire: 30000,
            idle: 10000
          }
        }
      );
      await sequelize.authenticate();
      console.log('✅ PostgreSQL Connected');
      this.connection = sequelize;
      return { type: 'postgres', connection: sequelize };
    } catch (error) {
      console.error('❌ PostgreSQL Connection Error:', error);
      throw error;
    }
  }

  async connectSQLite() {
    try {
      const sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: process.env.SQLITE_PATH || './database.sqlite',
        logging: process.env.NODE_ENV === 'development' ? console.log : false,
      });
      await sequelize.authenticate();
      console.log('✅ SQLite Connected');
      this.connection = sequelize;
      return { type: 'sqlite', connection: sequelize };
    } catch (error) {
      console.error('❌ SQLite Connection Error:', error);
      throw error;
    }
  }

  getConnection() {
    return this.connection;
  }

  getType() {
    return this.dbType;
  }

  isSQL() {
    return ['mysql', 'postgres', 'sqlite'].includes(this.dbType);
  }

  isMongoDB() {
    return this.dbType === 'mongodb';
  }
}

module.exports = new DatabaseFactory();
