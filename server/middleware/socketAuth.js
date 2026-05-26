const jwt = require('jsonwebtoken');

module.exports = (socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
        return next(new Error('Authentication error: No Token Provided'));
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.data.user = decoded;
        next();
    } catch (err) {
        // Distinguish expired tokens from truly invalid ones.
        // The client can check error.message to attempt a silent refresh.
        if (err.name === 'TokenExpiredError') {
            const error = new Error('Authentication error: TOKEN_EXPIRED');
            error.data = { code: 'TOKEN_EXPIRED' };
            return next(error);
        }
        return next(new Error('Authentication error: Invalid Token'));
    }
};