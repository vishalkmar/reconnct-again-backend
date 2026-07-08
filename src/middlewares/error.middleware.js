const notFound = (req, res, next) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.originalUrl}` });
};

const errorHandler = (err, req, res, next) => {
  // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  if (process.env.NODE_ENV === 'development') {
    console.error('[ERROR]', err);
  }

  // Multer's own outer size cap (a video/doc exceeding the general limit) —
  // otherwise falls through to the generic 500 below with a confusing status.
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'File is too large.' });
  }

  // Sequelize validation errors
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: err.errors?.map((e) => ({ field: e.path, message: e.message })),
    });
  }

  res.status(status).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = { notFound, errorHandler };
