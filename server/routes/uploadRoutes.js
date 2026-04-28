// server/routes/uploadRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('crypto');
const { uploadBuffer } = require('../config/azureStorage');

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

/**
 * Generate a unique blob name with folder structure.
 * Format: <folder>/<timestamp>-<random>.ext
 */
function generateBlobName(folder, extension) {
    const timestamp = Date.now();
    const randomId = crypto.randomBytes(8).toString('hex');
    return `${folder}/${timestamp}-${randomId}${extension}`;
}

/**
 * Detect if the uploaded file is an image based on MIME type.
 */
function isImage(mimetype) {
    return mimetype && mimetype.startsWith('image/');
}

/**
 * Compress an image buffer using Sharp.
 * - Converts to WebP format
 * - Resizes to max 1080px (preserves aspect ratio)
 * - Does NOT upscale small images
 */
async function compressImage(buffer, maxWidth = 1080, quality = 80) {
    return sharp(buffer)
        .rotate()                       // Auto-fix EXIF orientation
        .resize({
            width: maxWidth,
            height: maxWidth,
            fit: 'inside',              // Fit within bounds, keep aspect ratio
            withoutEnlargement: true    // Don't upscale small images
        })
        .webp({ quality })             // Convert to WebP
        .toBuffer();
}

// ── Main Upload Endpoint ──
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const { mimetype, buffer, originalname } = req.file;
        let uploadData;
        let blobName;
        let contentType;

        if (isImage(mimetype)) {
            // ── IMAGE: Compress to WebP ──
            uploadData = await compressImage(buffer);
            blobName = generateBlobName('images', '.webp');
            contentType = 'image/webp';
            console.log(`📸 Image compressed: ${(buffer.length / 1024).toFixed(1)}KB → ${(uploadData.length / 1024).toFixed(1)}KB (WebP)`);
        } else {
            // ── AUDIO / OTHER: Upload as-is (already compressed by device codec) ──
            const ext = originalname ? '.' + originalname.split('.').pop() : '.bin';
            blobName = generateBlobName('audio', ext);
            uploadData = buffer;
            contentType = mimetype || 'application/octet-stream';
            console.log(`🎵 Audio uploaded: ${(buffer.length / 1024).toFixed(1)}KB`);
        }

        const url = await uploadBuffer(uploadData, blobName, contentType);
        res.json({ url });

    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ error: "File upload failed" });
    }
});

// ── Profile Picture Upload (smaller, square crop) ──
router.post('/upload/profile', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const { buffer } = req.file;

        // Compress to 256x256 square WebP (cover crop)
        const uploadData = await sharp(buffer)
            .rotate()
            .resize({ width: 256, height: 256, fit: 'cover' })
            .webp({ quality: 80 })
            .toBuffer();

        const blobName = generateBlobName('profiles', '.webp');
        const url = await uploadBuffer(uploadData, blobName, 'image/webp');

        console.log(`👤 Profile pic: ${(buffer.length / 1024).toFixed(1)}KB → ${(uploadData.length / 1024).toFixed(1)}KB`);
        res.json({ url });

    } catch (err) {
        console.error("Profile Upload Error:", err);
        res.status(500).json({ error: "Profile picture upload failed" });
    }
});

module.exports = router;