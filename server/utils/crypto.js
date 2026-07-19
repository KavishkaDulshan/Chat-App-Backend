const crypto = require('crypto');

const algorithm = 'aes-256-cbc';
const secretKey = process.env.MESSAGE_SECRET_KEY || 'default_message_secret_key_123_ensure_32_bytes_length';
const key = Buffer.from(crypto.createHash('sha256').update(secretKey).digest('hex').substring(0, 64), 'hex');

const encrypt = (text) => {
    if (!text) return text;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
};

const decrypt = (text) => {
    if (!text) return text;
    try {
        const textParts = text.split(':');
        // If no IV (old plain text), return as is
        if (textParts.length < 2) return text;

        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        // If decryption fails, assume it's old plain text or image URL
        return text;
    }
};

module.exports = { encrypt, decrypt };