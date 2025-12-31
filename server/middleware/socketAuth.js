const jwt = require('jsonwebtoken');

module.exports = (socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
        return next(new Error("Authentication error: No Token Provided"));
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.data.user = decoded; // Attach user to socket
        next();
    } catch (err) {
        return next(new Error("Authentication error: Invalid Token"));
    }
};