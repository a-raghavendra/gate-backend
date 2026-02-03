require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // Recommended for mobile to talk to server

const app = express();
const PORT = process.env.PORT || 4800;
const admin = require('firebase-admin');
// 1. Check if running on Render (Production) vs Local
const serviceAccountPath = process.env.RENDER 
  ? '/etc/secrets/service-account.json'  // Render Path
  : './service-account.json';            // Local Path
const serviceAccount = require(serviceAccountPath);
// 1. Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// 2. New Endpoint: Send Notification
app.post('/send-notification', async (req, res) => {
  const { token, title, body, data } = req.body;

  // Construct the message payload
  const message = {
    notification: {
      title: title,
      body: body,
    },
    data: data || {}, // Optional extra data (e.g., visitor ID)
    token: token, // The device token you saved earlier
  };

  try {
    const response = await admin.messaging().send(message);
    console.log('Successfully sent message:', response);
    res.status(200).json({ success: true });
  } catch (error) {
    console.log('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

app.use(express.json());
app.use(cors()); // Allow cross-origin requests

// ---------------------------------------------------------
// 1. DATABASE CONNECTION
// ---------------------------------------------------------
const dbURI = process.env.MONGO_URI;

mongoose.connect(dbURI)
  .then(() => console.log('✅ Successfully connected to MongoDB!'))
  .catch((err) => console.log('❌ Database connection error:', err));

// ---------------------------------------------------------
// 2. SCHEMAS & MODELS
// ---------------------------------------------------------

// USER SCHEMA (Guard/Resident/Admin)
const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: String,
  role: { type: String, enum: ['guard', 'resident', 'admin'], required: true },
  flatNumber: String,
  pushToken: String
});

const User = mongoose.model('User', userSchema);

// 1. ANNOUNCEMENT SCHEMA
const announcementSchema = new mongoose.Schema({
  title: String,
  message: String,
  target: { type: String, enum: ['all', 'resident', 'guard'], default: 'all' },
  date: { type: Date, default: Date.now }
});

const Announcement = mongoose.model('Announcement', announcementSchema);

// 2. POST API: Create Announcement & Notify
app.post('/admin/announce', async (req, res) => {
  try {
    const { title, message, target } = req.body;

    // A. Save to Database
    const newAnnouncement = new Announcement({ title, message, target });
    await newAnnouncement.save();

    // B. Find Users to Notify
    let filter = {};
    if (target === 'resident') filter = { role: 'resident' };
    if (target === 'guard') filter = { role: 'guard' };
    // if 'all', filter remains {} (finds everyone)

    const usersToNotify = await User.find(filter);

    // C. Send Push Notifications (Loop through users)
    // In a real production app, use 'sendMulticast' or a queue to handle 100s of users.
    // For now, a simple loop works fine.
    usersToNotify.forEach(user => {
      if (user.pushToken) {
        sendPushNotification(user.pushToken, `📢 ${title}`, message);
      }
    });

    res.json({ message: "Announcement Sent!", count: usersToNotify.length });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error });
  }
});

// 3. GET API: Fetch Announcements (For Resident/Guard Apps)
app.get('/announcements/:role', async (req, res) => {
  try {
    const { role } = req.params;
    // Fetch announcements that match the role OR are for 'all'
    const notices = await Announcement.find({
      $or: [{ target: role }, { target: 'all' }]
    }).sort({ date: -1 }); // Newest first
    
    res.json(notices);
  } catch (error) {
    res.status(500).json({ error });
  }
});

// VISITOR SCHEMA
const visitorSchema = new mongoose.Schema({
  name: String,
  purpose: String,
  flatNumber: String,
  status: { type: String, default: 'Pending' },
  entryTime: { type: Date, default: Date.now },
  approvalTime: { type: Date } // Tracks when status becomes 'Approved'
});

const Visitor = mongoose.model('Visitor', visitorSchema);

// ---------------------------------------------------------
// 3. HELPER FUNCTIONS
// ---------------------------------------------------------

// Send Notification to Expo
const sendPushNotification = async (expoPushToken, title, body) => {
  if (!expoPushToken) return;
  
  const message = {
    to: expoPushToken,
    sound: 'default',
    title: title,
    body: body,
    data: { someData: 'goes here' },
  };

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });
    console.log(`📲 Notification sent to ${expoPushToken}`);
  } catch (error) {
    console.error("Error sending notification:", error);
  }
};

// ---------------------------------------------------------
// 4. AUTH & USER ROUTES
// ---------------------------------------------------------

