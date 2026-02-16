# Ram Counter Backend API

## Multi-Database Support

This backend supports **4 different databases**:
- **MongoDB** (NoSQL)
- **MySQL** (SQL)
- **PostgreSQL** (SQL)
- **SQLite** (SQL - No installation required)

## Quick Start

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Configure Database

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` and set `DB_TYPE` to your preferred database:

#### Option A: MongoDB (Default)
```env
DB_TYPE=mongodb
MONGODB_URI=mongodb://localhost:27017/ram-counter
```

#### Option B: MySQL
```env
DB_TYPE=mysql
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=ram_counter
```

#### Option C: PostgreSQL
```env
DB_TYPE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password
POSTGRES_DATABASE=ram_counter
```

#### Option D: SQLite (Easiest - No setup required!)
```env
DB_TYPE=sqlite
SQLITE_PATH=./database.sqlite
```

### 3. Start the Server

```bash
npm start
# or for development with auto-reload
npm run dev
```

Server will run on `http://localhost:5000`

## Admin Credentials

Default admin credentials (change these in `.env`):
- **Username**: `admin`
- **Password**: `admin123`

## API Endpoints

### Authentication
- `POST /api/auth/login` - User login/register
- `POST /api/auth/admin/login` - Admin login

### Users
- `GET /api/users/profile` - Get user profile (requires auth)
- `PUT /api/users/profile` - Update user profile (requires auth)

### Activities
- `POST /api/activities/add-count` - Add count (requires auth)
- `GET /api/activities/my-activities` - Get user activities (requires auth)
- `GET /api/activities/daily-summary` - Get daily summary (requires auth)

### Admin (requires admin auth)
- `GET /api/admin/users` - Get all users
- `GET /api/admin/users/:userId` - Get user details
- `GET /api/admin/activities` - Get all activities
- `GET /api/admin/stats` - Get dashboard statistics

## Mobile App Configuration

Update the mobile app `.env` file:

```env
EXPO_PUBLIC_API_URL=http://localhost:5000/api
# For Android emulator, use: http://10.0.2.2:5000/api
# For iOS simulator, use: http://localhost:5000/api
# For real device, use your computer's IP: http://192.168.x.x:5000/api
```

## Database Setup

### MongoDB
1. Install MongoDB: https://www.mongodb.com/try/download/community
2. Start MongoDB service
3. Database will be created automatically

### MySQL
1. Install MySQL: https://dev.mysql.com/downloads/
2. Create database:
```sql
CREATE DATABASE ram_counter;
```
3. Update `.env` with credentials
4. Tables will be created automatically

### PostgreSQL
1. Install PostgreSQL: https://www.postgresql.org/download/
2. Create database:
```sql
CREATE DATABASE ram_counter;
```
3. Update `.env` with credentials
4. Tables will be created automatically

### SQLite
- No installation required!
- Database file will be created automatically
- Perfect for testing and development

## Features

✅ Multi-database support (MongoDB, MySQL, PostgreSQL, SQLite)
✅ User authentication with JWT
✅ Admin dashboard
✅ Real-time activity tracking
✅ Daily summaries and statistics
✅ Automatic database schema creation
✅ RESTful API design
✅ CORS enabled for mobile app

## Troubleshooting

### Cannot connect to database
- Check database service is running
- Verify credentials in `.env`
- For MongoDB, ensure connection string is correct
- For MySQL/PostgreSQL, ensure database exists

### Port already in use
Change the PORT in `.env`:
```env
PORT=5001
```

### Mobile app cannot connect
- Check your computer's firewall
- Use correct IP address for real device
- Ensure backend is running

## Production Deployment

1. Set `NODE_ENV=production` in `.env`
2. Use strong JWT secret
3. Change default admin credentials
4. Use environment-specific database URLs
5. Enable HTTPS
6. Set up proper database backups

## License

MIT
