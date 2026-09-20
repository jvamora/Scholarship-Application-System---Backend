import dotenv from 'dotenv';
dotenv.config();

const required = ['PORT', 'DB_HOST', 'DB_USER', 'DB_NAME', 'JWT_SECRET'];
required.forEach((key) => {
  if (process.env[key] === undefined || process.env[key] === null) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
});

export const env = {
  port: process.env.PORT || 5000,
  db: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  },
  jwtSecret: process.env.JWT_SECRET,
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
};