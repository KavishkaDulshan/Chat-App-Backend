const ContactRequest = require('../models/ContactRequest');
const Conversation = require('../models/Conversation');
const User = require('../models/User');

// Helper: check if two users already have a conversation (treated as contacts)
async function alreadyHaveConversation(userAId, userBId) {
    const conv = await Conversation.findOne({
        participants: { $all: [userAId, userBId] }
    });
    return !!conv;
}

// Helper: get contact status between two users from the perspective of `myId`
// Returns: 'contacts' | 'pending_sent' | 'pending_received' | 'none'
async function getContactStatus(myId, otherId) {
    const myIdStr = myId.toString();
    const otherIdStr = otherId.toString();

    // Existing conversation = auto contacts
    const hasConv = await alreadyHaveConversation(myIdStr, otherIdStr);
    if (hasConv) return 'contacts';

    const request = await ContactRequest.findOne({
        $or: [
            { from: myIdStr, to: otherIdStr },
            { from: otherIdStr, to: myIdStr }
        ]
    });

    if (!request) return 'none';
    if (request.status === 'accepted') return 'contacts';
    if (request.status === 'declined') return 'none'; // treat declined as none so they can re-request
    // pending
    if (request.from.toString() === myIdStr) return 'pending_sent';
    return 'pending_received';
}

// POST /contacts/request  { toUserId }
exports.sendRequest = async (req, res) => {
    try {
        const fromId = req.user.id;
        const { toUserId } = req.body;

        if (!toUserId) return res.status(400).json({ error: 'toUserId is required' });
        if (fromId === toUserId) return res.status(400).json({ error: 'Cannot send request to yourself' });

        const toUser = await User.findById(toUserId).select('_id username');
        if (!toUser) return res.status(404).json({ error: 'User not found' });

        // Check if already contacts
        const status = await getContactStatus(fromId, toUserId);
        if (status === 'contacts') return res.status(400).json({ error: 'Already contacts' });
        if (status === 'pending_sent') return res.status(400).json({ error: 'Request already sent' });

        // If they already sent us one, just accept it
        if (status === 'pending_received') {
            const existingReq = await ContactRequest.findOne({ from: toUserId, to: fromId, status: 'pending' });
            if (existingReq) {
                existingReq.status = 'accepted';
                await existingReq.save();
                return res.json({ message: 'Accepted their pending request', requestId: existingReq._id, status: 'accepted' });
            }
        }

        // Remove any old declined request so we can re-request
        await ContactRequest.deleteOne({ from: fromId, to: toUserId, status: 'declined' });
        await ContactRequest.deleteOne({ from: toUserId, to: fromId, status: 'declined' });

        const newReq = new ContactRequest({ from: fromId, to: toUserId, status: 'pending' });
        await newReq.save();

        res.status(201).json({
            message: 'Contact request sent',
            requestId: newReq._id,
            status: 'pending_sent'
        });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ error: 'Request already exists' });
        res.status(500).json({ error: err.message });
    }
};

// POST /contacts/accept/:requestId
exports.acceptRequest = async (req, res) => {
    try {
        const myId = req.user.id;
        const { requestId } = req.params;

        const request = await ContactRequest.findById(requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        if (request.to.toString() !== myId) return res.status(403).json({ error: 'Not authorized' });
        if (request.status !== 'pending') return res.status(400).json({ error: 'Request is no longer pending' });

        request.status = 'accepted';
        await request.save();

        res.json({ message: 'Contact request accepted', requestId: request._id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// POST /contacts/decline/:requestId
exports.declineRequest = async (req, res) => {
    try {
        const myId = req.user.id;
        const { requestId } = req.params;

        const request = await ContactRequest.findById(requestId);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        
        // Allow either the receiver to decline, or the sender to cancel
        if (request.to.toString() !== myId && request.from.toString() !== myId) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        request.status = 'declined';
        await request.save();

        res.json({ message: 'Contact request declined', requestId: request._id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /contacts/pending  — incoming and outgoing pending requests
exports.getPendingRequests = async (req, res) => {
    try {
        const myId = req.user.id;
        
        // Incoming
        const incomingReqs = await ContactRequest.find({ to: myId, status: 'pending' })
            .populate('from', 'username profile_pic is_online')
            .sort({ createdAt: -1 });

        // Outgoing
        const outgoingReqs = await ContactRequest.find({ from: myId, status: 'pending' })
            .populate('to', 'username profile_pic is_online')
            .sort({ createdAt: -1 });

        const incomingFormatted = incomingReqs.map(r => ({
            requestId: r._id,
            fromUserId: r.from._id,
            fromUsername: r.from.username,
            fromAvatar: r.from.profile_pic,
            fromIsOnline: r.from.is_online,
            createdAt: r.createdAt,
        }));

        const outgoingFormatted = outgoingReqs.map(r => ({
            requestId: r._id,
            toUserId: r.to._id,
            toUsername: r.to.username,
            toAvatar: r.to.profile_pic,
            toIsOnline: r.to.is_online,
            createdAt: r.createdAt,
        }));

        res.json({
            incoming: incomingFormatted,
            outgoing: outgoingFormatted
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /contacts/status/:userId  — contact status between me and another user
exports.getContactStatus = async (req, res) => {
    try {
        const myId = req.user.id;
        const { userId } = req.params;
        const status = await getContactStatus(myId, userId);
        res.json({ status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Export the helper for use in other controllers / socketHandler
exports.getContactStatusHelper = getContactStatus;
