const { webcrypto } = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const { BlobServiceClient } = require('@azure/storage-blob');
require('dotenv').config();
const logger = require('../utils/logger');

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER || 'media';

if (!connectionString) {
    logger.error('AZURE_STORAGE_CONNECTION_STRING is not set');
    process.exit(1);
}

const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
const containerClient = blobServiceClient.getContainerClient(containerName);

(async () => {
    try {
        await containerClient.createIfNotExists({ access: 'blob' });

        const serviceProperties = await blobServiceClient.getProperties();
        let corsRules = serviceProperties.cors || [];

        const hasWildcardCors = corsRules.some(rule => rule.allowedOrigins === '*');

        if (!hasWildcardCors) {
            corsRules.push({
                allowedOrigins: '*',
                allowedMethods: 'GET,OPTIONS',
                allowedHeaders: '*',
                exposedHeaders: '*',
                maxAgeInSeconds: 86400
            });
            serviceProperties.cors = corsRules;
            await blobServiceClient.setProperties(serviceProperties);
            logger.info('Azure Blob CORS configured');
        }

        logger.info(`Azure Blob container "${containerName}" ready`);
    } catch (err) {
        logger.error('Azure container init error', { error: err.message });
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

        if (!url.hostname.endsWith('.blob.core.windows.net')) {
            logger.debug('Skipping non-Azure URL', { blobUrl: blobUrl.substring(0, 60) });
            return false;
        }

        // Path is /<container>/<blobName>, strip leading slash and container
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length < 2) return false;

        // Remove container name, rejoin the rest (blob name may contain slashes)
        const blobName = pathParts.slice(1).join('/');
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.deleteIfExists();
        logger.info('Deleted blob', { blobName });
        return true;
    } catch (err) {
        logger.error('Delete blob error', { blobUrl, error: err.message });
        return false;
    }
}

module.exports = { containerClient, uploadBuffer, deleteBlob };
