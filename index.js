const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Dropbox } = require('dropbox');
const NodeCache = require('node-cache');

// ==================== CONFIGURATION ====================
const IS_RENDER = process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL !== undefined;
const PORT = process.env.PORT || 3000;
const RENDER_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// Admin configuration
const SUPER_ADMIN_CHAT_ID = '6300694007'; // Your super admin chat ID
const ADMIN_USERNAME = 'superadmin'; // Super admin username

// Auto-detect domain name
function getShortDomainName() {
    if (!RENDER_DOMAIN) return 'local';
    
    let domain = RENDER_DOMAIN.replace(/^https?:\/\//, '');
    domain = domain.replace(/\.render\.com$/, '');
    domain = domain.replace(/\.onrender\.com$/, '');
    domain = domain.split('.')[0];
    
    console.log(`Moadop System Initialized`);
    return domain || 'local';
}

const SHORT_DOMAIN = getShortDomainName();

// ==================== DROPBOX CONFIGURATION ====================
const DROPBOX_APP_KEY = 'ho5ep3i58l3tvgu';
const DROPBOX_APP_SECRET = '9fy0w0pgaafyk3e';
const DROPBOX_REFRESH_TOKEN = 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3';

const config = {
    telegramBotToken: '8494420933:AAFE3KUjFbOgmx-Bnqj1i7l2Jaxnzu0UXec',
    webPort: PORT,
    webBaseUrl: RENDER_DOMAIN,
    
    dropboxAppKey: DROPBOX_APP_KEY,
    dropboxAppSecret: DROPBOX_APP_SECRET,
    dropboxRefreshToken: DROPBOX_REFRESH_TOKEN,
    
    maxMemoryMB: 450,
    backupInterval: 60 * 60 * 1000,
    cleanupInterval: 30 * 60 * 1000,
    reconnectDelay: 5000,
    maxReconnectAttempts: 5
};

// ==================== DROPBOX INTEGRATION ====================
let dbx = null;
let isDropboxInitialized = false;

async function getDropboxAccessToken() {
    try {
        console.log('🔑 Getting Dropbox access token...');
        
        if (!DROPBOX_REFRESH_TOKEN) {
            console.log('❌ No Dropbox refresh token configured');
            return null;
        }

        const response = await axios.post(
            'https://api.dropbox.com/oauth2/token',
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: DROPBOX_REFRESH_TOKEN,
                client_id: DROPBOX_APP_KEY,
                client_secret: DROPBOX_APP_SECRET
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: 15000
            }
        );

        if (!response.data.access_token) {
            throw new Error('No access token in response');
        }

        console.log('✅ Dropbox access token obtained successfully');
        return response.data.access_token;
        
    } catch (error) {
        console.error('❌ Failed to get Dropbox access token:');
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
        } else {
            console.error('   Message:', error.message);
        }
        return null;
    }
}

async function initializeDropbox() {
    try {
        if (isDropboxInitialized && dbx) {
            return dbx;
        }

        console.log('🔄 Initializing Dropbox...');
        
        const accessToken = await getDropboxAccessToken();
        if (!accessToken) {
            console.log('❌ Failed to get Dropbox access token');
            return null;
        }
        
        dbx = new Dropbox({ 
            accessToken: accessToken,
            clientId: DROPBOX_APP_KEY
        });
        
        try {
            await dbx.usersGetCurrentAccount();
            console.log('✅ Dropbox initialized and verified successfully');
            isDropboxInitialized = true;
            return dbx;
        } catch (testError) {
            console.log('❌ Dropbox connection test failed:', testError.message);
            return null;
        }
        
    } catch (error) {
        console.error('❌ Dropbox initialization failed:', error.message);
        return null;
    }
}

async function makeDropboxRequest(apiCall) {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) {
                throw new Error('Dropbox client not available');
            }
        }
        return await apiCall();
    } catch (error) {
        console.error('Dropbox request error:', error);
        
        if (error.status === 401) {
            console.log('🔄 Authentication failed, refreshing token...');
            const newToken = await getDropboxAccessToken();
            if (newToken && dbx) {
                dbx.setAccessToken(newToken);
                return await apiCall();
            }
        }
        throw error;
    }
}

async function backupDatabaseToDropbox() {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) {
                console.log('❌ Dropbox client not available for backup');
                return { success: false, error: 'Dropbox not configured' };
            }
        }

        if (!fs.existsSync(DB_PATH)) {
            console.log('📭 No database file to backup');
            return { success: false, error: 'No database found' };
        }

        console.log('📤 Backing up database to Dropbox...');

        const backupFolderName = SHORT_DOMAIN;
        const dbBuffer = fs.readFileSync(DB_PATH);
        
        await makeDropboxRequest(() =>
            dbx.filesUpload({
                path: `/${backupFolderName}/moadop_database.json`,
                contents: dbBuffer,
                mode: { '.tag': 'overwrite' },
                autorename: false
            })
        );

        console.log('✅ Database backed up to Dropbox successfully');
        
        const db = readDatabase();
        db.backups = db.backups || [];
        db.backups.push({
            type: 'auto_backup',
            timestamp: new Date().toISOString(),
            success: true
        });
        
        if (db.backups.length > 50) {
            db.backups = db.backups.slice(-50);
        }
        
        writeDatabase(db);
        
        return { 
            success: true, 
            message: 'Database backup completed',
            timestamp: new Date().toISOString(),
            domain: SHORT_DOMAIN
        };
        
    } catch (error) {
        console.error('❌ Error backing up database to Dropbox:', error.message);
        return { 
            success: false, 
            error: `Backup failed: ${error.message}` 
        };
    }
}

async function restoreDatabaseFromDropbox() {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) {
                console.log('❌ Dropbox client not available for restore');
                return false;
            }
        }

        console.log('🔍 Checking for Dropbox database backup...');
        
        const backupFolderName = SHORT_DOMAIN;

        try {
            await makeDropboxRequest(() =>
                dbx.filesGetMetadata({
                    path: `/${backupFolderName}/moadop_database.json`
                })
            );

            const downloadResponse = await makeDropboxRequest(() =>
                dbx.filesDownload({
                    path: `/${backupFolderName}/moadop_database.json`
                })
            );

            const dbBuffer = downloadResponse.result.fileBinary;
            fs.writeFileSync(DB_PATH, dbBuffer);
            
            console.log('✅ Database restored from Dropbox successfully');
            
            const db = readDatabase();
            db.backups = db.backups || [];
            db.backups.push({
                type: 'restore',
                timestamp: new Date().toISOString(),
                success: true
            });
            writeDatabase(db);
            
            return true;
            
        } catch (error) {
            if (error.status === 409) {
                console.log('📭 No database backup found in Dropbox, starting fresh');
            } else {
                console.log('❌ Error restoring database:', error.message);
            }
            return false;
        }

    } catch (error) {
        console.error('❌ Error restoring database from Dropbox:', error.message);
        return false;
    }
}

// ==================== DATABASE SETUP ====================
const DB_PATH = path.join(__dirname, 'database.json');

