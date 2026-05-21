import jwt from 'jsonwebtoken';

const generateToken = (id) => {
    // Hardcoded to 30 days to guarantee it never fails
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d', 
    });
};

export default generateToken;
