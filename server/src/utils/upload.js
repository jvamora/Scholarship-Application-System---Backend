const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directories exist
const uploadDirs = [
  'uploads/applications',
  'uploads/avatars'
];

uploadDirs.forEach(dir => {
  const fullPath = path.join(__dirname, '../', dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

// Configure storage for different file types
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadPath = path.join(__dirname, '../uploads/applications/');
    
    if (file.fieldname === 'avatar') {
      uploadPath = path.join(__dirname, '../uploads/avatars/');
    }
    
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext).replace(/\s+/g, '_');
    cb(null, `${basename}-${uniqueSuffix}${ext}`);
  }
});

// File filter to accept only certain file types
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/jpg',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PDF, JPG, PNG, and DOCX files are allowed.'), false);
  }
};

// Create multer instances with different limits
const uploadApplication = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 10 // Max 10 files per upload
  }
});

const uploadAvatar = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPG and PNG files are allowed for avatars.'), false);
    }
  },
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
    files: 1
  }
});

module.exports = {
  uploadApplication,
  uploadAvatar,
  // Middleware for handling errors
  handleMulterError: (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File size too large. Maximum size is 10MB for documents and 2MB for avatars.'
        });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({
          success: false,
          message: 'Too many files. Maximum 10 files can be uploaded at once.'
        });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({
          success: false,
          message: 'Unexpected file field name.'
        });
      }
    }
    
    if (err) {
      // An unknown error occurred
      return res.status(400).json({
        success: false,
        message: err.message || 'File upload failed.'
      });
    }
    
    next();
  }
};