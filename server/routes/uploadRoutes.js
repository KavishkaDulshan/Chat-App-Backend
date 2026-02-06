// server/routes/uploadRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('../config/cloudinary');

const storage = multer.memoryStorage();
// Use 'file' instead of 'image' to be generic
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // Increased limit to 10MB for audio
});

// Changed field name to 'file'
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: "chat_app_uploads",
                    resource_type: "auto" // ✅ Auto-detects image vs audio
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            uploadStream.end(req.file.buffer);
        });

        res.json({ url: result.secure_url });
    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ error: "File upload failed" });
    }
});

module.exports = router;