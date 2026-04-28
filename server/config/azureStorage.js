// Polyfill for global crypto required by @azure/storage-blob in Node 18
const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// server/config/azureStorage.js
const { BlobServiceClient } = require('@azure/storage-blob');
require('dotenv').config();

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER || 'media';

if (!connectionString) {
    console.error('❌ AZURE_STORAGE_CONNECTION_STRING is not set in .env');
    process.exit(1);
}

const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
const containerClient = blobServiceClient.getContainerClient(containerName);

// Ensure container exists (creates on first run)
(async () => {
    try {
        await containerClient.createIfNotExists({
            access: 'blob' // Public read access for blobs (URLs work directly)
        });
        console.log(`✅ Azure Blob container "${containerName}" ready`);
    } catch (err) {
        console.error('❌ Azure container init error:', err.message);
    }
})();

/**
 * Upload a buffer to Azure Blob Storage.
 * @param {Buffer} buffer - File data
 * @param {string} blobName - Unique name for the blob (e.g., "images/abc123.webp")
 * @param {string} contentType - MIME type (e.g., "image/webp", "audio/mp4")
 * @returns {string} Public URL of the uploaded blob
 */
async function uploadBuffer(buffer, blobName, contentType) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(buffer, {
        blobHTTPHeaders: { blobContentType: contentType }
    });
    return blockBlobClient.url;
}

/**
 * Delete a blob from Azure Blob Storage by its full URL.
 * Safely handles non-Azure URLs (e.g., legacy Cloudinary URLs) by skipping them.
 * @param {string} blobUrl - Full URL of the blob
 * @returns {boolean} true if deleted, false if skipped
 */
async function deleteBlob(blobUrl) {
    if (!blobUrl) return false;

    try {
        // Extract blob name from URL: https://<account>.blob.core.windows.net/<container>/<blobName>
        const url = new URL(blobUrl);

        // Only delete Azure blobs (skip Cloudinary and other legacy URLs)
        if (!url.hostname.endsWith('.blob.core.windows.net')) {
            console.log(`⏭️ Skipping non-Azure URL: ${blobUrl.substring(0, 60)}...`);
            return false;
        }

        // Path is /<container>/<blobName>, strip leading slash and container
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length < 2) return false;

        // Remove container name, rejoin the rest (blob name may contain slashes)
        const blobName = pathParts.slice(1).join('/');
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.deleteIfExists();
        console.log(`🗑️ Deleted blob: ${blobName}`);
        return true;
    } catch (err) {
        console.error(`❌ Delete blob error for ${blobUrl}:`, err.message);
        return false;
    }
}

module.exports = { containerClient, uploadBuffer, deleteBlob };
