const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const authRoutes = require('./routes/authRoutes');
const scholarshipRoutes = require('./routes/scholarshipRoutes');
const applicationRoutes = require('./routes/applicationRoutes');
const searchRoutes = require('./routes/searchRoutes');
const reportRoutes = require('./routes/reportRoutes');
const documentRoutes = require('./routes/documentRoutes');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/scholarships', scholarshipRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/documents', documentRoutes);

const homeRoutes = require('./routes/homeRoutes');
const staffRoutes = require('./routes/staffRoutes');
const adminRoutes = require('./routes/adminRoutes');
const committeeRoutes = require('./routes/committeeRoutes');
const studentRoutes = require('./routes/studentRoutes');
const selectionRoutes = require('./routes/selectionRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
app.use('/api/home', homeRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/committee', committeeRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/selection', selectionRoutes);
app.use('/api/notifications', notificationRoutes);
// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
});

module.exports = app;
