require('dotenv').config();
const { Expo } = require('expo-server-sdk');
const expo = new Expo();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4800;

app.use(cors()); 
app.use(express.json({ limit: '10mb' })); 
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------------------------------------------------------
// 1. DATABASE CONNECTION
// ---------------------------------------------------------patch
const dbURI = process.env.MONGO_URI;

mongoose.connect(dbURI)
  .then(() => console.log('✅ Successfully connected to MongoDB!'))
  .catch((err) => console.log('❌ Database connection error:', err));

// ---------------------------------------------------------
// 2. SCHEMAS & MODELS
// ---------------------------------------------------------

// USER SCHEMA
const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: String,
  role: { type: String, enum: ['guard', 'resident', 'admin'], required: true },
  flatNumber: String,
  photo: { type: String, default: '' },
  pushToken: { type: String, default: null}  // Stores "ExponentPushToken[...]"
});
const User = mongoose.model('User', userSchema);

// VISITOR SCHEMA
const visitorSchema = new mongoose.Schema({
  name: String,
  purpose: String,
  flatNumber: String,
  status: { type: String, default: 'Pending' },
  entryTime: { type: Date, default: Date.now },
  approvalTime: { type: Date },
  photo: { type: String, default: '' },
  mobile: { type: String, required: true }
});
const Visitor = mongoose.model('Visitor', visitorSchema);

// ANNOUNCEMENT SCHEMA
const announcementSchema = new mongoose.Schema({
  title: String,
  message: String,
  target: { type: String, enum: ['all', 'resident', 'guard'], default: 'all' },
  date: { type: Date, default: Date.now }
});
const Announcement = mongoose.model('Announcement', announcementSchema);



// GET: Get all users in a specific flat
app.get('/users-by-flat/:flatNumber', async (req, res) => {
  try {
    const { flatNumber } = req.params;
    
    // Find all users with this flat number
    const users = await User.find({ flatNumber: flatNumber }).select('name role');
    
    res.json(users);
  } catch (error) {
    console.error("Error fetching flat members:", error);
    res.status(500).json({ message: "Server error" });
  }
});
// ---------------------------------------------------------
// 3. HELPER FUNCTION (The Production Notification Sender)
// ---------------------------------------------------------
/*const sendPushNotification = async (expoPushToken, title, body, data = {}) => {
  if (!expoPushToken) return;
  
  // Expo's Production API
  const message = {
    to: expoPushToken,
    sound: 'default',
    title: title,
    body: body,
    channelId: "default",   // 👈 REQUIRED for Android 8+
    priority: "high",
    data: data, // Payload for when user taps the notification
  };

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });
    // Optional: Check response status to handle invalid tokens (e.g., user uninstalled app)
    console.log(`📲 Notification sent to ${expoPushToken}`);
  } catch (error) {
    console.error("❌ Error sending notification:", error);
  }
}; */

const sendPushNotification = async (targetToken, message) => {
  if (!Expo.isExpoPushToken(targetToken)) {
    console.error(`Push token ${targetToken} is not a valid Expo push token`);
    return;
  }

  const chunks = expo.chunkPushNotifications([
    {
      to: targetToken,
      sound: 'default',
      title: 'Visitor Alert! 🔔',
      body: message,
      data: { withSome: 'data' },
    }
  ]);

  for (let chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      console.log('✅ Notification Sent:', ticketChunk);
    } catch (error) {
      console.error('❌ Error sending notification:', error);
    }
  }
};

// Call this when a visitor is added
// sendPushNotification(user.pushToken, "Your delivery is here!");
// ---------------------------------------------------------
// 4. MAIN ROUTES (Visitor & Notifications)
// ---------------------------------------------------------

// POST: Create Visitor & Notify Resident
app.post('/visitor-request', async (req, res) => {
  console.log("🔔 New Visitor Request:", req.body.name);
  try {
    const { name, flatNumber, purpose, mobile } = req.body;

    // A. Save Visitor
    const newVisitor = new Visitor(req.body);
    await newVisitor.save();

    // B. Find All Residents in that Flat
    const residents = await User.find({ flatNumber: flatNumber, role: 'resident' });

    if (residents.length > 0) {
      // C. Notify them
      residents.forEach(resident => {
        if (resident.pushToken) {
            const msg = `New Visitor: ${newVisitor.name} is waiting to visit you (${flatNumber}).`;
            console.log(msg)
            // 3. Send Notification
             sendPushNotification(resident.pushToken, msg);
        }
      });
      res.status(201).json({ message: "Visitor Logged & Residents Notified", data: newVisitor });
    } else {
      res.status(201).json({ message: "Visitor Logged (No Resident Found)", data: newVisitor });
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ error });
  }
});

