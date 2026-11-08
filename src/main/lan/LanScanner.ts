/**
 * LAN Network Scanner
 *
 * Detects local network interfaces (including VPN/Warp), discovers the
 * default gateway, and performs an ARP-table scan + ping sweep to find
 * nearby devices on the same subnet.
 */
import { exec, spawn } from 'child_process'
import { networkInterfaces, hostname as osHostname } from 'os'
import dns from 'dns'
import https from 'https'
import type { NetworkInterface, LanDevice, LanScanResult, DeviceType } from '../../shared/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Validate that a string is a safe IPv4 address (digits and dots only) */
const VALID_IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
function isValidIp(ip: string): boolean {
  return VALID_IP_RE.test(ip)
}

function run(cmd: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(err)
      resolve((stdout || '') + (stderr || ''))
    })
  })
}

/** Safe spawn wrapper — passes arguments as an array, never through a shell */
function runSpawn(command: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, timeout: timeoutMs })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && !stdout) reject(new Error(`${command} exited with code ${code}`))
      else resolve(stdout + stderr)
    })
  })
}

function cidrFromMask(ip: string, netmask: string): string {
  const bits = netmask
    .split('.')
    .reduce((acc, octet) => acc + (parseInt(octet) >>> 0).toString(2).replace(/0/g, '').length, 0)
  const parts = ip.split('.').map(Number)
  const maskParts = netmask.split('.').map(Number)
  const network = parts.map((p, i) => p & maskParts[i]).join('.')
  return `${network}/${bits}`
}

/**
 * Resolve hostname by querying the gateway as local DNS server.
 * Home routers (D-Link COVR, Asus, TP-Link, etc.) typically run a DNS
 * forwarder that knows DHCP client names. We query it directly via
 * `nslookup <ip> <gateway>` which is fast and reliable.
 *
 * Fallback chain: gateway DNS → system reverse DNS → NetBIOS (Windows).
 */

/** Query a specific DNS server for reverse lookup via nslookup */
async function nslookupVia(ip: string, dnsServer: string): Promise<string | null> {
  if (!isValidIp(ip) || !isValidIp(dnsServer)) return null
  try {
    const out = await runSpawn('nslookup', [ip, dnsServer], 4000)
    // Output: "Name:    DEVICE-NAME\nAddress:  192.168.0.x"
    // or:     "Name:    device.local\nAddress:  192.168.0.x"
    const match = out.match(/Name:\s+(\S+)/)
    if (match) {
      // Strip trailing dot if present
      return match[1].replace(/\.$/, '')
    }
    return null
  } catch {
    return null
  }
}

/** System reverse DNS via Node's dns.reverse() */
function reverseDns(ip: string): Promise<string | null> {
  return new Promise((resolve) => {
    dns.reverse(ip, (err, hostnames) => {
      if (err || !hostnames?.length) return resolve(null)
      resolve(hostnames[0])
    })
  })
}

