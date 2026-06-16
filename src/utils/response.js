const ok = (res, data = {}, message = 'Success', status = 200) =>
  res.status(status).json({ success: true, message, data });

const created = (res, data = {}, message = 'Created') =>
  res.status(201).json({ success: true, message, data });

const fail = (res, message = 'Error', status = 400, errors) =>
  res.status(status).json({ success: false, message, ...(errors && { errors }) });

module.exports = { ok, created, fail };