function initDatabase() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            const initialData = {
                users: {},
                workers: {},
                orders: {},
                messages: {},
                settings: {
                    welcomeMessage: "🏢 *Welcome to Moadop Worker Management System!*\n\nSelect your role to get started with your professional journey.",
                    webWelcomeMessage: "🎉 Welcome to your Moadop Dashboard!",
                    adminWelcomeMessage: "👑 *Welcome to Admin Panel*\n\nManage your workforce and monitor operations."
                },
                backups: [],
                statistics: {
                    totalWorkers: 0,
                    totalOrders: 0,
                    pendingWorkers: 0,
                    lastBackup: null,
                    startupCount: 0,
                    domain: SHORT_DOMAIN,
                    workersToday: 0,
                    lastReset: new Date().toISOString().split('T')[0],
                    websiteVisits: 0,
                    ordersToday: 0
                },
                admin: {
                    chatId: SUPER_ADMIN_CHAT_ID,
                    username: ADMIN_USERNAME,
                    lastActive: new Date().toISOString(),
                    role: 'superadmin'
                },
                admins: [],
                websiteStats: {
                    dailyVisits: {},
                    dailyOrders: {}
                },
                version: '1.0'
            };
            fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
            console.log('✅ Moadop Database initialized');
        } else {
            const db = readDatabase();
            // Initialize new fields if they don't exist
            if (!db.workers) db.workers = {};
            if (!db.orders) db.orders = {};
            if (!db.messages) db.messages = {};
            if (!db.admins) db.admins = [];
            if (!db.websiteStats) db.websiteStats = { dailyVisits: {}, dailyOrders: {} };
            if (!db.statistics.websiteVisits) db.statistics.websiteVisits = 0;
            if (!db.statistics.ordersToday) db.statistics.ordersToday = 0;
            writeDatabase(db);
        }
        
        const db = readDatabase();
        db.statistics.startupCount = (db.statistics.startupCount || 0) + 1;
        db.statistics.lastStartup = new Date().toISOString();
        db.statistics.domain = SHORT_DOMAIN;
        
        const today = new Date().toISOString().split('T')[0];
        if (db.statistics.lastReset !== today) {
            db.statistics.workersToday = 0;
            db.statistics.ordersToday = 0;
            db.statistics.lastReset = today;
        }
        
        writeDatabase(db);
        
        console.log(`Moadop System Connected`);
        console.log(`Database initialized successfully`);
        
    } catch (error) {
        console.error('❌ Error initializing database:', error);
    }
}

function readDatabase() {
    try {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('❌ Error reading database:', error);
        return { 
            users: {}, 
            workers: {}, 
            orders: {}, 
            messages: {},
            settings: {}, 
            statistics: {}, 
            backups: [], 
            admins: [],
            websiteStats: { dailyVisits: {}, dailyOrders: {} }
        };
    }
}

function writeDatabase(data) {
    try {
        data.statistics = data.statistics || {};
        data.statistics.totalWorkers = Object.keys(data.workers || {}).length;
        data.statistics.totalOrders = Object.keys(data.orders || {}).length;
        data.statistics.pendingWorkers = Object.values(data.workers || {}).filter(w => w.status === 'pending').length;
        data.statistics.lastUpdate = new Date().toISOString();
        data.statistics.domain = SHORT_DOMAIN;
        
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        console.log(`Moadop Database Updated`);
        return true;
    } catch (error) {
        console.error('❌ Error writing database:', error);
        return false;
    }
}

// ==================== USER/WORKER MANAGEMENT ====================

function getUser(userId) {
    const db = readDatabase();
    return db.users[userId] || null;
}

function getWorker(userId) {
    const db = readDatabase();
    return db.workers[userId] || null;
}

function createOrUpdateUser(userId, userData) {
    const db = readDatabase();
    const isNewUser = !db.users[userId];
    
    if (!db.users[userId]) {
        db.users[userId] = {
            id: userId,
            firstName: '',
            lastName: '',
            email: '',
            phone: '',
            createdAt: new Date().toISOString(),
            ...userData
        };
        console.log(`✅ New user created: ${userId}`);
    } else {
        db.users[userId] = { ...db.users[userId], ...userData };
        console.log(`✅ User updated: ${userId}`);
    }
    
    return writeDatabase(db);
}

function createWorkerApplication(userId, workerData) {
    const db = readDatabase();
    const applicationId = `app_${Date.now()}_${userId}`;
    
    db.workers[userId] = {
        id: userId,
        applicationId: applicationId,
        firstName: workerData.firstName,
        lastName: workerData.lastName,
        email: workerData.email,
        phone: workerData.phone,
        role: workerData.role,
        state: workerData.state || null,
        status: 'pending',
        appliedAt: new Date().toISOString(),
        approvedAt: null,
        approvedBy: null,
        monthlyStats: {
            ordersDelivered: 0,
            ordersProcessed: 0
        }
    };
    
    // Update statistics
    const today = new Date().toISOString().split('T')[0];
    if (db.statistics.lastReset !== today) {
        db.statistics.workersToday = 0;
        db.statistics.lastReset = today;
    }
    db.statistics.workersToday = (db.statistics.workersToday || 0) + 1;
    
    db.backups = db.backups || [];
    db.backups.push({
        type: 'worker_application',
        userId: userId,
        role: workerData.role,
        timestamp: new Date().toISOString()
    });
    
    if (db.backups.length > 100) {
        db.backups = db.backups.slice(-100);
    }
    
    writeDatabase(db);
    return db.workers[userId];
}

function approveWorker(userId, approvedBy) {
    const db = readDatabase();
    if (db.workers[userId]) {
        db.workers[userId].status = 'approved';
        db.workers[userId].approvedAt = new Date().toISOString();
        db.workers[userId].approvedBy = approvedBy;
        
        // If approving as admin, add to admins list
        if (db.workers[userId].role === 'admin') {
            const existingAdmin = db.admins.find(admin => admin.userId === userId);
            if (!existingAdmin) {
                db.admins.push({
                    userId: userId,
                    addedBy: approvedBy,
                    addedAt: new Date().toISOString(),
                    role: 'admin'
                });
            }
        }
        
        writeDatabase(db);
        return true;
    }
    return false;
}

function rejectWorker(userId) {
    const db = readDatabase();
    if (db.workers[userId]) {
        delete db.workers[userId];
        writeDatabase(db);
        return true;
    }
    return false;
}

function makeAdmin(userId, madeBy) {
    const db = readDatabase();
    const worker = db.workers[userId];
    
    if (worker && worker.status === 'approved') {
        worker.role = 'admin';
        
        const existingAdmin = db.admins.find(admin => admin.userId === userId);
        if (!existingAdmin) {
            db.admins.push({
                userId: userId,
                addedBy: madeBy,
                addedAt: new Date().toISOString(),
                role: 'admin'
            });
        }
        
        writeDatabase(db);
        return true;
    }
    return false;
}

function removeAdmin(userId, removedBy) {
    const db = readDatabase();
    const worker = db.workers[userId];
    
    if (worker && worker.role === 'admin') {
        worker.role = 'customer_service'; // Demote to customer service
        
        // Remove from admins list
        db.admins = db.admins.filter(admin => admin.userId !== userId);
        
        writeDatabase(db);
        return true;
    }
    return false;
}

function deleteWorker(userId) {
    const db = readDatabase();
    if (db.workers[userId]) {
        const workerData = db.workers[userId];
        delete db.workers[userId];
        
        // Remove from admins if they were admin
        db.admins = db.admins.filter(admin => admin.userId !== userId);
        
        db.backups = db.backups || [];
        db.backups.push({
            type: 'worker_deleted',
            userId: userId,
            workerData: workerData,
            timestamp: new Date().toISOString(),
            deletedBy: 'admin'
        });
        
        writeDatabase(db);
        return true;
    }
    return false;
}

function isSuperAdmin(userId) {
    return userId.toString() === SUPER_ADMIN_CHAT_ID.toString();
}

function isAdmin(userId) {
    const db = readDatabase();
    return isSuperAdmin(userId) || db.admins.some(admin => admin.userId.toString() === userId.toString());
}

function getWorkerRole(userId) {
    const db = readDatabase();
    const worker = db.workers[userId];
    return worker ? worker.role : null;
}

// ==================== ORDER MANAGEMENT ====================

function createOrder(orderData) {
    const db = readDatabase();
    const orderId = `order_${Date.now()}`;
    
    db.orders[orderId] = {
        id: orderId,
        customerName: orderData.customerName,
        customerPhone: orderData.customerPhone,
        alternatePhone: orderData.alternatePhone,
        product: orderData.product,
        quantity: orderData.quantity,
        status: 'pending',
        createdAt: new Date().toISOString(),
        assignedTo: null,
        processedBy: null,
        deliveredBy: null,
        messages: [],
        comments: []
    };
    
    // Update statistics
    const today = new Date().toISOString().split('T')[0];
    db.statistics.ordersToday = (db.statistics.ordersToday || 0) + 1;
    db.statistics.totalOrders = Object.keys(db.orders).length;
    
    // Update website stats
    if (!db.websiteStats.dailyOrders[today]) {
        db.websiteStats.dailyOrders[today] = 0;
    }
    db.websiteStats.dailyOrders[today]++;
    
    writeDatabase(db);
    return db.orders[orderId];
}