// PUT: Update Visitor Destination (Flat/Office)
// PUT: Update Visitor Target & Notify New Resident
app.put('/update-visitor-target', async (req, res) => {
  const { id, flatNumber, purpose } = req.body;
  
  console.log("📝 Update Request - Purpose:", purpose);

  if (!id || !flatNumber) {
    return res.status(400).json({ message: "Missing visitor ID or new target" });
  }

  try {
    // 1. Update Visitor in Database
    const updatedVisitor = await Visitor.findByIdAndUpdate(
      id,
      { flatNumber: flatNumber, purpose: purpose }, 
      { new: true } 
    );

    if (!updatedVisitor) {
      return res.status(404).json({ message: "Visitor not found" });
    }

    console.log(`✅ Updated visitor ${updatedVisitor.name} to visit ${flatNumber}`);

    // --- 👇 NEW: NOTIFICATION LOGIC ---
    try {
        // 2. Find the Resident linked to the NEW flatNumber
        const resident = await User.findOne({ flatNumber: flatNumber });

        if (resident && resident.pushToken) {
            const msg = `New Visitor ${updatedVisitor.name} is waiting to Visit you (${flatNumber}).`;
            
            // 3. Send Notification
            await sendPushNotification(resident.pushToken, msg);
        } else {
            console.log(`⚠️ No resident found for ${flatNumber} or no token available.`);
        }
    } catch (notifyError) {
        console.error("❌ Notification failed (but update succeeded):", notifyError);
        // We do NOT stop the response here; the update was successful.
    }
    // ----------------------------------

    // 4. Send Success Response
    res.json({ 
      success: true, 
      message: "Destination updated & Notification sent", 
      data: updatedVisitor 
    });

  } catch (error) {
    console.error("❌ Update Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
});

// POST: Save Push Token (Called when app opens)
// POST: Save Push Token
app.post('/update-token', async (req, res) => {
  const { userId, token } = req.body; // 👈 Accept userId instead of phone
  try {
    // 👈 Find by _id instead of phone
    await User.findByIdAndUpdate(userId, { pushToken: token }); 
    res.json({ message: "Token updated" });
  } catch (error) {
    res.status(500).json({ error });
  }
});

// POST: Admin Announcement
app.post('/admin/announce', async (req, res) => {
  try {
    const { title, message, target } = req.body;
    
    // Save
    const newAnnouncement = new Announcement({ title, message, target });
    await newAnnouncement.save();

    // Find Users
    let filter = {};
    if (target === 'resident') filter = { role: 'resident' };
    if (target === 'guard') filter = { role: 'guard' };

    const usersToNotify = await User.find(filter);

    // Blast Notifications
    usersToNotify.forEach(user => {
      if (user.pushToken) {
        sendPushNotification(user.pushToken, `📢 ${title}`, message);
      }
    });

    res.json({ message: "Announcement Sent!", count: usersToNotify.length });
  } catch (error) {
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

// ---------------------------------------------------------
// 5. STANDARD ROUTES (Login, Get Data, etc.)
// ---------------------------------------------------------

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
          _id: user._id,
          mobile:user.phone
        } 
      });
    } else {
      res.status(401).json({ message: "Invalid Phone or Password" });
    }
  } catch (error) {
    res.status(500).json({ message: "Server Error", error });
  }
});

app.get('/all-visitors', async (req, res) => {
  try {
    const visitors = await Visitor.find().sort({ entryTime: -1 });
    res.json(visitors);
  } catch (error) {
    res.status(500).json({ error });
  }
});

app.put('/visitor-response', async (req, res) => {
  try {
    const { id, status } = req.body;
    let updateData = { status };
    if (status === 'Approved' || status === 'Rejected') {
      updateData.approvalTime = new Date(); 
    }
    const updatedVisitor = await Visitor.findByIdAndUpdate(id, updateData, { new: true });
    res.json({ message: "Status Updated", data: updatedVisitor });
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

// server.js

// 👇 NEW: Logout endpoint to clear push token
app.post('/logout', async (req, res) => {
  const { userId } = req.body; 

  try {
    // Find user and remove their pushToken (Set it to null or empty string)
    await User.findByIdAndUpdate(userId, { pushToken: null });
    
    res.status(200).json({ message: 'Logged out and token cleared' });
  } catch (error) {
    console.log("Logout error:", error);
    res.status(500).json({ message: 'Error clearing token' });
  }
});
// server.js

// 👇 NEW: Update Push Token Endpoint
// PUT: Update Push Token (Handles Logout too)
app.put('/update-push-token', async (req, res) => {
  const { userId, pushToken } = req.body;

  // 1. Validation: Only userId is strictly required
  if (!userId) {
    return res.status(400).json({ message: 'Missing userId' });
  }

  try {
    // 2. Update the User
    // If pushToken is null, it clears the field in MongoDB
    const updatedUser = await User.findByIdAndUpdate(
      userId, 
      { pushToken: pushToken },
      { new: true } 
    );

    if (!updatedUser) {
        return res.status(404).json({ message: 'User not found' });
    }

    console.log(`✅ Token updated for ${updatedUser.name}: ${pushToken}`);
    res.status(200).json({ message: 'Token updated' });

  } catch (error) {
    console.error("❌ Token update error:", error);
    res.status(500).json({ message: 'Error updating token' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Production Server started on port ${PORT}`);
});
















