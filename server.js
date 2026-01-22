
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose'); // Add this
const app = express();
const PORT = process.env.PORT || 4800;
app.use(express.json());
// const dbURI = process.env.MONGO_URI || 'YOUR_CURRENT_CONNECTION_STRING';


// 1. CONNECT TO DATABASE (Replace with YOUR string)
const dbURI = process.env.MONGO_URI ;
mongoose.connect(dbURI)
  .then(() => console.log('Successfully connected to MongoDB!'))
  .catch((err) => console.log('Database connection error:', err));

// 2. DEFINE THE SCHEMA (The structure)
const visitorSchema = new mongoose.Schema({
  name: String,
  purpose: String,
  flatNumber: String,
  status: { type: String, default: 'Pending' }, // Default status is pending
  entryTime: { type: Date, default: Date.now }
});

// 3. CREATE THE MODEL
const Visitor = mongoose.model('Visitor', visitorSchema);
// 1. DEFINE THE USER SCHEMA
const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // In real apps, we encrypt this!
  name: String,
  role: { type: String, enum: ['guard', 'resident'], required: true },
  flatNumber: String // Only needed if role is 'resident'
});

const User = mongoose.model('User', userSchema);

// 4. UPDATED POST ROUTE: Actually saving to Database
app.post('/visitor-request', async (req, res) => {
  // This will print to your VS Code terminal every time a guard pings
  console.log("🔔 New Visitor Pinged from App!");
  console.log("Details:", req.body); 

  try {
    const newVisitor = new Visitor(req.body);
    const savedVisitor = await newVisitor.save();
    
    console.log("✅ Successfully saved to Database ID:", savedVisitor._id);
    
    res.status(201).json({ message: "Saved to Database!", data: savedVisitor });
  } catch (error) {
    console.log("❌ Database Error:", error);
    res.status(500).json({ message: "Error saving data", error });
  }
});
// GET All Visitors (For Guard Dashboard)
app.get('/all-visitors', async (req, res) => {
  try {
    // Sort by entryTime descending (-1) so newest are at the top
    const visitors = await Visitor.find().sort({ entryTime: -1 });
    res.json(visitors);
  } catch (error) {
    res.status(500).json({ error });
  }
});
app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});

// 5. RESIDENT'S ACTION: Approve or Reject a visitor
app.patch('/visitor-status/:id', async (req, res) => {
  try {
    const { id } = req.params; // Get the ID from the URL
    const { status } = req.body; // Get the new status (Approved/Rejected)

    // Find the visitor by ID and update their status
    const updatedVisitor = await Visitor.findByIdAndUpdate(
      id, 
      { status: status }, 
      { new: true } // This returns the updated version of the record
    );

    res.json({ message: "Status Updated!", data: updatedVisitor });
  } catch (error) {
    res.status(500).json({ message: "Error updating status", error });
  }
});
// NEW ROUTE: Get visitors for a SPECIFIC flat
app.get('/visitors/:flat', async (req, res) => {
  try {
    const { flat } = req.params;
    const visitors = await Visitor.find({ flatNumber: flat }).sort({ entryTime: -1 });
    res.json(visitors);
  } catch (error) {
    res.status(500).json({ message: "Error fetching flat visitors", error });
  }
});

// 2. LOGIN ROUTE
app.post('/login', async (req, res) => {
  const { phone, password } = req.body;

  try {
    // Find user by phone
    const user = await User.findOne({ phone: phone });
    
    // Check if user exists AND password matches
    if (user && user.password === password) {
      res.json({ 
        message: "Login Successful", 
        user: { 
          name: user.name, 
          role: user.role, 
          flatNumber: user.flatNumber 
        } 
      });
    } else {
      res.status(401).json({ message: "Invalid Phone or Password" });
    }
  } catch (error) {
    res.status(500).json({ message: "Server Error", error });
  }
});

// TEMP ROUTE: Create dummy users (Run this once via Postman then delete)
app.post('/register-test', async (req, res) => {
  try {
    const newUser = new User(req.body);
    await newUser.save();
    res.json({ message: "User Created!", user: newUser });
  } catch (error) {
    res.status(500).json({ error });
  }
});