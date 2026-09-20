# Environment Configuration Guide

## Required Environment Variables

Create a `.env` file in the `server` directory with the following variables:

### Server Configuration
```
PORT=3000
NODE_ENV=development
```

### Database Configuration
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=scholarship_portal
```

### JWT Configuration
```
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=7d
```

### Client Configuration
```
CLIENT_URL=http://localhost:5173
```


### File Upload Configuration
```
UPLOAD_DIR=uploads
MAX_FILE_SIZE=10485760  # 10MB
```

### Rate Limiting
```
RATE_LIMIT_WINDOW_MS=900000  # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100
```

### Committee Review Decision Policy
```
COMMITTEE_QUORUM=1
```

- Number of **independent Scholarship Reviewer (committee) evaluations** required before an application's status can flip.
- `1` = single reviewer decides alone — Approve/Reject applies immediately; Waitlist parks the application in `waitlisted` for later promotion.
- `2` = quorum of 2 + strict majority required before any status change.
- Read at server startup in `src/routes/committeeRoutes.js`; restart the server after changing it.

## Setup Instructions

1. Create a `.env` file in the `server` directory
2. Copy the above variables into the file
3. Replace placeholder values with your actual configuration
4. Make sure the MySQL database is running
5. Run the database migrations

## Security Notes

- Never commit your `.env` file to version control
- Use strong, random values for JWT_SECRET
- Use a dedicated database user with limited privileges
- In production, use environment variables from your hosting provider