/** NetBIOS name lookup (Windows only — last resort, slower) */
async function netbiosLookup(ip: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  if (!isValidIp(ip)) return null
  try {
    const out = await runSpawn('nbtstat', ['-A', ip], 5000)
    // Match: "  DESKTOP-XYZ   <00>  UNIQUE  ..."
    const match = out.match(/^\s+(\S+)\s+<00>\s+UNIQUE/m)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** Resolve hostname with fallback chain: gateway DNS → reverse DNS → NetBIOS */
async function resolveHostname(ip: string, gateway: string | null): Promise<string | null> {
  // 1. Query gateway as local DNS (most reliable for LAN devices)
  if (gateway) {
    const name = await nslookupVia(ip, gateway)
    if (name) return name
  }

  // 2. System reverse DNS (works if system DNS has PTR records)
  const rdns = await reverseDns(ip)
  if (rdns) return rdns

  // 3. NetBIOS as last resort (Windows devices)
  const nbt = await netbiosLookup(ip)
  if (nbt) return nbt

  return null
}

/** Check if an IP is within a given subnet (CIDR) */
function ipInSubnet(ip: string, cidr: string): boolean {
  const [netAddr, prefixStr] = cidr.split('/')
  const prefix = parseInt(prefixStr)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0

  const ipNum = ip.split('.').reduce((acc, o) => (acc << 8) | parseInt(o), 0) >>> 0
  const netNum = netAddr.split('.').reduce((acc, o) => (acc << 8) | parseInt(o), 0) >>> 0

  return (ipNum & mask) === (netNum & mask)
}

// Known VPN/tunnel adapter name patterns
const VPN_PATTERNS = [
  /tap/i, /tun/i, /vpn/i, /wireguard/i, /wg\d/i, /nordlynx/i,
  /proton/i, /mullvad/i, /openvpn/i, /zerotier/i, /tailscale/i,
  /utun/i, /ppp\d/i, /ipsec/i
]

const WARP_PATTERNS = [
  /cloudflare/i, /warp/i, /cf-warp/i, /1\.1\.1\.1/i
]

function classifyInterface(name: string, _ip: string, hardwarePort?: string): NetworkInterface['type'] {
  if (WARP_PATTERNS.some((p) => p.test(name))) return 'warp'
  if (VPN_PATTERNS.some((p) => p.test(name))) return 'vpn'
  // macOS: BSD names (en0, en1…) don't say whether they're Wi-Fi or wired —
  // the hardware-port name from networksetup does ("Wi-Fi", "Ethernet", "USB 10/100/1000 LAN").
  if (hardwarePort) {
    if (/wi-?fi|airport/i.test(hardwarePort)) return 'wifi'
    if (/ethernet|lan|thunderbolt/i.test(hardwarePort)) return 'ethernet'
  }
  if (/wi-?fi|wlan|wireless|airport/i.test(name)) return 'wifi'
  if (/eth|en\d|ethernet|local area/i.test(name)) return 'ethernet'
  if (/lo|loopback/i.test(name)) return 'loopback'
  return 'other'
}

/**
 * macOS: map BSD device names to hardware-port names via
 * `networksetup -listallhardwareports`:
 *
 *   Hardware Port: Wi-Fi
 *   Device: en0
 */
export function parseHardwarePorts(out: string): Map<string, string> {
  const map = new Map<string, string>()
  let port: string | null = null
  for (const line of out.split(/\r?\n/)) {
    const p = line.match(/^Hardware Port:\s*(.+)$/)
    if (p) { port = p[1].trim(); continue }
    const d = line.match(/^Device:\s*(\S+)/)
    if (d && port) { map.set(d[1], port); port = null }
  }
  return map
}

async function getHardwarePorts(): Promise<Map<string, string>> {
  if (process.platform !== 'darwin') return new Map()
  try {
    return parseHardwarePorts(await runSpawn('/usr/sbin/networksetup', ['-listallhardwareports'], 5000))
  } catch {
    return new Map()
  }
}

// ── Gateway detection ────────────────────────────────────────────────────────

async function getDefaultGateway(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const out = await run('route print 0.0.0.0')
      // Look for the default route line: 0.0.0.0  0.0.0.0  <gateway>
      const match = out.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)/)
      return match?.[1] ?? null
    } else if (process.platform === 'darwin') {
      const out = await runSpawn('/sbin/route', ['-n', 'get', 'default'], 5000)
      return out.match(/gateway:\s*([\d.]+)/)?.[1] ?? null
    } else {
      const out = await run('ip route show default 2>/dev/null || netstat -rn 2>/dev/null')
      const match = out.match(/default\s+via\s+([\d.]+)/) || out.match(/default\s+([\d.]+)/)
      return match?.[1] ?? null
    }
  } catch {
    return null
  }
}

// ── ARP table parsing ────────────────────────────────────────────────────────

export interface ArpEntry {
  ip: string
  mac: string
}

