
// Validation middleware using Zod schemas
export const validate = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
    next(); 
  } catch (err) {
    return res.status(400).json({ message: err.issues?.[0]?.message ?? "Validation failed" });
  }
};
