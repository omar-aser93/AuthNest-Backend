import xss from 'xss';

// Sanitize text input. Removes HTML so the value can be treated as plain text.
// We use it with req.body text inputs to prevent xss injection
export const sanitizeText = (value) => {
  if (typeof value !== 'string') return value;
  return xss(value, {
    whiteList: {}, // no HTML allowed
    stripIgnoreTag: true
  });
};


// Escape text before inserting it into an HTML document.
// Use this when building HTML emails.
export const escapeHtml = (value = '') =>
  String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));


