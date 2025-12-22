// Version 1.3 - Fixed & Verified
/**
 * POS Health Monitor - Agent Script
 * Runtime: Node.js (Raspberry Pi)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process'); // Correct Import
const util = require('util');
const execPromise = util.promisify(require('child_process').exec);
const dns = require('dns');

// Libraries
const express = require('express');
const WebSocket = require('ws');
const cron = require('node-cron');
const ping = require('ping');
const macaddress = require('node-macaddress');
const { createClient } = require('@supabase/supabase-js');

// --- CLOUD CONFIG ---
const SUPABASE_URL = 'https://tbajywjbemnwhsdgjuqg.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRiYWp5d2piZW1ud2hzZGdqdXFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2MDkzMjYsImV4cCI6MjA4MDE4NTMyNn0.5mhZQ4OTjV6f0p2v0LxADpQnaTyJIp5BIuw2kP0mdUU';

// Initialize Supabase Client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- CONFIGURATION ---
const PORT = 8080;
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LEGACY_DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

// Global State
let myMacAddress = null;
let wss = null;
let isDiagnosticRunning = false;

// DEFAULT CONFIG / SCHEMA
let config = {
  meta: { version: 1, last_sync: 0 },
  settings: {
    location_id: "loc_default",
    trackIpChanges: true,
    reboot_schedule: { enabled: true, time: "05:00", timezone: "America/New_York" },
    network: { scan_subnet: "", claimed_static_ip: "", ping_interval_seconds: 15, ping_timeout_ms: 1500, failure_threshold: 3 },
    failover: { primary_wan_ip: "", check_target: "8.8.8.8" }
  },
  devices: []
};

// Runtime Status
let networkStatus = {
  eth: { connected: false, ip: null, mac: null },
  wifi: { connected: false, ip: null, mac: null },
  wan: 'Unknown', latency: null, packetLoss: 0,
  dns: { status: 'Unknown', duration: 0 }
};

let vitals = { cpuTemp: null, cpuLoad: 0, freeRam: 0, totalRam: os.totalmem() };
let rebootTask = null;

// --- INITIALIZATION ---

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR); } catch (e) { console.error('Failed to create data directory:', e); }
}

function saveConfig() {
  const tempFile = CONFIG_FILE + '.tmp';
  try {
    const fd = fs.openSync(tempFile, 'w');
    fs.writeSync(fd, JSON.stringify(config, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tempFile, CONFIG_FILE);
  } catch (err) {
    console.error('CRITICAL: Error saving config.json:', err);
  }
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const storedConfig = JSON.parse(data);
      config = {
        ...config,
        ...storedConfig,
        settings: {
          ...config.settings,
          ...storedConfig.settings,
          network: { ...config.settings.network, ...(storedConfig.settings?.network || {}) }
        },
        meta: { ...config.meta, ...storedConfig.meta }
      };
      config.devices = storedConfig.devices || [];

      config.devices.forEach(d => {
        d.status = d.status || 'Offline';
        d.failureCount = 0;
        if (d.manufacturer === undefined) d.manufacturer = '';
        if (d.parent_dependency === undefined) d.parent_dependency = null;
      });

      console.log(`Loaded config. ${config.devices.length} devices.`);
    } catch (err) {
      console.error('CRITICAL: config.json corrupt. Starting fresh.', err);
      try { fs.renameSync(CONFIG_FILE, CONFIG_FILE + '.corrupt.' + Date.now()); } catch (e) { }
      saveConfig();
    }
  }
  else if (fs.existsSync(LEGACY_DEVICES_FILE)) {
    console.log("Migrating legacy devices.json to config.json...");
    try {
      const rawDevs = fs.readFileSync(LEGACY_DEVICES_FILE, 'utf8');
      const legacyDevs = JSON.parse(rawDevs);

      config.devices = legacyDevs.map(d => ({
        mac: d.mac, ip: d.ip, name: d.name || '', type: d.type || 'unknown', manufacturer: '',
        iface: d.iface || 'unknown', is_monitored: (d.is_monitored !== undefined) ? d.is_monitored : true,
        is_identified: (d.is_identified !== undefined) ? d.is_identified : false,
        last_seen: d.last_seen || 0, parent_dependency: null, status: 'Offline', failureCount: 0
      }));

      saveConfig();
      try { fs.unlinkSync(LEGACY_DEVICES_FILE); } catch (e) { }
    } catch (e) { console.error("Migration failed:", e); }
  }
  else {
    saveConfig();
  }
  scheduleReboot();
}

function scheduleReboot() {
  if (rebootTask) rebootTask.stop();

  if (config.settings.reboot_schedule.enabled) {
    const timeParts = config.settings.reboot_schedule.time.split(':');
    if (timeParts.length === 2) {
      const cronStr = `${timeParts[1]} ${timeParts[0]} * * *`;
      console.log(`Scheduling daily reboot at ${config.settings.reboot_schedule.time}`);

      rebootTask = cron.schedule(cronStr, () => {
        const uptime = os.uptime();
        if (uptime < 3600) {
          console.log("Skipping reboot: System uptime < 1 hour.");
          return;
        }
        if (wss && wss.clients.size > 0) {
          console.log("Skipping reboot: Active WebSocket clients connected.");
          return;
        }
        console.log("Executing Daily Reboot...");
        exec('sudo reboot');
      });
    }
  }
}

// --- CLOUD INTEGRATION ---

async function sendHeartbeat() {
  const nets = getSystemNetworkStatus();
  const currentIp = (nets.eth && nets.eth.connected) ? nets.eth.ip :
    (nets.wifi && nets.wifi.connected) ? nets.wifi.ip : '0.0.0.0';

  const { error } = await supabase
    .from('pucks')
    .upsert({
      mac_address: myMacAddress,
      current_ip: currentIp,
      status: 'online',
      last_seen: new Date().toISOString()
    }, { onConflict: 'mac_address' });

  if (error) console.error('[SUPABASE] Heartbeat failed:', error.message);
  else console.log('[SUPABASE] Heartbeat success.');
}

async function syncInventoryToCloud() {
  if (!config.devices || config.devices.length === 0) return;

  // 1. FETCH TRUTH: Get current Cloud Metadata
  const { data: cloudDevices, error: fetchErr } = await supabase
    .from('devices')
    .select('mac, name, location, is_monitored')
    .eq('puck_mac', myMacAddress);

  if (fetchErr) {
    console.log('[CLOUD] Metadata fetch skipped:', fetchErr.message);
  }

  // Create a lookup map
  const cloudMap = {};
  if (cloudDevices) {
    cloudDevices.forEach(d => {
      if (d.mac) cloudMap[d.mac.toLowerCase()] = d;
    });
  }

  // 2. MERGE: Update Local Config with Cloud Data
  config.devices.forEach(localDev => {
    const macKey = (localDev.mac || '').toLowerCase();
    const cloudDev = cloudMap[macKey];

    if (cloudDev) {
      // Adopt name if cloud has one
      if (cloudDev.name && cloudDev.name !== 'Unknown Device' && cloudDev.name !== '') {
        localDev.name = cloudDev.name;
      }
      // Adopt location/group
      if (cloudDev.location) {
        localDev.location = cloudDev.location;
      }
      // Adopt monitor status
      if (cloudDev.is_monitored !== undefined) {
        localDev.is_monitored = cloudDev.is_monitored;
      }
    }
  });

  saveConfig();

  console.log(`[CLOUD] Syncing inventory (${config.devices.length} devices) to Supabase...`);

  // 3. PUSH: Send status updates, carrying the metadata with us
  const payload = config.devices.map(d => ({
    puck_mac: myMacAddress,
    mac: d.mac,
    ip_address: d.ip, // Corrected column name
    name: d.name || 'Unknown Device',
    manufacturer: d.manufacturer || '',
    status: (d.status || 'offline').toLowerCase(),
    last_seen: new Date().toISOString(),
    location: d.location || null, // Persist location
    is_monitored: d.is_monitored
  }));

  // Batch UPSERT
  const { error: upsertErr } = await supabase
    .from('devices')
    .upsert(payload, { onConflict: 'puck_mac, mac' });

  if (upsertErr) {
    console.error('[SUPABASE] Inventory sync failed:', upsertErr.message);
  }
}

// --- REALTIME COMMAND LISTENER ---
async function listenForCommands() {
  console.log(`[REALTIME] Listening for commands...`);

  const channel = supabase
    .channel('public:commands')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'commands' },
      async (payload) => {
        const cmd = payload.new;
        if (cmd.puck_mac !== myMacAddress) return;
        console.log(`[COMMAND-RT] Received: ${cmd.command_type}`);
        await processCommand(cmd);
      }
    )
    .subscribe((status) => {
      console.log(`[REALTIME] Subscription status: ${status}`);
    });
}

// --- FALLBACK POLLER (ADDS RELIABILITY) ---
function startCommandPoller() {
  setInterval(async () => {
    if (!myMacAddress) return;
    const { data: commands, error } = await supabase
      .from('commands')
      .select('*')
      .eq('puck_mac', myMacAddress)
      .eq('status', 'pending')
      .limit(1);

    if (commands && commands.length > 0) {
      console.log(`[POLLER] Found pending command: ${commands[0].command_type}`);
      await processCommand(commands[0]);
    }
  }, 10000); // Check every 10 seconds
}

// --- SYSTEM VITALS ---

function collectVitals() {
  vitals.cpuLoad = os.loadavg()[0].toFixed(2);
  vitals.freeRam = os.freemem();
  exec('vcgencmd measure_temp', (err, stdout) => {
    if (!err && stdout) {
      const match = stdout.match(/temp=([0-9.]+)/);
      if (match && match[1]) vitals.cpuTemp = parseFloat(match[1]);
    } else {
      if (!vitals.cpuTemp) vitals.cpuTemp = 45.0;
    }
    broadcast('VITALS_UPDATE', vitals);
  });
}

// --- NETWORK HELPERS ---

function getSystemNetworkStatus() {
  const ifaces = os.networkInterfaces();
  const status = { eth: { connected: false, ip: null, mac: null }, wifi: { connected: false, ip: null, mac: null } };
  const findInfo = (details) => {
    if (!details) return null;
    const v4 = details.find(d => d.family === 'IPv4' && !d.internal);
    return v4 ? { ip: v4.address, mac: v4.mac } : null;
  };
  const ethKey = Object.keys(ifaces).find(k => k.startsWith('eth') || k.startsWith('en'));
  const ethInfo = findInfo(ifaces[ethKey]);
  if (ethInfo) status.eth = { connected: true, ...ethInfo };
  const wifiKey = Object.keys(ifaces).find(k => k.startsWith('wlan') || k.startsWith('wl'));
  const wifiInfo = findInfo(ifaces[wifiKey]);
  if (wifiInfo) status.wifi = { connected: true, ...wifiInfo };
  return status;
}

function getLocalSubnets() {
  const subnets = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(ifaceName => {
    ifaces[ifaceName].forEach(details => {
      if (details.family === 'IPv4' && !details.internal) subnets.push(details.cidr);
    });
  });
  return subnets;
}

function isIpInCidr(ip, cidr) {
  try {
    const [range, bits] = cidr.split('/');
    const mask = ~(2 ** (32 - bits) - 1);
    const ipToLong = (ip) => ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
    return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
  } catch (e) { return false; }
}

function getMacVendor(mac) {
  if (!mac) return 'Unknown';
  const prefix = mac.toUpperCase().substring(0, 8);
  const vendors = {
    'B8:27:EB': 'Raspberry Pi', 'DC:A6:32': 'Raspberry Pi', 'E4:5F:01': 'Raspberry Pi', 'D8:3A:DD': 'Raspberry Pi',
    '00:0C:29': 'VMware', '00:50:56': 'VMware', '00:15:5D': 'Microsoft',
    '00:1B:5F': 'Epson', '00:26:AB': 'Epson',
    '00:1D:60': 'Ingenico', 'F0:9F:C2': 'Ubiquiti', '74:83:C2': 'Ubiquiti', '18:E8:29': 'Ubiquiti',
    '00:17:F2': 'Apple', 'BC:54:36': 'Star Micronics',
    '00:15:94': 'Bixolon', '00:80:77': 'Brother', '3C:2A:F4': 'Brother',
    '00:04:88': 'Datalogic', '00:14:22': 'Dell', '00:0E:57': 'ELO',
    '00:10:20': 'Honeywell', '3C:D9:2B': 'HP', '00:05:C9': 'LG',
    '00:00:F0': 'Panasonic', '00:23:47': 'Pax', '00:0F:7C': 'Sam4s',
    '00:07:AB': 'Samsung', '44:65:0D': 'Square', '1C:9D:C2': 'Toast',
    '00:00:39': 'Toshiba', '00:22:58': 'Touch Dynamic', '00:09:1F': 'Verifone', '00:A0:F8': 'Zebra'
  };
  return vendors[prefix] || 'Unknown';
}

function checkIpConflict(targetIp) {
  return new Promise((resolve) => {
    exec(`sudo arping -c 1 -I eth0 ${targetIp}`, (err, stdout) => {
      if (err) { resolve(null); return; }
      const match = stdout.match(/\[([0-9A-Fa-f:]{17})\]/);
      if (match) {
        const mac = match[1];
        const vendor = getMacVendor(mac);
        resolve({ mac, vendor });
      } else {
        resolve({ mac: 'Unknown', vendor: 'Unknown' });
      }
    });
  });
}

// Phase 1: Slot Finder
async function findAndClaimStaticIP() {
  let prefix = '192.168.1';
  const sysNet = getSystemNetworkStatus();
  if (sysNet.eth && sysNet.eth.ip) {
    const parts = sysNet.eth.ip.split('.');
    prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  }

  const claimedIp = config.settings.network.claimed_static_ip;
  if (claimedIp && claimedIp.startsWith(prefix)) {
    console.log(`[SLOT FINDER] Verifying persisted claim: ${claimedIp}`);
    const conflict = await checkIpConflict(claimedIp);
    if (!conflict) {
      console.log(`[SLOT FINDER] Persisted IP ${claimedIp} is free. Re-claiming.`);
      return claimedIp;
    } else {
      console.warn(`[SLOT FINDER] Persisted IP ${claimedIp} is TAKEN. Scanning for new slot...`);
    }
  }

  console.log(`[SLOT FINDER] Scanning range ${prefix}.250 to .200...`);
  for (let i = 250; i >= 200; i--) {
    const candidateIp = `${prefix}.${i}`;
    const conflict = await checkIpConflict(candidateIp);
    if (!conflict) {
      console.log(`[SLOT FINDER] Found free IP: ${candidateIp}`);
      config.settings.network.claimed_static_ip = candidateIp;
      saveConfig();
      return candidateIp;
    }
  }
  return null;
}

// --- MONITORING LOGIC ---

async function smartPing(ip) {
  const timeout = config.settings.network.ping_timeout_ms / 1000;
  let res = await ping.promise.probe(ip, { timeout: timeout });
  if (res.alive) return true;
  await new Promise(r => setTimeout(r, 200));
  res = await ping.promise.probe(ip, { timeout: timeout });
  if (res.alive) return true;
  await new Promise(r => setTimeout(r, 200));
  res = await ping.promise.probe(ip, { timeout: timeout });
  return res.alive;
}

async function checkWanStatus() {
  const target = config.settings.failover.check_target || '8.8.8.8';
  try {
    const res = await ping.promise.probe(target, { timeout: 2 });
    if (res.alive) return { status: 'Online', latency: Math.round(res.avg) + 'ms', packetLoss: 0 };
    else return { status: 'Offline', latency: null, packetLoss: 100 };
  } catch (e) {
    return { status: 'Offline', latency: null, packetLoss: 100 };
  }
}

async function checkDNS() {
  const start = Date.now();
  return new Promise((resolve) => {
    dns.resolve('google.com', (err) => {
      const duration = Date.now() - start;
      if (err) networkStatus.dns = { status: 'Error', duration: duration };
      else networkStatus.dns = { status: 'OK', duration: duration };
      resolve();
    });
  });
}

async function handleDiagnostics(ws, target) {
  if (isDiagnosticRunning) {
    ws.send(JSON.stringify({ type: 'DIAGNOSTICS_ERROR', message: 'Busy' }));
    return;
  }
  isDiagnosticRunning = true;
  ws.send(JSON.stringify({ type: 'DIAGNOSTICS_STARTED', target }));
  try {
    const res = await ping.promise.probe(target, { timeout: 5, extra: ["-c", "5", "-i", "0.5"] });
    ws.send(JSON.stringify({
      type: 'DIAGNOSTICS_RESULT', payload: {
        target, alive: res.alive, packetLoss: parseFloat(res.packetLoss),
        avgLatency: res.avg, min: res.min, max: res.max
      }
    }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'DIAGNOSTICS_ERROR', message: e.message }));
  } finally { isDiagnosticRunning = false; }
}

async function monitorLoop() {
  if (isDiagnosticRunning) { setTimeout(monitorLoop, 1000); return; }

  const sysNet = getSystemNetworkStatus();
  networkStatus.eth = sysNet.eth;
  networkStatus.wifi = sysNet.wifi;

  if (networkStatus.eth && networkStatus.eth.ip) {
    const currentIp = networkStatus.eth.ip;
    try {
      const conflict = await checkIpConflict(currentIp);
      if (conflict && conflict.mac && conflict.mac !== myMacAddress) {
        console.error(`IP CONFLICT! ${currentIp} taken by ${conflict.mac}`);
        broadcast('IP_CONFLICT_ALERT', { type: 'IP_STOLEN', stolen_ip: currentIp, thief: conflict.mac });
        supabase.from('status_logs').insert({
          puck_mac: myMacAddress, event_type: 'IP_CONFLICT',
          details: { conflict_ip: currentIp, blocker: conflict.mac, timestamp: new Date().toISOString() }
        }).then(() => { });
      }
    } catch (e) { }
  }

  const wanRes = await checkWanStatus();
  networkStatus.wan = wanRes.status;
  if (wanRes.latency) networkStatus.latency = wanRes.latency;
  broadcast('NETWORK_STATUS', networkStatus);

  if (networkStatus.wan === 'Offline') {
    setTimeout(monitorLoop, config.settings.network.ping_interval_seconds * 1000);
    return;
  }

  let changes = false;
  for (const device of config.devices) {
    if (isDiagnosticRunning) break;
    if (!device.is_monitored) continue;

    const isAlive = await smartPing(device.ip);
    const prevStatus = device.status;

    if (isAlive) { device.status = 'Online'; device.last_seen = Date.now(); device.failureCount = 0; }
    else { device.status = 'Offline'; }

    if (device.status !== prevStatus) {
      changes = true;
      console.log(`[STATUS CHANGE] ${device.ip} is now ${device.status}`);
      broadcast('UPDATE_DEVICE', device);
      if (config.settings.trackIpChanges) {
        supabase.from('status_logs').insert({
          puck_mac: myMacAddress, event_type: 'STATUS_CHANGE',
          details: { mac: device.mac, name: device.name, ip: device.ip, status: device.status, timestamp: new Date().toISOString() }
        }).then(() => { });
      }
    }
  }

  if (changes) saveConfig();
  setTimeout(monitorLoop, config.settings.network.ping_interval_seconds * 1000);
}

// --- DISCOVERY (NMAP) ---

function runDiscovery() {
  return new Promise((resolve) => {
    if (isDiagnosticRunning) { resolve(); return; }

    const subnets = config.settings.network.scan_subnet ? [config.settings.network.scan_subnet] : getLocalSubnets();
    if (subnets.length === 0) { resolve(); return; }

    console.log(`Starting Discovery on: ${subnets.join(', ')}`);
    exec(`sudo nmap -sn ${subnets.join(' ')}`, async (err, stdout) => {
      if (err) { console.error('Nmap error:', err); resolve(); return; }

      const lines = stdout.split('\n');
      let currentIp = null;
      let currentName = null;

      lines.forEach(line => {
        if (line.startsWith('Nmap scan report for')) {
          const parts = line.split(' for ')[1];
          if (parts.includes('(')) {
            currentName = parts.split(' (')[0];
            currentIp = parts.split(' (')[1].replace(')', '');
          } else {
            currentName = '';
            currentIp = parts;
          }
        } else if (line.includes('MAC Address:')) {
          if (currentIp) {
            const macPart = line.split('MAC Address: ')[1];
            const mac = macPart.split(' (')[0].trim();
            let manufacturer = '';
            if (macPart.includes('(')) manufacturer = macPart.split(' (')[1].replace(')', '').trim();

            handleDiscoveredDevice(currentIp, mac, currentName, manufacturer);
          }
        }
      });

      await syncInventoryToCloud();
      resolve();
    });
  });
}

function handleDiscoveredDevice(ip, rawMac, scannedName, manufacturer) {
  if (!rawMac) return;
  const mac = rawMac.toLowerCase(); // <--- FORCE LOWERCASE
  const existing = config.devices.find(d => d.mac.toLowerCase() === mac);

  // Interface detection
  let iface = 'unknown';
  const ethKey = Object.keys(os.networkInterfaces()).find(k => k.startsWith('eth'));
  if (ethKey) {
    const ethNet = os.networkInterfaces()[ethKey].find(d => d.family === 'IPv4');
    if (ethNet && isIpInCidr(ip, ethNet.cidr)) iface = 'eth';
  }
  if (iface === 'unknown') {
    const wifiKey = Object.keys(os.networkInterfaces()).find(k => k.startsWith('wlan'));
    if (wifiKey) {
      const wifiNet = os.networkInterfaces()[wifiKey].find(d => d.family === 'IPv4');
      if (wifiNet && isIpInCidr(ip, wifiNet.cidr)) iface = 'wifi';
    }
  }

  if (existing) {
    let dirty = false;
    if (existing.ip !== ip && config.settings.trackIpChanges) { existing.ip = ip; dirty = true; }
    if (!existing.manufacturer && manufacturer) { existing.manufacturer = manufacturer; dirty = true; }
    if (existing.iface !== iface) { existing.iface = iface; dirty = true; }
    if (dirty) { saveConfig(); broadcast('UPDATE_DEVICE', existing); }
  } else {
    const newDevice = {
      mac, ip, name: scannedName || '', type: 'unknown', manufacturer: manufacturer || '',
      iface,
      is_monitored: false,
      last_seen: Date.now(), status: 'Online'
    };
    config.devices.push(newDevice);
    saveConfig();
    broadcast('NEW_DEVICE', newDevice);
  }
}

// --- WEB SERVER & WEBSOCKET ---

const app = express();
app.use(express.static('public'));
app.use(express.json());
const http = require('http');
const server = http.createServer(app);
wss = new WebSocket.Server({ server });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, agentId: myMacAddress });
  wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(msg); });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'device_list', devices: config.devices || [] }));
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'run_diagnostics') handleDiagnostics(ws, msg.target);
    } catch (e) { }
  });
});

// --- AUTO-UPDATE LOGIC ---

async function updateAgentSafe(commandId) {
  console.log('[UPDATE] Starting Safe Update Protocol...');

  const updateStatus = async (msg, status = 'processing') => {
    console.log(`[UPDATE] ${msg}`);
    await supabase.from('commands').update({
      status: status,
      result: msg
    }).eq('id', commandId);
  };

  try {
    // 1. BACKUP: Save the current working file
    await updateStatus('Step 1/5: Creating Backup...');
    await execPromise('cp agent.js agent.js.bak');

    // 2. PULL: Get latest code
    await updateStatus('Step 2/5: Pulling from Git...');
    await execPromise('git pull');

    // 3. DEPENDENCIES: Install new packages
    await updateStatus('Step 3/5: Installing Dependencies...');
    await execPromise('npm install');

    // 4. VERIFY: Syntax Check (The Safety Net)
    await updateStatus('Step 4/5: Verifying Code Integrity...');
    try {
      await execPromise('node --check agent.js');
    } catch (syntaxErr) {
      throw new Error('Syntax Check Failed! Rolling back.');
    }

    // 5. COMMIT: Restart
    await updateStatus('Step 5/5: Update Verified. Restarting...', 'completed');

    // Give the database a moment to save the 'completed' status before we die
    setTimeout(() => {
      const { exec } = require('child_process');
      exec('sudo pm2 restart pos-puck');
    }, 1000);

  } catch (err) {
    console.error('[UPDATE CRITICAL FAILURE]', err);

    // ROLLBACK STRATEGY
    try {
      console.log('[UPDATE] Restoring backup...');
      await execPromise('cp agent.js.bak agent.js');
      await updateStatus(`Update Failed: ${err.message}. Backup restored.`, 'failed');
    } catch (restoreErr) {
      console.error('CRITICAL: Restore failed. Device may be unstable.', restoreErr);
    }
  }
}

// --- COMMAND PROCESSOR ---

async function processCommand(cmd) {
  console.log(`[COMMAND] Processing ${cmd.command_type} (ID: ${cmd.id})...`);

  // 1. Mark as Processing (AND CHECK FOR ERRORS)
  const { error: startError } = await supabase
    .from('commands')
    .update({ status: 'processing' })
    .eq('id', cmd.id);

  if (startError) {
    console.error(`[CRITICAL DB ERROR] Could not mark command as processing:`, startError);
    // We continue anyway to try and run the diag, but this is the smoking gun.
  }

  try {
    switch (cmd.command_type) {
      case 'REBOOT':
        console.log('[COMMAND] Executing REBOOT...');
        await supabase.from('commands').update({ status: 'completed', executed_at: new Date() }).eq('id', cmd.id);
        setTimeout(() => { exec('sudo reboot'); }, 1000);
        break;

      case 'SCAN_NETWORK':
        console.log('[COMMAND] Executing FORCE SCAN...');
        await runDiscovery();
        await supabase.from('commands').update({ status: 'completed', executed_at: new Date() }).eq('id', cmd.id);
        console.log('[COMMAND] Force scan complete.');
        break;

      case 'UPDATE_AGENT':
        await updateAgentSafe(cmd.id);
        break;

      case 'RUN_DIAGNOSTICS':
        try {
          const target = cmd.payload.target_ip || '8.8.8.8';
          console.log(`[DIAG] Pinging target: ${target}`);

          // Validate target IP
          if (!/^[0-9a-zA-Z.:]+$/.test(target)) {
            throw new Error("Invalid target IP format");
          }

          // Execute Ping with await
          const { stdout, stderr } = await execPromise(`ping -c 5 -i 0.2 ${target}`);
          console.log(`[DIAG] Ping completed for ${target}`);

          // Parse Output
          const statsLine = stdout.split('\n').find(line => line.includes('rtt') || line.includes('round-trip'));
          const packetLossLine = stdout.split('\n').find(line => line.includes('packet loss'));

          let resultPayload = {};

          if (statsLine && packetLossLine) {
            // Example: rtt min/avg/max/mdev = 10.5/12.3/15.1/2.1 ms
            const statsPart = statsLine.split('=')[1].trim();
            const parts = statsPart.split('/');

            const lossMatch = packetLossLine.match(/(\d+)% packet loss/);

            resultPayload = {
              latency: Math.round(parseFloat(parts[1])),  // avg
              jitter: Math.round(parseFloat(parts[3])),   // mdev (standard deviation)
              loss: lossMatch ? parseInt(lossMatch[1]) : 0
            };

            console.log(`[DIAG] Parsed results:`, resultPayload);
          } else {
            console.warn(`[DIAG] Could not parse ping output for ${target}`);
            resultPayload = { latency: 0, jitter: 0, loss: 100 };
          }

          // Update database with results
          const { error: updateError } = await supabase
            .from('commands')
            .update({
              status: 'success',
              result_payload: resultPayload,
              executed_at: new Date().toISOString()
            })
            .eq('id', cmd.id);

          if (updateError) {
            console.error(`[CRITICAL DB ERROR] Could not save results:`, updateError);
            throw updateError;
          }

          console.log(`[DIAG] Successfully saved results for ${target}`);

        } catch (error) {
          console.error(`[DIAG] Error during diagnostics:`, error.message);

          // Mark as failed in database
          const { error: failError } = await supabase
            .from('commands')
            .update({
              status: 'failed',
              result_payload: { error: "Unreachable", latency: 0, jitter: 0, loss: 100 },
              executed_at: new Date().toISOString()
            })
            .eq('id', cmd.id);

          if (failError) {
            console.error(`[CRITICAL DB ERROR] Could not mark command as failed:`, failError);
          }
        }
        break;

      default:
        console.log(`Unknown command: ${cmd.command_type}`);
    }
  } catch (err) {
    console.error(`[COMMAND] Error executing ${cmd.command_type}:`, err);
    await supabase.from('commands').update({ status: 'failed', payload: { error: err.message } }).eq('id', cmd.id);
  }
}
// ==========================================
// 🚀 GLOBAL IGNITION (MUST BE OUTSIDE FUNCTION)
// ==========================================

macaddress.all(async (err, all) => {
  if (err) process.exit(1);

  // 1. Get MAC Address
  if (all.eth0) myMacAddress = all.eth0.mac.toLowerCase();
  else if (all.wlan0) myMacAddress = all.wlan0.mac.toLowerCase();
  else myMacAddress = Object.values(all)[0].mac.toLowerCase();

  console.log(`Agent Started. ID: ${myMacAddress}`);

  // 2. Start Logic
  loadConfig();

  // 3. Start Server
  server.listen(PORT, () => {
    console.log(`Dashboard Server running on port ${PORT}`);
    const nets = getSystemNetworkStatus();
    if (nets.eth && nets.eth.connected) console.log(`- LAN: http://${nets.eth.ip}`);
    if (nets.wifi && nets.wifi.connected) console.log(`- WIFI: http://${nets.wifi.ip}`);
  });

  // 4. Run Syncs
  setTimeout(async () => {
    await findAndClaimStaticIP(); // Run once on boot
    await syncInventoryToCloud();
    sendHeartbeat();
    await listenForCommands();
  }, 5000);

  // 5. Start Loops
  startCommandPoller(); // Listen for commands (Fallback)
  monitorLoop();        // Watch network

  // Schedule Tasks
  cron.schedule('*/5 * * * *', runDiscovery); // Scan network
  cron.schedule('*/3 * * * *', sendHeartbeat); // Tell cloud we are alive

  console.log("[INIT] Loops started.");
});