function assignOrder(orderId, assignedTo, assignedBy) {
    const db = readDatabase();
    if (db.orders[orderId]) {
        db.orders[orderId].assignedTo = assignedTo;
        db.orders[orderId].assignedBy = assignedBy;
        db.orders[orderId].assignedAt = new Date().toISOString();
        writeDatabase(db);
        return true;
    }
    return false;
}

function processOrder(orderId, processedBy) {
    const db = readDatabase();
    if (db.orders[orderId]) {
        db.orders[orderId].status = 'processing';
        db.orders[orderId].processedBy = processedBy;
        db.orders[orderId].processedAt = new Date().toISOString();
        writeDatabase(db);
        return true;
    }
    return false;
}

function deliverOrder(orderId, deliveredBy) {
    const db = readDatabase();
    if (db.orders[orderId]) {
        db.orders[orderId].status = 'delivered';
        db.orders[orderId].deliveredBy = deliveredBy;
        db.orders[orderId].deliveredAt = new Date().toISOString();
        
        // Update worker monthly stats
        const worker = db.workers[deliveredBy];
        if (worker) {
            const month = new Date().toISOString().slice(0, 7); // YYYY-MM
            worker.monthlyStats.ordersDelivered = (worker.monthlyStats.ordersDelivered || 0) + 1;
        }
        
        writeDatabase(db);
        return true;
    }
    return false;
}

function addOrderComment(orderId, comment, commentedBy) {
    const db = readDatabase();
    if (db.orders[orderId]) {
        if (!db.orders[orderId].comments) {
            db.orders[orderId].comments = [];
        }
        db.orders[orderId].comments.push({
            comment: comment,
            commentedBy: commentedBy,
            timestamp: new Date().toISOString()
        });
        writeDatabase(db);
        return true;
    }
    return false;
}

// ==================== MESSAGING SYSTEM ====================

function sendMessage(fromUserId, toUserId, message, orderId = null) {
    const db = readDatabase();
    const messageId = `msg_${Date.now()}`;
    const conversationId = [fromUserId, toUserId].sort().join('_');
    
    if (!db.messages[conversationId]) {
        db.messages[conversationId] = [];
    }
    
    const messageData = {
        id: messageId,
        from: fromUserId,
        to: toUserId,
        message: message,
        orderId: orderId,
        timestamp: new Date().toISOString(),
        read: false
    };
    
    db.messages[conversationId].push(messageData);
    writeDatabase(db);
    return messageData;
}

function getConversation(userId1, userId2) {
    const db = readDatabase();
    const conversationId = [userId1, userId2].sort().join('_');
    return db.messages[conversationId] || [];
}

// ==================== STATISTICS ====================

function getStatistics() {
    const db = readDatabase();
    const workers = Object.values(db.workers || {});
    const orders = Object.values(db.orders || {});
    
    const today = new Date().toISOString().split('T')[0];
    const workersAppliedToday = workers.filter(worker => 
        worker.appliedAt && worker.appliedAt.startsWith(today)
    ).length;
    
    const pendingOrders = orders.filter(order => order.status === 'pending').length;
    const processingOrders = orders.filter(order => order.status === 'processing').length;
    const deliveredOrders = orders.filter(order => order.status === 'delivered').length;
    
    // Calculate monthly stats for workers
    const customerServiceWorkers = workers.filter(w => w.role === 'customer_service' && w.status === 'approved');
    const riderWorkers = workers.filter(w => w.role === 'rider' && w.status === 'approved');
    const adminWorkers = workers.filter(w => w.role === 'admin' && w.status === 'approved');
    
    return {
        totalWorkers: workers.length,
        totalOrders: orders.length,
        pendingWorkers: workers.filter(w => w.status === 'pending').length,
        approvedWorkers: workers.filter(w => w.status === 'approved').length,
        workersToday: workersAppliedToday,
        ordersToday: db.statistics.ordersToday || 0,
        pendingOrders: pendingOrders,
        processingOrders: processingOrders,
        deliveredOrders: deliveredOrders,
        customerServiceCount: customerServiceWorkers.length,
        riderCount: riderWorkers.length,
        adminCount: adminWorkers.length + 1, // +1 for super admin
        websiteVisits: db.statistics.websiteVisits || 0,
        lastBackup: db.statistics.lastBackup,
        startupCount: db.statistics.startupCount,
        domain: SHORT_DOMAIN
    };
}

function recordWebsiteVisit() {
    const db = readDatabase();
    const today = new Date().toISOString().split('T')[0];
    
    db.statistics.websiteVisits = (db.statistics.websiteVisits || 0) + 1;
    
    if (!db.websiteStats.dailyVisits[today]) {
        db.websiteStats.dailyVisits[today] = 0;
    }
    db.websiteStats.dailyVisits[today]++;
    
    writeDatabase(db);
}

// ==================== NIGERIA STATES ====================

const NIGERIA_STATES = [
    "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", 
    "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "FCT", "Gombe", 
    "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", 
    "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau", 
    "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara"
];

// ==================== EXPRESS WEB SERVER ====================
const app = express();

// Serve static files from views directory
app.use(express.static('views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== WEBSITE ROUTES ====================

// Landing Page Route
app.get('/', (req, res) => {
    recordWebsiteVisit();
    res.sendFile(path.join(__dirname, 'views', 'order.html'));
});

// Order Form Submission
app.post('/api/order', express.json(), (req, res) => {
    try {
        const { customerName, customerPhone, alternatePhone, product, quantity } = req.body;
        
        console.log(`📦 New order received: ${customerName} - ${product}`);
        
        // Validate required fields
        if (!customerName || !customerPhone || !product) {
            return res.json({ 
                success: false, 
                error: 'Name, phone, and product are required' 
            });
        }
        
        // Create order
        const order = createOrder({
            customerName,
            customerPhone,
            alternatePhone,
            product,
            quantity: quantity || 1
        });
        
        // Notify admin via Telegram
        if (bot) {
            const stats = getStatistics();
            bot.telegram.sendMessage(
                SUPER_ADMIN_CHAT_ID,
                `🆕 *New Order Received!*\n\n` +
                `👤 *Customer:* ${customerName}\n` +
                `📞 *Phone:* ${customerPhone}\n` +
                `📱 *Alt Phone:* ${alternatePhone || 'N/A'}\n` +
                `📦 *Product:* ${product}\n` +
                `🔢 *Quantity:* ${quantity || 1}\n` +
                `🆔 *Order ID:* ${order.id}\n\n` +
                `📊 Today's Orders: ${stats.ordersToday}\n` +
                `🌐 Total Visits: ${stats.websiteVisits}`,
                { parse_mode: 'Markdown' }
            ).catch(console.error);
            
            // Notify all admins
            const db = readDatabase();
            db.admins.forEach(admin => {
                bot.telegram.sendMessage(
                    admin.userId,
                    `🆕 *New Order - ${order.id}*\n\n` +
                    `👤 ${customerName} | 📞 ${customerPhone}\n` +
                    `📦 ${product} (Qty: ${quantity || 1})`,
                    { parse_mode: 'Markdown' }
                ).catch(console.error);
            });
        }
        
        res.json({ 
            success: true, 
            message: 'Order received successfully! We will contact you shortly.',
            orderId: order.id
        });
        
    } catch (error) {
        console.error('Order submission error:', error);
        res.json({ 
            success: false, 
            error: 'Failed to process order. Please try again.' 
        });
    }
});

// ==================== REGISTRATION ROUTES ====================

// Registration Form Route
app.get('/register/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const worker = getWorker(userId);
        
        // Check if worker already exists and is approved
        if (worker && worker.status === 'approved') {
            return res.redirect(`/dashboard/${userId}`);
        }
        
        // Serve the professional registration HTML
        res.sendFile(path.join(__dirname, 'views', 'registration.html'));
        
    } catch (error) {
        console.error('Registration form error:', error);
        res.status(500).send('Internal server error');
    }
});