/**
 * Parse `arp -a` (Windows) / `arp -an` (macOS, Linux) output.
 *
 *   Windows: "  192.168.1.1    aa-bb-cc-dd-ee-ff   dynamic"
 *   Linux:   "? (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0"
 *   macOS:   "? (192.168.1.1) at c:28:aa:5e:7:b4 on en0 ifscope [ethernet]"
 *
 * macOS drops leading zeros in each octet, so octets are 1–2 hex digits and
 * get zero-padded back to the canonical aa:bb:cc:dd:ee:ff form.
 */
export function parseArpOutput(out: string): ArpEntry[] {
  const entries: ArpEntry[] = []
  for (const line of out.split(/\r?\n/)) {
    let match = line.match(/([\d.]+)\s+((?:[\da-f]{2}[:-]){5}[\da-f]{2})/i)
    if (!match) {
      match = line.match(/\(([\d.]+)\)\s+at\s+((?:[\da-f]{1,2}:){5}[\da-f]{1,2})\b/i)
    }
    if (!match) continue
    const mac = match[2]
      .split(/[:-]/)
      .map((o) => o.padStart(2, '0'))
      .join(':')
      .toLowerCase()
    if (mac !== 'ff:ff:ff:ff:ff:ff' && mac !== '00:00:00:00:00:00') {
      entries.push({ ip: match[1], mac })
    }
  }
  return entries
}

async function getArpTable(): Promise<ArpEntry[]> {
  try {
    // -n skips the per-entry reverse DNS that makes `arp -a` crawl on macOS/Linux
    // (on Windows `-n` means something else, so keep plain `arp -a` there).
    const out = await run(process.platform === 'win32' ? 'arp -a' : 'arp -an')
    return parseArpOutput(out)
  } catch {
    return []
  }
}

// ── OUI vendor lookup (top vendors, embedded for zero-dependency) ────────────

const OUI_MAP: Record<string, string> = {
  '00:50:56': 'VMware', '00:0c:29': 'VMware', '00:1c:42': 'Parallels',
  '08:00:27': 'VirtualBox', '52:54:00': 'QEMU/KVM',
  'dc:a6:32': 'Raspberry Pi', 'b8:27:eb': 'Raspberry Pi', 'e4:5f:01': 'Raspberry Pi',
  '00:1a:79': 'Ubiquiti', '24:5a:4c': 'Ubiquiti', '78:8a:20': 'Ubiquiti',
  '00:18:0a': 'Cisco', '00:1b:54': 'Cisco', '00:26:cb': 'Cisco',
  'f0:9f:c2': 'Ubiquiti', '44:d9:e7': 'Ubiquiti',
  '3c:37:86': 'Netgear', 'c4:04:15': 'Netgear', 'a4:2b:8c': 'TP-Link',
  '50:c7:bf': 'TP-Link', '98:da:c4': 'TP-Link', 'b0:be:76': 'TP-Link',
  'ac:84:c6': 'TP-Link', '30:b5:c2': 'TP-Link',
  '00:17:88': 'Philips Hue', '00:1e:06': 'Wibrain',
  'f4:f5:d8': 'Google', '3c:5a:b4': 'Google', 'a4:77:33': 'Google',
  '70:3a:cb': 'Google', 'f8:8f:ca': 'Google',
  'ac:de:48': 'Apple', '00:cd:fe': 'Apple', '3c:06:30': 'Apple',
  '8c:85:90': 'Apple', 'a4:83:e7': 'Apple', 'f0:18:98': 'Apple',
  'bc:d0:74': 'Apple', '28:6c:07': 'Apple', 'f4:5c:89': 'Apple',
  '00:50:f2': 'Microsoft', '28:18:78': 'Microsoft', '7c:1e:52': 'Microsoft',
  '60:45:bd': 'Microsoft', 'b4:0e:de': 'Samsung', '00:1a:8a': 'Samsung',
  '78:47:1d': 'Samsung', 'ac:5f:3e': 'Samsung', 'c0:97:27': 'Samsung',
  'e8:50:8b': 'Samsung', '84:25:db': 'Samsung',
  'b0:72:bf': 'Amazon', '44:65:0d': 'Amazon', 'fc:65:de': 'Amazon',
  '74:c2:46': 'Amazon', 'a0:02:dc': 'Amazon',
  'e0:63:da': 'Ubiquiti', '68:72:51': 'Ubiquiti',
  '34:97:f6': 'Asus', '2c:56:dc': 'Asus', '04:d4:c4': 'Asus',
  '00:0e:8f': 'Cisco', '58:97:1e': 'Cisco', 'f8:c2:88': 'Cisco',
  'cc:46:d6': 'Cisco', '00:14:1b': 'Cisco',
  '18:e8:29': 'Intel', '48:51:b7': 'Intel', '34:13:e8': 'Intel',
  '00:15:5d': 'Hyper-V', '00:03:ff': 'Microsoft',
  'a8:6d:aa': 'Intel', '7c:b2:7d': 'Intel',
  '2c:f0:5d': 'Dell', 'f8:db:88': 'Dell', '00:14:22': 'Dell',
  '98:90:96': 'Dell', 'b0:83:fe': 'Dell',
  '30:9c:23': 'Belkin', 'ec:1a:59': 'Belkin',
  '00:24:e4': 'Huawei', '70:72:3c': 'Huawei', '48:46:fb': 'Huawei',
  '00:e0:fc': 'Huawei', 'cc:a2:23': 'Huawei'
}

