require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const mapsKeyRouter = require('./api/maps-key');

// Enable CORS for development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) {
            res.set('Content-Type', 'application/javascript');
        }
        if (filePath.endsWith('.mjs') || filePath.endsWith('module.js')) {
            res.set('Content-Type', 'application/javascript; charset=utf-8');
        }
    }
}));

// Mount the maps-key route
app.use('/api/maps-key', mapsKeyRouter);

const PORT = 5500;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});