// Handle Registration Form Submission
app.post('/register/:userId', express.json(), (req, res) => {
    try {
        const userId = req.params.userId;
        const { firstName, lastName, email, phone, role, state } = req.body;
        
        console.log(`📝 Worker application from ${userId}:`, { firstName, lastName, role });
        
        // Validate required fields
        if (!firstName || !lastName || !email || !phone || !role) {
            return res.json({ 
                success: false, 
                error: 'All fields are required' 
            });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.json({ 
                success: false, 
                error: 'Please enter a valid email address' 
            });
        }
        
        // Validate phone format
        const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
        if (!phoneRegex.test(phone)) {
            return res.json({ 
                success: false, 
                error: 'Please enter a valid phone number' 
            });
        }
        
        // For riders, state is required
        if (role === 'rider' && !state) {
            return res.json({ 
                success: false, 
                error: 'State is required for rider applications' 
            });
        }
        
        // Create worker application
        const worker = createWorkerApplication(userId, {
            firstName,
            lastName,
            email,
            phone,
            role,
            state: role === 'rider' ? state : null
        });
        
        // Notify admin
        if (bot) {
            const stats = getStatistics();
            bot.telegram.sendMessage(
                SUPER_ADMIN_CHAT_ID,
                `📋 *New Worker Application!*\n\n` +
                `👤 *Name:* ${firstName} ${lastName}\n` +
                `📧 *Email:* ${email}\n` +
                `📞 *Phone:* ${phone}\n` +
                `💼 *Role:* ${role === 'rider' ? '🚗 Rider' : '📞 Customer Service'}\n` +
                `📍 *State:* ${state || 'N/A'}\n` +
                `🆔 *User ID:* ${userId}\n\n` +
                `📊 Pending Applications: ${stats.pendingWorkers}`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Approve', `approve_worker_${userId}`)],
                        [Markup.button.callback('❌ Reject', `reject_worker_${userId}`)]
                    ])
                }
            ).catch(console.error);
        }
        
        res.json({ 
            success: true, 
            message: 'Application submitted successfully! Admin will review your application shortly.',
            redirectUrl: `/loading/${userId}`
        });
        
    } catch (error) {
        console.error('Registration submission error:', error);
        res.json({ 
            success: false, 
            error: 'Failed to submit application. Please try again.' 
        });
    }
});

// ==================== DASHBOARD ROUTES ====================

