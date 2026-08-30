module.exports = (err, req, res, next) => {
  console.error(err);
  if (err.name === 'ZodError') return res.status(400).json({error:'Validation failed', details:err.issues});
  res.status(err.status || 500).json({error: err.message || 'Internal server error'});
};
