const mongoose = require('mongoose');

const ContactRequestSchema = new mongoose.Schema({
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    to:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'declined'],
        default: 'pending'
    }
}, { timestamps: true });

// Fast lookups: find request between two users
ContactRequestSchema.index({ from: 1, to: 1 }, { unique: true });
ContactRequestSchema.index({ to: 1, status: 1 }); // for pending inbox

module.exports = mongoose.model('ContactRequest', ContactRequestSchema);