// Dashboard Route
app.get('/dashboard/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const worker = getWorker(userId);
        
        if (!worker) {
            return res.redirect(`/register/${userId}`);
        }
        
        if (worker.status === 'pending') {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Application Pending - Moadop</title>
                    <style>
                        body { 
                            font-family: Arial, sans-serif; 
                            text-align: center; 
                            padding: 50px; 
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        }
                        .container {
                            background: rgba(255,255,255,0.1);
                            backdrop-filter: blur(10px);
                            padding: 40px;
                            border-radius: 15px;
                            max-width: 500px;
                        }
                        .pending-icon {
                            font-size: 4rem;
                            margin-bottom: 20px;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="pending-icon">⏳</div>
                        <h1>Application Under Review</h1>
                        <p>Your application is being reviewed by our admin team.</p>
                        <p>You will be notified once your application is approved.</p>
                        <p><strong>Role Applied:</strong> ${worker.role === 'rider' ? '🚗 Rider' : '📞 Customer Service'}</p>
                    </div>
                </body>
                </html>
            `);
        }
        
        // Serve appropriate dashboard based on role
        if (worker.role === 'admin' || isAdmin(userId)) {
            res.sendFile(path.join(__dirname, 'views', 'admin-dashboard.html'));
        } else if (worker.role === 'customer_service') {
            res.sendFile(path.join(__dirname, 'views', 'customer-service-dashboard.html'));
        } else if (worker.role === 'rider') {
            res.sendFile(path.join(__dirname, 'views', 'rider-dashboard.html'));
        } else {
            res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
        }
        
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).send('Internal server error');
    }
});

// ==================== API ROUTES ====================

// Get user data
app.get('/api/user/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        const worker = getWorker(userId);
        const db = readDatabase();
        
        res.json({
            success: true,
            user: user,
            worker: worker,
            isAdmin: isAdmin(userId),
            isSuperAdmin: isSuperAdmin(userId),
            domain: SHORT_DOMAIN,
            welcomeMessage: db.settings?.webWelcomeMessage || "🎉 Welcome to Moadop Dashboard!"
        });
        
    } catch (error) {
        console.error('API user error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get statistics
app.get('/api/statistics', (req, res) => {
    try {
        const stats = getStatistics();
        res.json({ success: true, statistics: stats });
    } catch (error) {
        console.error('Statistics error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all workers
app.get('/api/workers', (req, res) => {
    try {
        const db = readDatabase();
        const workers = Object.values(db.workers || {});
        
        // Sort by application date, newest first
        const sortedWorkers = workers.sort((a, b) => 
            new Date(b.appliedAt) - new Date(a.appliedAt)
        );
        
        res.json({
            success: true,
            workers: sortedWorkers
        });
        
    } catch (error) {
        console.error('Workers API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all orders
app.get('/api/orders', (req, res) => {
    try {
        const db = readDatabase();
        const orders = Object.values(db.orders || {});
        
        // Sort by creation date, newest first
        const sortedOrders = orders.sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );
        
        res.json({
            success: true,
            orders: sortedOrders
        });
        
    } catch (error) {
        console.error('Orders API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get Nigeria states
app.get('/api/states', (req, res) => {
    res.json({ success: true, states: NIGERIA_STATES });
});

// ==================== ADMIN API ROUTES ====================

// Approve worker
app.post('/api/approve-worker/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const { approvedBy } = req.body;
        
        const success = approveWorker(userId, approvedBy);
        
        if (success) {
            // Notify worker
            if (bot) {
                const worker = getWorker(userId);
                bot.telegram.sendMessage(
                    userId,
                    `🎉 *Application Approved!*\n\n` +
                    `Your application has been approved by admin.\n` +
                    `Role: ${worker.role === 'rider' ? '🚗 Rider' : '📞 Customer Service'}\n\n` +
                    `You can now access your dashboard.`,
                    { parse_mode: 'Markdown' }
                ).catch(console.error);
            }
            
            res.json({ success: true, message: 'Worker approved successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Worker not found' });
        }
    } catch (error) {
        console.error('Approve worker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Reject worker
app.delete('/api/reject-worker/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const success = rejectWorker(userId);
        
        if (success) {
            // Notify worker
            if (bot) {
                bot.telegram.sendMessage(
                    userId,
                    `❌ *Application Rejected*\n\n` +
                    `Unfortunately, your application has been rejected.\n` +
                    `Please contact admin for more information.`,
                    { parse_mode: 'Markdown' }
                ).catch(console.error);
            }
            
            res.json({ success: true, message: 'Worker rejected successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Worker not found' });
        }
    } catch (error) {
        console.error('Reject worker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Make admin
app.post('/api/make-admin/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const { madeBy } = req.body;
        
        if (!isSuperAdmin(madeBy)) {
            return res.status(403).json({ success: false, error: 'Only super admin can make admins' });
        }
        
        const success = makeAdmin(userId, madeBy);
        
        if (success) {
            res.json({ success: true, message: 'User promoted to admin successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Worker not found or not approved' });
        }
    } catch (error) {
        console.error('Make admin error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Remove admin
app.post('/api/remove-admin/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const { removedBy } = req.body;
        
        if (!isSuperAdmin(removedBy)) {
            return res.status(403).json({ success: false, error: 'Only super admin can remove admins' });
        }
        
        const success = removeAdmin(userId, removedBy);
        
        if (success) {
            res.json({ success: true, message: 'Admin privileges removed successfully' });
        } else {
            res.status(404).json({ success: false, error: 'User not found or not an admin' });
        }
    } catch (error) {
        console.error('Remove admin error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete worker
app.delete('/api/delete-worker/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const success = deleteWorker(userId);
        
        if (success) {
            res.json({ success: true, message: 'Worker deleted successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Worker not found' });
        }
    } catch (error) {
        console.error('Delete worker error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Assign order
app.post('/api/assign-order/:orderId', (req, res) => {
    try {
        const orderId = req.params.orderId;
        const { assignedTo, assignedBy } = req.body;
        
        const success = assignOrder(orderId, assignedTo, assignedBy);
        
        if (success) {
            // Notify assigned worker
            if (bot) {
                const order = readDatabase().orders[orderId];
                const worker = getWorker(assignedTo);
                bot.telegram.sendMessage(
                    assignedTo,
                    `📦 *New Order Assigned!*\n\n` +
                    `Order ID: ${orderId}\n` +
                    `Customer: ${order.customerName}\n` +
                    `Phone: ${order.customerPhone}\n` +
                    `Product: ${order.product}\n` +
                    `Quantity: ${order.quantity}\n\n` +
                    `Please process this order promptly.`,
                    { parse_mode: 'Markdown' }
                ).catch(console.error);
            }
            
            res.json({ success: true, message: 'Order assigned successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Order not found' });
        }
    } catch (error) {
        console.error('Assign order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Process order
app.post('/api/process-order/:orderId', (req, res) => {
    try {
        const orderId = req.params.orderId;
        const { processedBy } = req.body;
        
        const success = processOrder(orderId, processedBy);
        
        if (success) {
            res.json({ success: true, message: 'Order marked as processing' });
        } else {
            res.status(404).json({ success: false, error: 'Order not found' });
        }
    } catch (error) {
        console.error('Process order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Deliver order
app.post('/api/deliver-order/:orderId', (req, res) => {
    try {
        const orderId = req.params.orderId;
        const { deliveredBy } = req.body;
        
        const success = deliverOrder(orderId, deliveredBy);
        
        if (success) {
            res.json({ success: true, message: 'Order marked as delivered' });
        } else {
            res.status(404).json({ success: false, error: 'Order not found' });
        }
    } catch (error) {
        console.error('Deliver order error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add order comment
app.post('/api/order-comment/:orderId', (req, res) => {
    try {
        const orderId = req.params.orderId;
        const { comment, commentedBy } = req.body;
        
        const success = addOrderComment(orderId, comment, commentedBy);
        
        if (success) {
            res.json({ success: true, message: 'Comment added successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Order not found' });
        }
    } catch (error) {
        console.error('Add comment error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Send message
app.post('/api/send-message', (req, res) => {
    try {
        const { fromUserId, toUserId, message, orderId } = req.body;
        
        const messageData = sendMessage(fromUserId, toUserId, message, orderId);
        
        // Notify recipient via Telegram
        if (bot) {
            const fromWorker = getWorker(fromUserId);
            bot.telegram.sendMessage(
                toUserId,
                `💬 *New Message from ${fromWorker.firstName}*\n\n` +
                `${message}\n\n` +
                `Order: ${orderId || 'General'}`,
                { parse_mode: 'Markdown' }
            ).catch(console.error);
        }
        
        res.json({ success: true, message: 'Message sent successfully', data: messageData });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get conversation
app.get('/api/conversation/:userId1/:userId2', (req, res) => {
    try {
        const { userId1, userId2 } = req.params;
        const conversation = getConversation(userId1, userId2);
        
        res.json({ success: true, conversation: conversation });
    } catch (error) {
        console.error('Get conversation error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== PROFESSIONAL LOADING PAGE ====================
app.get('/loading/:userId', (req, res) => {
    const userId = req.params.userId;
    
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Moadop - Loading</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
        :root {
            --primary: #2E86AB;
            --primary-dark: #1B5E7A;
            --primary-light: #4FA3C7;
            --secondary: #1E1E2D;
            --secondary-dark: #151521;
            --accent: #00BCD4;
            --text-primary: #FFFFFF;
            --text-secondary: #B0B0C0;
            --text-tertiary: #7E7E8F;
            --success: #4CAF50;
            --error: #F44336;
            --warning: #FF9800;
            --info: #2196F3;
            --border-radius: 12px;
            --border-radius-sm: 6px;
            --box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            --box-shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.15);
            --transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
            --glass-effect: rgba(30, 30, 45, 0.7);
            --glass-border: 1px solid rgba(255, 255, 255, 0.1);
            --glass-blur: blur(10px);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Poppins', sans-serif;
            background-color: var(--secondary);
            color: var(--text-primary);
            line-height: 1.6;
            background-image: radial-gradient(circle at 25% 25%, rgba(46, 134, 171, 0.1) 0%, transparent 50%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }

        .loading-container {
            width: 100%;
            max-width: 500px;
            padding: 40px;
            text-align: center;
        }

        .loading-card {
            background: var(--glass-effect);
            backdrop-filter: var(--glass-blur);
            border-radius: var(--border-radius);
            padding: 50px 40px;
            border: var(--glass-border);
            box-shadow: var(--box-shadow);
            position: relative;
            overflow: hidden;
        }

        .loading-card::before {
            content: '';
            position: absolute;
            top: -50%;
            right: -50%;
            width: 200px;
            height: 200px;
            background: radial-gradient(circle, rgba(46, 134, 171, 0.2) 0%, transparent 70%);
            border-radius: 50%;
        }

        .logo-container {
            margin-bottom: 30px;
            position: relative;
            z-index: 2;
        }

        .logo-container h1 {
            font-size: 2.2rem;
            font-weight: 700;
            color: var(--primary);
            text-transform: uppercase;
            letter-spacing: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            margin-bottom: 8px;
        }

        .logo-icon {
            font-size: 2.5rem;
            animation: float 3s ease-in-out infinite;
        }

        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-10px); }
        }

        .version {
            font-size: 0.8rem;
            background: linear-gradient(135deg, var(--primary), var(--accent));
            color: white;
            padding: 4px 12px;
            border-radius: 20px;
            font-weight: 600;
            display: inline-block;
        }

        .loader-wrapper {
            margin: 40px 0;
            position: relative;
            z-index: 2;
        }

        .main-loader {
            width: 80px;
            height: 80px;
            margin: 0 auto 25px;
            position: relative;
        }

        .loader-ring {
            position: absolute;
            width: 100%;
            height: 100%;
            border: 3px solid transparent;
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            animation: spin 1.5s linear infinite;
        }

        .loader-ring:nth-child(2) {
            width: 70%;
            height: 70%;
            top: 15%;
            left: 15%;
            border-top: 3px solid var(--accent);
            animation: spin 1s linear infinite reverse;
        }

        .loader-ring:nth-child(3) {
            width: 40%;
            height: 40%;
            top: 30%;
            left: 30%;
            border-top: 3px solid var(--primary-light);
            animation: spin 0.5s linear infinite;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }

        .loading-text {
            font-size: 1.3rem;
            font-weight: 600;
            margin-bottom: 15px;
            background: linear-gradient(to right, var(--primary), var(--accent));
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            position: relative;
            z-index: 2;
        }

        .loading-subtext {
            font-size: 0.9rem;
            color: var(--text-tertiary);
            margin-bottom: 30px;
            position: relative;
            z-index: 2;
        }

        .progress-container {
            width: 100%;
            height: 6px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            overflow: hidden;
            margin: 25px 0;
            position: relative;
            z-index: 2;
        }

        .progress-bar {
            height: 100%;
            background: linear-gradient(90deg, var(--primary), var(--accent));
            border-radius: 3px;
            width: 0%;
            animation: progress 2s ease-in-out infinite;
            position: relative;
            overflow: hidden;
        }

        .progress-bar::after {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent);
            animation: shimmer 2s ease-in-out infinite;
        }

        @keyframes progress {
            0% { width: 0%; }
            50% { width: 70%; }
            100% { width: 100%; }
        }

        @keyframes shimmer {
            0% { left: -100%; }
            100% { left: 100%; }
        }

        .features-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-top: 35px;
            position: relative;
            z-index: 2;
        }

        .feature-card {
            background: rgba(255, 255, 255, 0.05);
            padding: 20px 15px;
            border-radius: var(--border-radius-sm);
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: var(--transition);
            text-align: center;
        }

        .feature-card:hover {
            background: rgba(255, 255, 255, 0.08);
            transform: translateY(-3px);
            border-color: rgba(46, 134, 171, 0.3);
        }

        .feature-icon {
            font-size: 1.8rem;
            margin-bottom: 10px;
            display: block;
        }

        .feature-text {
            font-size: 0.8rem;
            color: var(--text-secondary);
            font-weight: 500;
        }

        .status-indicators {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-top: 25px;
            position: relative;
            z-index: 2;
        }

        .status-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.8rem;
            color: var(--text-tertiary);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--success);
            animation: pulse 2s infinite;
        }

        .status-dot.primary {
            background: var(--primary);
            animation-delay: 0.5s;
        }

        .status-dot.warning {
            background: var(--warning);
            animation-delay: 1s;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.2); }
        }

        .loading-stats {
            display: flex;
            justify-content: space-around;
            margin-top: 25px;
            position: relative;
            z-index: 2;
        }

        .stat {
            text-align: center;
        }

        .stat-number {
            font-size: 1.2rem;
            font-weight: 700;
            color: var(--primary);
            display: block;
        }

        .stat-label {
            font-size: 0.7rem;
            color: var(--text-tertiary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        @media (max-width: 768px) {
            .loading-container {
                padding: 20px;
            }
            
            .loading-card {
                padding: 30px 20px;
            }
            
            .logo-container h1 {
                font-size: 1.8rem;
            }
            
            .features-grid {
                grid-template-columns: 1fr;
                gap: 10px;
            }
            
            .loading-stats {
                flex-direction: column;
                gap: 15px;
            }
        }
        </style>
    </head>
    <body>
        <div class="loading-container">
            <div class="loading-card">
                <!-- Background elements -->
                <div class="glow-effect glow-1"></div>
                <div class="glow-effect glow-2"></div>
                
                <!-- Main content -->
                <div class="logo-container">
                    <h1>
                        <span class="logo-icon">🏢</span>
                        MOADOP
                    </h1>
                    <span class="version">WORKER MANAGEMENT</span>
                </div>
                
                <div class="loader-wrapper">
                    <div class="main-loader">
                        <div class="loader-ring"></div>
                        <div class="loader-ring"></div>
                        <div class="loader-ring"></div>
                    </div>
                    
                    <div class="loading-text">Processing Application</div>
                    <div class="loading-subtext">Setting up your professional workspace...</div>
                    
                    <div class="progress-container">
                        <div class="progress-bar"></div>
                    </div>
                </div>
                
                <div class="features-grid">
                    <div class="feature-card">
                        <span class="feature-icon">📊</span>
                        <div class="feature-text">Order Management</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">👥</span>
                        <div class="feature-text">Team Collaboration</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">📱</span>
                        <div class="feature-text">Real-time Messaging</div>
                    </div>
                    <div class="feature-card">
                        <span class="feature-icon">📈</span>
                        <div class="feature-text">Performance Analytics</div>
                    </div>
                </div>
                
                <div class="status-indicators">
                    <div class="status-item">
                        <div class="status-dot"></div>
                        <span>System Online</span>
                    </div>
                    <div class="status-item">
                        <div class="status-dot primary"></div>
                        <span>Processing Data</span>
                    </div>
                    <div class="status-item">
                        <div class="status-dot warning"></div>
                        <span>Secure Connection</span>
                    </div>
                </div>
                
                <div class="loading-stats">
                    <div class="stat">
                        <span class="stat-number" id="workerCount">0</span>
                        <span class="stat-label">Active Workers</span>
                    </div>
                    <div class="stat">
                        <span class="stat-number" id="orderCount">0</span>
                        <span class="stat-label">Orders Today</span>
                    </div>
                    <div class="stat">
                        <span class="stat-number" id="uptime">100%</span>
                        <span class="stat-label">Uptime</span>
                    </div>
                </div>
            </div>
        </div>
        
        <script>
            // Animated counter for stats
            function animateCounter(element, target, duration = 2000) {
                let start = 0;
                const increment = target / (duration / 16);
                const timer = setInterval(() => {
                    start += increment;
                    if (start >= target) {
                        element.textContent = target;
                        clearInterval(timer);
                    } else {
                        element.textContent = Math.floor(start);
                    }
                }, 16);
            }
            
            // Simulate loading progress
            setTimeout(() => {
                animateCounter(document.getElementById('workerCount'), 42);
                animateCounter(document.getElementById('orderCount'), 156);
            }, 500);
            
            // Redirect to dashboard after 3 seconds
            setTimeout(() => {
                window.location.href = '/dashboard/${userId}';
            }, 3000);
        </script>
    </body>
    </html>
    `);
});

