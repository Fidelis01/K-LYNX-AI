//Importing express using npm 
const express = require('express')
const app = express();
const path = require('path')
const dotenv = require('dotenv');
dotenv.config();
const loginRoutes = require('./routes/login')
const cors = require('cors')
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const admin = require('firebase-admin');

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // RENDER: Parse the secret environment variable
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (error) {
        console.error("Render Env Var Error: The JSON is formatted incorrectly.");
        process.exit(1);
    }
} else {
    // LAPTOP: Look for the file
    try {
        serviceAccount = require('./klynx-ai-firebase-key.json');
    } catch (error) {
        console.error("Missing File: Could not find ./klynx-ai-firebase-key.json on local machine.");
        process.exit(1);
    }
}

// Initialize Firebase
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
app.use(cors({
    origin: 'http://127.0.0.1:5500', 
    credentials: true
}))

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')));


//const loginRoutees = require('./routes/login')

app.use('/auth', loginRoutes)


//middleware

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'))
})

app.get('/chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});


app.post('/api/ai/chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

        const chat = model.startChat({ history: history || [] });
        const result = await chat.sendMessage(message);
        const response = await result.response;
        const text = response.text();

        // 4. SAVE THE CONVERSATION TO FIREBASE
        // We create a "collection" called 'chats' and add the new messages
        await db.collection('chats').add({
            userMessage: message,
            aiReply: text,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, reply: text });

    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ success: false, message: "Failed to communicate with AI." });
    }
});

//Create user logic

app.post('/api/auth/signup', async (req, res) => {
    const { email, password, name, language } = req.body;

    try {
        //create the user in firebase auth
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: name,
            language: language
        })

        //optional: Firestore profile document
        await db.collection('users').doc(userRecord.uid).set({
            name: name,
            language: language,
            email: email,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            plan: 'free'            
        });

        res.json({success: true, message: 'User created!', uid: userRecord.uid});

    } catch (error) {
        console.error('Signup Error:', error);
        
        res.status(400).json({ success: false, message: error.message});
    };
});

//Login logic
app.post('/api/auth/login', async(req, res) => {
    const {idToken} = req.body;
    try {
        const decodeToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodeToken.uid;
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            // The user exists in Auth, but not in our Firestore database
            return res.status(404).json({ 
                success: false, 
                message: 'User profile not found in database.' 
            });
        }

        res.json({
            success: true,
            user: userDoc.data()
        });
    } catch (error) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
    }
});

const PORT = process.env.PORT || 5000; 

app.listen(PORT, () => console.log(`Serer is listening on port ${PORT}...`))