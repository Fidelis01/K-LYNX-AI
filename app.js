//Importing express using npm 
const express = require('express')
const app = express();
const path = require('path')
const dotenv = require('dotenv');
dotenv.config();
const loginRoutes = require('./routes/login')
const cors = require('cors')

app.use(cors({
    origin: 'http://127.0.0.1:5500', 
    credentials: true
}))

app.use(express.json())
app.use(express.static('public'));

const loginRoutees = require('./routes/login')

app.use('/auth', loginRoutes)


//middleware

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'))
})
//app.use('/api/v1/login',login)


const PORT = process.env.PORT || 5000; 

app.listen(PORT, () => console.log(`Serer is listening on port ${PORT}...`))