# Retreats by Traveon — Backend

Node.js + Express + MySQL (Sequelize) API for the Retreats by Traveon platform.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # then edit values
```

Make sure MySQL is running and the database `retreats_traveon` (or whatever you set in `.env`) exists.

```sql
CREATE DATABASE retreats_traveon CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

## Run

```bash
npm run dev          # nodemon (development)
npm start            # production
npm run seed:admin   # creates the admin user from .env values
```

## Project layout

```
src/
  app.js              # Express app
  server.js           # bootstrap
  config/             # db config
  models/             # Sequelize models
  controllers/        # route handlers
  routes/             # route mounts
  middlewares/        # auth, error, upload
  seeders/            # db seed scripts
  utils/              # helpers (jwt, response, etc.)
uploads/              # uploaded media (served at /uploads)
```

## Auth

Admin login is at `POST /api/auth/login` with `{ email, password }`. Returns a JWT.
Protected routes expect `Authorization: Bearer <token>`.