function lookupVendorLocal(mac: string): string | null {
  const prefix = mac.substring(0, 8).toLowerCase()
  return OUI_MAP[prefix] ?? null
}

/** Check if a MAC is locally administered (randomized by iOS 14+, Android 10+, Win 10+) */
function isRandomizedMac(mac: string): boolean {
  const firstOctet = parseInt(mac.substring(0, 2), 16)
  return (firstOctet & 0x02) !== 0 // bit 1 of first octet = locally administered
}

// ── Online MAC vendor lookup (macvendors.com) ────────────────────────────────

const vendorCache = new Map<string, string | null>()

function fetchMacVendor(mac: string): Promise<string | null> {
  const prefix = mac.substring(0, 8)
  if (vendorCache.has(prefix)) return Promise.resolve(vendorCache.get(prefix)!)

  return new Promise((resolve) => {
    const req = https.get(`https://api.macvendors.com/${encodeURIComponent(prefix)}`, {
      timeout: 3000
    }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString() })
      res.on('end', () => {
        if (res.statusCode === 200 && body.length > 0 && body.length < 200) {
          vendorCache.set(prefix, body.trim())
          resolve(body.trim())
        } else {
          vendorCache.set(prefix, null)
          resolve(null)
        }
      })
    })
    req.on('error', () => { vendorCache.set(prefix, null); resolve(null) })
    req.on('timeout', () => { req.destroy(); vendorCache.set(prefix, null); resolve(null) })
  })
}

/** Lookup vendor: local OUI table first, then online API for non-randomized MACs */
async function lookupVendor(mac: string): Promise<string | null> {
  // Local table first (instant)
  const local = lookupVendorLocal(mac)
  if (local) return local

  // Don't bother with API for randomized MACs — they have no real OUI
  if (isRandomizedMac(mac)) return null

  // Online lookup with rate limiting (1 req/sec for macvendors.com free tier)
  return fetchMacVendor(mac)
}

// ── Device type inference ────────────────────────────────────────────────────

