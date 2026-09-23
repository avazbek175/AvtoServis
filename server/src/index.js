require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { seed, db } = require('./db');
const auth = require('./auth');

const authRouter = require('./routes/auth');
const publicRouter = require('./routes/public');
const adminRouter = require('./routes/admin');
const mediaRouter = require('./routes/media');
const worklogsRouter = require('./routes/worklogs');
const workimagesRouter = require('./routes/workimages');

seed();

const app = express();
const PORT = process.env.PORT || 4000;

app.disable('x-powered-by');

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/public', publicRouter);
app.use('/api/admin', adminRouter);
app.use('/api/media', mediaRouter);
app.use('/api/admin/worklogs', worklogsRouter);
app.use('/api/workimages', workimagesRouter);

const uploadsDir = path.join(__dirname, '..', 'uploads');
app.use('/uploads', express.static(uploadsDir));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    services: db.prepare('SELECT COUNT(*) c FROM services').get().c,
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Fayl juda katta (maks 6MB)' : 'Fayl yuklash xatosi';
    return res.status(400).json({ error: msg });
  }
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

const distPath = path.join(__dirname, '..', '..', 'client', 'dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distPath));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;