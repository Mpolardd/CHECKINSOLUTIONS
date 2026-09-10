module.exports = (err, req, res, next) => {
  console.error(err);
  if (err.name === 'ZodError') return res.status(400).json({error:'Validation failed', details:err.issues});

  const errorMessage = process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(err.status || 500).json({error: errorMessage});
};