const PHONE_PATTERNS = [
  /iphone/i, /galaxy/i, /pixel/i, /redmi/i, /oneplus/i, /huawei/i,
  /s-s\d+/i,     // "Linh-s-S25" → Samsung S25
  /s-a\d+/i,     // "Nhi-s-A13", "Nhi-s-A56" → Samsung A-series
  /SM-[A-Z]/i,   // Samsung model numbers
  /^android/i, /phone/i
]
const TABLET_PATTERNS = [/ipad/i, /tab/i, /surface/i, /kindle/i]
const LAPTOP_PATTERNS = [/laptop/i, /macbook/i, /notebook/i, /^DESKTOP-/i, /thinkpad/i]
const CAMERA_PATTERNS = [/ezviz/i, /C6N/i, /hikvision/i, /cam/i, /dahua/i, /reolink/i, /ring/i, /nest.?cam/i, /arlo/i]
const ROUTER_PATTERNS = [/covr/i, /router/i, /gateway/i, /dlink/i, /netgear/i, /asus.?rt/i, /tp-?link/i, /linksys/i]
const IOT_PATTERNS = [/espressif/i, /esp32/i, /esp8266/i, /tuya/i, /sonoff/i, /shelly/i, /tasmota/i, /smartplug/i, /smart.?home/i]
const MEDIA_PATTERNS = [/roku/i, /chromecast/i, /fire.?tv/i, /apple.?tv/i, /nvidia.?shield/i, /playstation/i, /xbox/i, /nintendo/i]
const PRINTER_PATTERNS = [/printer/i, /brother/i, /epson/i, /canon.*print/i, /HP.*jet/i]
const SERVER_PATTERNS = [/nas/i, /synology/i, /qnap/i, /server/i, /truenas/i, /unraid/i]
const MAC_DEVICE_PATTERNS = [/^mac$/i, /^macbook/i, /imac/i]

function inferDeviceType(hostname: string | null, vendor: string | null, isGw: boolean): DeviceType {
  if (isGw) return 'router'
  const combined = [hostname ?? '', vendor ?? ''].join(' ')

  if (ROUTER_PATTERNS.some((p) => p.test(combined))) return 'router'
  if (CAMERA_PATTERNS.some((p) => p.test(combined))) return 'camera'
  if (PRINTER_PATTERNS.some((p) => p.test(combined))) return 'printer'
  if (SERVER_PATTERNS.some((p) => p.test(combined))) return 'server'
  if (MEDIA_PATTERNS.some((p) => p.test(combined))) return 'media'
  if (IOT_PATTERNS.some((p) => p.test(combined))) return 'iot'
  if (TABLET_PATTERNS.some((p) => p.test(combined))) return 'tablet'
  if (PHONE_PATTERNS.some((p) => p.test(combined))) return 'phone'
  if (LAPTOP_PATTERNS.some((p) => p.test(combined))) return 'laptop'
  if (MAC_DEVICE_PATTERNS.some((p) => p.test(hostname ?? ''))) return 'laptop'

  // Vendor-based fallback
  if (/samsung/i.test(vendor ?? '')) return 'phone'
  if (/apple/i.test(vendor ?? '')) return 'laptop'
  if (/ezviz|hikvision|dahua/i.test(vendor ?? '')) return 'camera'
  if (/espressif|tuya/i.test(vendor ?? '')) return 'iot'
  if (/d-link|tp-link|netgear|asus|ubiquiti|cisco/i.test(vendor ?? '')) return 'router'
  if (/intel|dell|lenovo|hp|acer|asus/i.test(vendor ?? '')) return 'laptop'

  return 'unknown'
}