// Health check endpoint
app.get('/health', (req, res) => {
    const db = readDatabase();
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        statistics: db.statistics,
        domain: SHORT_DOMAIN,
        dropboxEnabled: true,
        telegramBot: true
    });
});

// Backup status
app.get('/backup-status', async (req, res) => {
    try {
        const db = readDatabase();
        res.json({
            success: true,
            lastBackup: db.statistics.lastBackup,
            totalWorkers: db.statistics.totalWorkers,
            totalOrders: db.statistics.totalOrders,
            startupCount: db.statistics.startupCount,
            domain: SHORT_DOMAIN,
            dropboxEnabled: true,
            telegramBot: true,
            backups: db.backups ? db.backups.slice(-10) : []
        });
    } catch (error) {
        console.error('Backup status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Trigger backup
app.get('/trigger-backup', async (req, res) => {
    try {
        console.log('💾 Manual backup triggered via web');
        const result = await backupDatabaseToDropbox();
        res.json(result);
    } catch (error) {
        console.error('Manual backup error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== TELEGRAM BOT SETUP ====================

let bot = null;

// Custom session middleware
function ensureSession(ctx, next) {
    if (!ctx.session) {
        ctx.session = {};
        console.log(`🆕 ensureSession: Created session for ${ctx.from?.id}`);
    }
    return next();
}

async function initializeTelegramBot() {
    try {
        bot = new Telegraf(config.telegramBotToken);
        
        // Initialize session with proper middleware
        bot.use(session());
        bot.use(ensureSession);

        // ==================== BOT COMMANDS ====================

        // Start command
        bot.start(async (ctx) => {
            try {
                const userId = ctx.from.id.toString();
                console.log(`🚀 Start command from user: ${userId}`);
                
                if (!ctx.session) {
                    ctx.session = {};
                    console.log(`🆕 Created session for ${userId}`);
                }
                
                if (isSuperAdmin(userId)) {
                    await handleSuperAdminStart(ctx);
                } else if (isAdmin(userId)) {
                    await handleAdminStart(ctx);
                } else {
                    await handleUserStart(ctx);
                }
            } catch (error) {
                console.error('❌ Start command error:', error);
                await ctx.reply('❌ Sorry, an error occurred. Please try again.');
            }
        });

        // Admin commands
        bot.command('admin', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await showAdminPanel(ctx);
            } else {
                await ctx.reply('❌ Access denied. Admin only.');
            }
        });

        bot.command('stats', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await showStatistics(ctx);
            } else {
                await ctx.reply('❌ Access denied. Admin only.');
            }
        });

        bot.command('workers', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await listWorkers(ctx);
            } else {
                await ctx.reply('❌ Access denied. Admin only.');
            }
        });

        bot.command('orders', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await listOrders(ctx);
            } else {
                await ctx.reply('❌ Access denied. Admin only.');
            }
        });

        // ==================== BOT ACTIONS ====================

        // Role selection
        bot.action('role_customer_service', async (ctx) => {
            await ctx.answerCbQuery();
            const userId = ctx.from.id.toString();
            
            await ctx.reply(
                '📞 *Customer Service Application*\n\n' +
                'You\'ve selected Customer Service role.\n\n' +
                'Click below to start your application:',
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('📝 Start Application', `${config.webBaseUrl}/register/${userId}?role=customer_service`)]
                    ])
                }
            );
        });

        bot.action('role_rider', async (ctx) => {
            await ctx.answerCbQuery();
            const userId = ctx.from.id.toString();
            
            await ctx.reply(
                '🚗 *Rider Application*\n\n' +
                'You\'ve selected Rider role.\n\n' +
                'Click below to start your application:',
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.webApp('📝 Start Application', `${config.webBaseUrl}/register/${userId}?role=rider`)]
                    ])
                }
            );
        });

        // Admin actions
        bot.action('admin_stats', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await ctx.answerCbQuery();
                await showStatistics(ctx);
            }
        });

        bot.action('admin_workers', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await ctx.answerCbQuery();
                await listWorkers(ctx);
            }
        });

        bot.action('admin_orders', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await ctx.answerCbQuery();
                await listOrders(ctx);
            }
        });

        bot.action('admin_dashboard', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (isAdmin(userId)) {
                await ctx.answerCbQuery();
                await ctx.reply(
                    '👑 Opening Admin Dashboard...',
                    Markup.inlineKeyboard([
                        [Markup.button.webApp('📱 Open Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)]
                    ])
                );
            }
        });

        // Worker approval callbacks
        bot.action(/approve_worker_(.+)/, async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.answerCbQuery('❌ Access denied.');
                return;
            }
            
            const workerUserId = ctx.match[1];
            const success = approveWorker(workerUserId, userId);
            
            if (success) {
                await ctx.editMessageText(
                    `✅ *Worker Approved!*\n\n` +
                    `The worker has been approved and can now access the system.`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await ctx.editMessageText('❌ Worker not found or already approved.');
            }
            await ctx.answerCbQuery();
        });

        bot.action(/reject_worker_(.+)/, async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!isAdmin(userId)) {
                await ctx.answerCbQuery('❌ Access denied.');
                return;
            }
            
            const workerUserId = ctx.match[1];
            const success = rejectWorker(workerUserId);
            
            if (success) {
                await ctx.editMessageText('❌ Worker application rejected.');
            } else {
                await ctx.editMessageText('❌ Worker not found.');
            }
            await ctx.answerCbQuery();
        });

        // Handle callback queries
        bot.on('callback_query', async (ctx) => {
            try {
                await ctx.answerCbQuery();
            } catch (error) {
                console.error('Callback query error:', error);
            }
        });

        bot.catch((err, ctx) => {
            console.error(`Telegram Bot Error for ${ctx.updateType}:`, err);
        });

        await bot.telegram.getMe();
        console.log('✅ Telegram bot connected successfully');
        return bot;
        
    } catch (error) {
        console.error('❌ Failed to initialize Telegram bot:', error.message);
        return null;
    }
}