// LOGIN
app.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const user = await User.findOne({ phone: phone });
    
    if (user && user.password === password) {
      res.json({ 
        message: "Login Successful", 
        user: { 
          name: user.name, 
          role: user.role, 
          flatNumber: user.flatNumber,
          _id: user._id 
        } 
      });
    } else {
      res.status(401).json({ message: "Invalid Phone or Password" });
    }
  } catch (error) {
    res.status(500).json({ message: "Server Error", error });
  }
});

// SAVE PUSH TOKEN
app.patch('/update-token', async (req, res) => {
  const { phone, token } = req.body;
  try {
    await User.findOneAndUpdate({ phone: phone }, { pushToken: token });
    res.json({ message: "Token updated" });
  } catch (error) {
    res.status(500).json({ error });
  }
});

// GET CONTACT FOR CALLING (Guard Feature)
app.get('/resident-contact/:flat', async (req, res) => {
  try {
    const { flat } = req.params;
    const resident = await User.findOne({ flatNumber: flat, role: 'resident' });
    
    if (resident) {
      res.json({ phone: resident.phone, name: resident.name });
    } else {
      res.status(404).json({ message: "Resident not found" });
    }
  } catch (error) {
    res.status(500).json({ error });
  }
});

// ---------------------------------------------------------
// 5. VISITOR ROUTES
// ---------------------------------------------------------

// CREATE Visitor & NOTIFY Resident
app.post('/visitor-request', async (req, res) => {
  console.log("🔔 New Visitor Request:", req.body);
  try {
    const { name, flatNumber } = req.body;

    // 1. Save Visitor
    const newVisitor = new Visitor(req.body);
    await newVisitor.save();

    // 2. Find Resident to Notify
    const resident = await User.findOne({ flatNumber: flatNumber, role: 'resident' });

    if (resident && resident.pushToken) {
      await sendPushNotification(
        resident.pushToken, 
        "New Visitor! 🔔", 
        `${name} is at the gate.`
      );
    }

    res.status(201).json({ message: "Saved & Notified!", data: newVisitor });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error });
  }
});

// GET All Visitors (For Guard & Admin Reports)
app.get('/all-visitors', async (req, res) => {
  try {
    // Sort by entryTime descending (Newest first)
    const visitors = await Visitor.find().sort({ entryTime: -1 });
    res.json(visitors);
  } catch (error) {
    res.status(500).json({ error });
  }
});

// GET Visitors for Specific Flat (For Resident Dashboard)
app.get('/visitors/:flat', async (req, res) => {
  try {
    const { flat } = req.params;
    const visitors = await Visitor.find({ flatNumber: flat }).sort({ entryTime: -1 });
    res.json(visitors);
  } catch (error) {
    res.status(500).json({ message: "Error fetching flat visitors", error });
  }
});

// UPDATE Visitor Status (Approve/Reject) + TIMESTAMP LOGIC
app.put('/visitor-response', async (req, res) => {
  try {
    const { id, status } = req.body;
    
    // Prepare update object
    let updateData = { status };

    // 🔴 CRITICAL CHANGE: 
    // We now check for BOTH 'Approved' OR 'Rejected'
    if (status === 'Approved' || status === 'Rejected') {
      updateData.approvalTime = new Date(); 
    }

    const updatedVisitor = await Visitor.findByIdAndUpdate(id, updateData, { new: true });
    
    res.json({ message: "Status Updated", data: updatedVisitor });
  } catch (error) {
    res.status(500).json({ error });
  }
});
// ---------------------------------------------------------
// 6. ADMIN ROUTES
// ---------------------------------------------------------

// Admin Dashboard Stats
app.get('/admin/stats', async (req, res) => {
  try {
    const guards = await User.countDocuments({ role: 'guard' });
    const residents = await User.countDocuments({ role: 'resident' });
    const visitors = await Visitor.countDocuments({}); 
    res.json({ guards, residents, visitors });
  } catch (error) {
    res.status(500).json({ error });
  }
});

// Get Users by Role
app.get('/admin/users/:role', async (req, res) => {
  try {
    const users = await User.find({ role: req.params.role });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error });
  }
});

// Create New User (Admin)
app.post('/admin/create-user', async (req, res) => {
  try {
    const newUser = new User(req.body);
    await newUser.save();
    res.json({ message: "User Created Successfully", user: newUser });
  } catch (error) {
    res.status(500).json({ error: "Phone number likely exists already" });
  }
});

// Delete User
app.delete('/admin/user/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: "User Deleted" });
  } catch (error) {
    res.status(500).json({ error });
  }
});

// Update User
app.put('/admin/user/:id', async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, req.body);
    res.json({ message: "User Updated" });
  } catch (error) {
    res.status(500).json({ error });
  }
});

// ---------------------------------------------------------
// 7. SERVER START
// ---------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});