/** Infer vendor name from hostname when MAC-based lookup fails (randomized MACs) */
function inferVendorFromHostname(hostname: string | null): string | null {
  if (!hostname) return null
  const h = hostname

  // Samsung patterns: "Linh-s-S25", "Nhi-s-A13", "Galaxy-S24", "SM-A546"
  if (/s-[sa]\d+/i.test(h) || /galaxy/i.test(h) || /SM-[A-Z]/i.test(h)) return 'Samsung'

  // Apple patterns
  if (/iphone/i.test(h)) return 'Apple (iPhone)'
  if (/ipad/i.test(h)) return 'Apple (iPad)'
  if (/macbook/i.test(h)) return 'Apple (MacBook)'
  if (/^mac$/i.test(h) || /imac/i.test(h)) return 'Apple'
  if (/apple.?tv/i.test(h)) return 'Apple (TV)'

  // Camera brands
  if (/ezviz|C6N/i.test(h)) return 'EZVIZ'
  if (/hikvision/i.test(h)) return 'Hikvision'
  if (/dahua/i.test(h)) return 'Dahua'
  if (/reolink/i.test(h)) return 'Reolink'
  if (/arlo/i.test(h)) return 'Arlo'

  // Router brands
  if (/covr/i.test(h)) return 'D-Link'
  if (/netgear/i.test(h)) return 'Netgear'
  if (/tp-?link/i.test(h)) return 'TP-Link'
  if (/linksys/i.test(h)) return 'Linksys'
  if (/asus.?rt/i.test(h)) return 'ASUS'

  // IoT
  if (/espressif/i.test(h)) return 'Espressif'
  if (/shelly/i.test(h)) return 'Shelly'
  if (/sonoff/i.test(h)) return 'Sonoff'
  if (/tuya/i.test(h)) return 'Tuya'

  // Other
  if (/pixel/i.test(h)) return 'Google (Pixel)'
  if (/chromecast/i.test(h)) return 'Google (Chromecast)'
  if (/redmi|xiaomi/i.test(h)) return 'Xiaomi'
  if (/oneplus/i.test(h)) return 'OnePlus'
  if (/huawei/i.test(h)) return 'Huawei'
  if (/roku/i.test(h)) return 'Roku'
  if (/fire.?tv/i.test(h)) return 'Amazon'
  if (/playstation/i.test(h)) return 'Sony'
  if (/xbox/i.test(h)) return 'Microsoft'
  if (/nintendo/i.test(h)) return 'Nintendo'
  if (/synology/i.test(h)) return 'Synology'
  if (/qnap/i.test(h)) return 'QNAP'
  if (/brother/i.test(h)) return 'Brother'
  if (/epson/i.test(h)) return 'Epson'
  if (/thinkpad/i.test(h)) return 'Lenovo'

  return null
}

/**
 * macOS (15+): without Local Network permission the kernel redacts link-layer
 * addresses for this app — our own interfaces report 02:00:00:00:00:00 and
 * `arp -an` (run as our child) returns no neighbours at all.
 */
function macLocalNetworkBlocked(ifaces: NetworkInterface[]): boolean {
  if (process.platform !== 'darwin') return false
  return ifaces.some((i) => (i.type === 'wifi' || i.type === 'ethernet') && i.mac === '02:00:00:00:00:00')
}

// ── Ping sweep (fills ARP cache) ─────────────────────────────────────────────

async function pingSweep(cidr: string): Promise<void> {
  const parts = cidr.split('/')
  const baseIp = parts[0]
  const prefix = parseInt(parts[1])
  if (prefix < 24) return // Don't sweep large subnets

  const base = baseIp.split('.').slice(0, 3).join('.')
  const count = Math.pow(2, 32 - prefix)
  const maxHosts = Math.min(count - 2, 254)

  // Parallel ping (fire and forget, just to populate ARP)
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const batchSize = 50
  for (let start = 1; start <= maxHosts; start += batchSize) {
    const end = Math.min(start + batchSize - 1, maxHosts)
    const promises: Promise<void>[] = []
    for (let i = start; i <= end; i++) {
      const ip = `${base}.${i}`
      // Wait units: Windows -w and macOS -W are milliseconds, Linux -W is seconds.
      const args = isWin
        ? ['-n', '1', '-w', '200', ip]
        : isMac
          ? ['-n', '-c', '1', '-W', '300', ip]
          : ['-c', '1', '-W', '1', ip]
      promises.push(runSpawn('ping', args, 3000).then(() => {}).catch(() => {}))
    }
    await Promise.all(promises)
  }
}

