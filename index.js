const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json({ limit: '5mb' }));

// Serve static files from the root 'legacy' directory
app.use(express.static(path.join(__dirname, '..'))); // Serve from parent directory (legacy)

// Serve specific subdirectories
app.use('/css', express.static(path.join(__dirname, '..', 'css')));
app.use('/js', express.static(path.join(__dirname, '..', 'js')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// Serve main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'html', 'infinity-craft.html'));
});

// Import API routes
const getWeapon = require('../api/get-weapon');
const saveWeapon = require('../api/save-weapon');

// API routes
app.get('/api/get-weapon', getWeapon);
app.post('/api/save-weapon', saveWeapon);

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});