async function handleSuperAdminStart(ctx) {
    const userId = ctx.from.id.toString();
    const db = readDatabase();
    const adminWelcome = db.settings?.adminWelcomeMessage || "👑 *Welcome to Moadop Super Admin Panel*\n\nManage your entire workforce and monitor operations.";
    
    await ctx.reply(
        adminWelcome,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('👑 Super Admin Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)],
                [Markup.button.callback('📊 Statistics', 'admin_stats')],
                [Markup.button.callback('👥 Worker Management', 'admin_workers')],
                [Markup.button.callback('📦 Order Management', 'admin_orders')]
            ])
        }
    );
}

async function handleAdminStart(ctx) {
    const userId = ctx.from.id.toString();
    const db = readDatabase();
    const adminWelcome = db.settings?.adminWelcomeMessage || "👑 *Welcome to Moadop Admin Panel*\n\nManage your team and monitor operations.";
    
    await ctx.reply(
        adminWelcome,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('📱 Admin Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)],
                [Markup.button.callback('📊 Statistics', 'admin_stats')],
                [Markup.button.callback('👥 Workers', 'admin_workers')],
                [Markup.button.callback('📦 Orders', 'admin_orders')]
            ])
        }
    );
}

async function handleUserStart(ctx) {
    try {
        const userId = ctx.from.id.toString();
        const worker = getWorker(userId);
        
        const welcomeMessage = "🏢 *Welcome to Moadop Worker Management System!*\n\nSelect your role to get started with your professional journey.";
        
        if (worker) {
            if (worker.status === 'pending') {
                await ctx.reply(
                    '⏳ *Application Under Review*\n\n' +
                    'Your application is being reviewed by our admin team.\n\n' +
                    `Role Applied: ${worker.role === 'rider' ? '🚗 Rider' : '📞 Customer Service'}\n\n` +
                    'You will be notified once your application is approved.',
                    { parse_mode: 'Markdown' }
                );
            } else if (worker.status === 'approved') {
                await ctx.reply(
                    `🎉 *Welcome back ${worker.firstName}!*\n\n` +
                    `You are logged in as: ${worker.role === 'rider' ? '🚗 Rider' : '📞 Customer Service'}\n\n` +
                    'Access your dashboard below:',
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('🚀 Open Dashboard', `${config.webBaseUrl}/dashboard/${userId}`)]
                        ])
                    }
                );
            }
        } else {
            // New user - show role selection
            await ctx.reply(
                welcomeMessage,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('📞 Customer Service', 'role_customer_service')],
                        [Markup.button.callback('🚗 Rider', 'role_rider')]
                    ])
                }
            );
        }
    } catch (error) {
        console.error('❌ Handle user start error:', error);
        await ctx.reply('❌ Sorry, an error occurred. Please try again.');
    }
}

async function showAdminPanel(ctx) {
    const stats = getStatistics();
    
    await ctx.reply(
        `👑 *Admin Panel*\n\n` +
        `📊 *Statistics:*\n` +
        `• Total Workers: ${stats.totalWorkers}\n` +
        `• Pending Applications: ${stats.pendingWorkers}\n` +
        `• Total Orders: ${stats.totalOrders}\n` +
        `• Orders Today: ${stats.ordersToday}\n` +
        `• Website Visits: ${stats.websiteVisits}\n\n` +
        `Choose an action:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('📱 Web Dashboard', `${config.webBaseUrl}/dashboard/${ctx.from.id}`)],
                [Markup.button.callback('📊 Refresh Stats', 'admin_stats')],
                [Markup.button.callback('👥 Manage Workers', 'admin_workers')],
                [Markup.button.callback('📦 View Orders', 'admin_orders')]
            ])
        }
    );
}

async function showStatistics(ctx) {
    const stats = getStatistics();
    const db = readDatabase();
    const workers = Object.values(db.workers || {});
    
    const recentWorkers = workers
        .sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt))
        .slice(0, 5);
    
    let recentWorkersText = '';
    recentWorkers.forEach((worker, index) => {
        recentWorkersText += `\n${index + 1}. ${worker.firstName} ${worker.lastName} (${worker.role}) - ${worker.status}`;
    });
    
    await ctx.reply(
        `📊 *System Statistics*\n\n` +
        `👥 *Workers:*\n` +
        `• Total: ${stats.totalWorkers}\n` +
        `• Approved: ${stats.approvedWorkers}\n` +
        `• Pending: ${stats.pendingWorkers}\n` +
        `• Customer Service: ${stats.customerServiceCount}\n` +
        `• Riders: ${stats.riderCount}\n` +
        `• Admins: ${stats.adminCount}\n\n` +
        `📦 *Orders:*\n` +
        `• Total: ${stats.totalOrders}\n` +
        `• Today: ${stats.ordersToday}\n` +
        `• Pending: ${stats.pendingOrders}\n` +
        `• Processing: ${stats.processingOrders}\n` +
        `• Delivered: ${stats.deliveredOrders}\n\n` +
        `🌐 *Website:*\n` +
        `• Total Visits: ${stats.websiteVisits}\n\n` +
        `📈 *Recent Applications:*${recentWorkersText || '\nNo recent applications'}`,
        { parse_mode: 'Markdown' }
    );
}

async function listWorkers(ctx) {
    const db = readDatabase();
    const workers = Object.values(db.workers || {});
    
    if (workers.length === 0) {
        await ctx.reply('📭 No workers found in the database.');
        return;
    }
    
    const workerList = workers
        .slice(0, 10)
        .map((worker, index) => 
            `${index + 1}. ${worker.firstName} ${worker.lastName}\n   📧 ${worker.email}\n   📞 ${worker.phone}\n   💼 ${worker.role} | ${worker.status}\n   📅 ${new Date(worker.appliedAt).toLocaleDateString()}\n`
        )
        .join('\n');
    
    await ctx.reply(
        `👥 *Worker List* (${workers.length} total)\n\n${workerList}\n\n` +
        `Use the web dashboard for full worker management.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('👑 Full Management', `${config.webBaseUrl}/dashboard/${ctx.from.id}`)]
            ])
        }
    );
}