// ── Main scan function ───────────────────────────────────────────────────────

export async function scanLan(): Promise<LanScanResult> {
  const start = Date.now()

  // 1. Enumerate local interfaces
  const osIfaces = networkInterfaces()
  const [gateway, hardwarePorts] = await Promise.all([getDefaultGateway(), getHardwarePorts()])
  const ifaces: NetworkInterface[] = []
  const selfIps = new Set<string>()

  for (const [name, addrs] of Object.entries(osIfaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      const type = classifyInterface(name, addr.address, hardwarePorts.get(name))
      if (type === 'loopback') continue
      selfIps.add(addr.address)
      ifaces.push({
        name,
        ip: addr.address,
        mac: addr.mac,
        netmask: addr.netmask,
        gateway,
        type,
        cidr: cidrFromMask(addr.address, addr.netmask)
      })
    }
  }

  // 2. Ping sweep to populate ARP cache
  const primaryIface = ifaces.find((i) => i.type === 'ethernet' || i.type === 'wifi') ?? ifaces[0]
  if (primaryIface) {
    await pingSweep(primaryIface.cidr)
  }

  // 3. Read ARP table
  const arpEntries = await getArpTable()

  // 4. Filter to same subnet only
  const subnets = ifaces.map((i) => i.cidr)
  const filteredEntries = arpEntries.filter((entry) =>
    subnets.some((cidr) => ipInSubnet(entry.ip, cidr))
  )

  // 5. Resolve hostnames + vendors and build device list
  const devices: LanDevice[] = []
  const resolvePromises = filteredEntries.map(async (entry) => {
    const [hostname, vendor] = await Promise.all([
      resolveHostname(entry.ip, gateway),
      lookupVendor(entry.mac)
    ])
    const isGw = entry.ip === gateway
    const randomized = isRandomizedMac(entry.mac)
    const resolvedVendor = vendor ?? inferVendorFromHostname(hostname)
    devices.push({
      ip: entry.ip,
      mac: entry.mac,
      hostname,
      vendor: resolvedVendor,
      deviceType: inferDeviceType(hostname, resolvedVendor, isGw),
      isRandomizedMac: randomized,
      responseTimeMs: null,
      isGateway: isGw,
      isSelf: selfIps.has(entry.ip)
    })
  })
  await Promise.all(resolvePromises)

  // Also add self devices that aren't in ARP (use os.hostname())
  const selfHostname = osHostname() || null
  for (const iface of ifaces) {
    if (!devices.some((d) => d.ip === iface.ip)) {
      const macVendor = await lookupVendor(iface.mac)
      const selfVendor = macVendor ?? inferVendorFromHostname(selfHostname)
      devices.push({
        ip: iface.ip,
        mac: iface.mac,
        hostname: selfHostname,
        vendor: selfVendor,
        deviceType: inferDeviceType(selfHostname, selfVendor, false),
        isRandomizedMac: isRandomizedMac(iface.mac),
        responseTimeMs: null,
        isGateway: false,
        isSelf: true
      })
    }
  }

  // Sort: gateway first, then self, then by IP
  devices.sort((a, b) => {
    if (a.isGateway !== b.isGateway) return a.isGateway ? -1 : 1
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
    return a.ip.localeCompare(b.ip, undefined, { numeric: true })
  })

  const vpnInterfaces = ifaces.filter((i) => i.type === 'vpn' || i.type === 'warp')

  return {
    interfaces: ifaces,
    devices,
    vpnDetected: vpnInterfaces.length > 0,
    vpnInterfaces,
    scanDurationMs: Date.now() - start,
    notice: macLocalNetworkBlocked(ifaces)
      ? 'macOS is hiding other devices because nmtr does not have Local Network access. ' +
        'Allow it in System Settings → Privacy & Security → Local Network, then rescan.'
      : null
  }
}