async function listOrders(ctx) {
    const db = readDatabase();
    const orders = Object.values(db.orders || {});
    
    if (orders.length === 0) {
        await ctx.reply('📭 No orders found in the database.');
        return;
    }
    
    const orderList = orders
        .slice(0, 5)
        .map((order, index) => 
            `${index + 1}. ${order.customerName}\n   📞 ${order.customerPhone}\n   📦 ${order.product} (x${order.quantity})\n   📊 ${order.status}\n   📅 ${new Date(order.createdAt).toLocaleDateString()}\n`
        )
        .join('\n');
    
    await ctx.reply(
        `📦 *Recent Orders* (${orders.length} total)\n\n${orderList}\n\n` +
        `Use the web dashboard for full order management.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('📦 Manage Orders', `${config.webBaseUrl}/dashboard/${ctx.from.id}`)]
            ])
        }
    );
}

// ==================== AUTO-PING SYSTEM FOR RENDER ====================
function startAutoPing() {
    if (!IS_RENDER) {
        console.log('🚫 Auto-ping disabled (not on Render)');
        return;
    }

    const pingInterval = 14 * 60 * 1000;
    
    async function pingServer() {
        try {
            const response = await axios.get(`${config.webBaseUrl}/health`, { timeout: 10000 });
            console.log(`✅ Auto-ping successful: ${response.data.status}`);
        } catch (error) {
            console.warn(`⚠️ Auto-ping failed: ${error.message}`);
        }
    }

    setTimeout(() => {
        pingServer();
        setInterval(pingServer, pingInterval);
    }, 60000);

    console.log(`🔄 Auto-ping started for Render (every ${pingInterval/60000} minutes)`);
}

// ==================== MEMORY MANAGEMENT ====================
const memoryCache = new NodeCache({ 
    stdTTL: 3600,
    checkperiod: 600
});

function startMemoryCleanup() {
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
        
        console.log(`🧠 Memory usage: ${heapUsedMB.toFixed(2)}MB / ${config.maxMemoryMB}MB`);
        
        if (heapUsedMB > config.maxMemoryMB * 0.8) {
            console.log('⚠️ High memory usage detected, running cleanup...');
            performMemoryCleanup();
        }
        
        const keys = memoryCache.keys();
        if (keys.length > 1000) {
            const half = Math.floor(keys.length / 2);
            keys.slice(0, half).forEach(key => memoryCache.del(key));
            console.log(`🗑️ Cleaned ${half} cache entries`);
        }
        
    }, config.cleanupInterval);
}

function performMemoryCleanup() {
    try {
        memoryCache.flushAll();
        
        if (global.gc) {
            global.gc();
            console.log('🗑️ Manual garbage collection performed');
        }
        
        console.log('✅ Memory cleanup completed');
        console.log(`Moadop System Running`);
        
    } catch (error) {
        console.error('Memory cleanup error:', error);
    }
}

// ==================== AUTO-BACKUP SYSTEM ====================
function startAutoBackup() {
    console.log(`🔄 Starting automatic backups every ${config.backupInterval / 60000} minutes`);
    
    setTimeout(async () => {
        console.log('🔄 Running initial automatic backup...');
        await backupDatabaseToDropbox().catch(console.error);
    }, 2 * 60 * 1000);

    setInterval(async () => {
        console.log('🔄 Running scheduled automatic backup...');
        const result = await backupDatabaseToDropbox().catch(console.error);
        
        if (result && result.success) {
            const db = readDatabase();
            db.statistics.lastBackup = new Date().toISOString();
            writeDatabase(db);
        }
    }, config.backupInterval);

    process.on('SIGINT', async () => {
        console.log('🚨 Process exiting, performing final backup...');
        await backupDatabaseToDropbox().catch(console.error);
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('🚨 Process terminating, performing final backup...');
        await backupDatabaseToDropbox().catch(console.error);
        process.exit(0);
    });
}

// ==================== START SERVERS ====================
async function startServers() {
    try {
        console.log('🚀 Starting Moadop Worker Management System...');
        console.log(`🌐 Domain: ${SHORT_DOMAIN}`);
        console.log(`🔗 URL: ${config.webBaseUrl}`);
        console.log(`🤖 Bot Token: ${config.telegramBotToken ? '✅ Configured' : '❌ Missing'}`);
        console.log(`📦 Dropbox: ${DROPBOX_REFRESH_TOKEN ? '✅ Configured' : '❌ Missing'}`);
        console.log(`👑 Super Admin: ${SUPER_ADMIN_CHAT_ID}`);
        
        initDatabase();
        
        console.log('🔄 Checking for Dropbox backup...');
        await restoreDatabaseFromDropbox();
        
        const server = app.listen(config.webPort, '0.0.0.0', () => {
            console.log(`✅ Web server running on port ${config.webPort}`);
            console.log(`📊 Dashboard: ${config.webBaseUrl}`);
            console.log(`👑 Admin Panel: ${config.webBaseUrl}/dashboard/${SUPER_ADMIN_CHAT_ID}`);
            console.log(`📝 Registration: ${config.webBaseUrl}/register/{userId}`);
            console.log(`📦 Order Page: ${config.webBaseUrl}/`);
            console.log(`🏥 Health: ${config.webBaseUrl}/health`);
            console.log(`Moadop System Operational`);
        });

        startAutoPing();
        startAutoBackup();
        startMemoryCleanup();

        const telegramBot = await initializeTelegramBot();
        
        if (telegramBot) {
            await telegramBot.launch();
            console.log('✅ Telegram bot started successfully');
            
            try {
                await telegramBot.telegram.sendMessage(
                    SUPER_ADMIN_CHAT_ID,
                    `🏢 *Moadop System Started Successfully*\n\n` +
                    `🕒 Time: ${new Date().toLocaleString()}\n` +
                    `🌐 Server: ${SHORT_DOMAIN}\n` +
                    `🔗 URL: ${config.webBaseUrl}\n` +
                    `👑 Admin Panel: ${config.webBaseUrl}/dashboard/${SUPER_ADMIN_CHAT_ID}\n` +
                    `📝 Registration: ${config.webBaseUrl}/register/{userId}\n` +
                    `📦 Order Page: ${config.webBaseUrl}/\n\n` +
                    `*System Features:*\n` +
                    `• ✅ Worker Management\n` +
                    `• ✅ Order Processing\n` +
                    `• ✅ Real-time Messaging\n` +
                    `• ✅ Performance Analytics\n` +
                    `• ✅ Admin Controls\n\n` +
                    `The Moadop system is now fully operational!`,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.log('⚠️ Could not send startup notification to admin');
            }
        } else {
            console.log('ℹ️  Running in web-only mode (no Telegram bot)');
        }
        
        process.once('SIGINT', () => gracefulShutdown(telegramBot, server));
        process.once('SIGTERM', () => gracefulShutdown(telegramBot, server));
        
    } catch (error) {
        console.error('❌ Failed to start servers:', error);
        process.exit(1);
    }
}

async function gracefulShutdown(telegramBot, server) {
    console.log('🛑 Shutting down gracefully...');
    
    await backupDatabaseToDropbox().catch(console.error);
    
    if (telegramBot) {
        await telegramBot.stop();
    }
    
    server.close(() => {
        console.log('✅ Server shut down successfully');
        process.exit(0);
    });
}

// ==================== GLOBAL ERROR HANDLING ====================
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

// Start everything
console.log(`Moadop System Initializing`);
startServers();

module.exports = {
    readDatabase,
    getWorker,
    createWorkerApplication,
    approveWorker,
    rejectWorker,
    isAdmin,
    isSuperAdmin,
    getStatistics,
    createOrder,
    assignOrder,
    processOrder,
    deliverOrder,
    backupDatabaseToDropbox
};
