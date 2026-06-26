// prototype/doctor.mjs — `pnpm doctor`: a host-side connectivity check.
// Answers the four questions behind "the server won't open / we can't connect":
//   1. Can I even bind HOST:PORT, or is it taken / already running?
//   2. Which IPv4 addresses do I have, and is each one reachable from OFF this box?
//   3. Is the port loopback-only (the #1 silent failure)?
//   4. What URL do I actually share — and if none is reachable, what do I run instead?
// Dependency-free, cross-platform Node (no ss/ip/netstat — absent here and on Windows).
import { networkInterfaces } from 'node:os';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';

const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 8788);

// Classify an IPv4 into how a peer can reach it. Order matters: the narrow
// VM-NAT / link-local / CGNAT checks come before the broad RFC1918 "lan" check.
function classify(ip) {
  if (ip.startsWith('127.') || ip === '::1') return ['loopback', 'this machine only'];
  if (ip.startsWith('10.0.2.') || ip.startsWith('10.0.3.'))
    return ['vm-nat', 'VirtualBox/QEMU NAT — NOT reachable from other devices'];
  if (ip.startsWith('169.254.')) return ['link-local', 'no DHCP/router — NOT routable'];
  const [a, b] = ip.split('.').map(Number);
  if (a === 100 && b >= 64 && b <= 127)
    return ['cgnat', 'carrier-grade NAT — NOT reachable inbound from the internet'];
  if (ip.startsWith('192.168.') || ip.startsWith('10.') || (a === 172 && b >= 16 && b <= 31))
    return ['lan', 'reachable by devices on the SAME LAN (not across the internet)'];
  return ['public', 'routable from the internet'];
}

// Try to bind HOST:PORT to prove the port is free (and detect a stale server).
function probeBind() {
  return new Promise((resolve) => {
    const s = createTcpServer();
    s.once('error', (e) => resolve({ ok: false, code: e.code }));
    s.listen(PORT, HOST, () => s.close(() => resolve({ ok: true })));
  });
}

// If something is ALREADY listening (EADDRINUSE), it may be our own server —
// hit /health on loopback to confirm it's the proto-server and it answers.
function probeHealth() {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, path: '/health', method: 'GET', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ ok: res.statusCode === 200, body: body.slice(0, 120) }));
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

const ipv4 = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);

const bind = await probeBind();
const out = ['', 'Void Dominion — host doctor', ''];

if (bind.ok) {
  out.push(`  port    : ${HOST}:${PORT} is free and bindable  [ok]`);
} else if (bind.code === 'EADDRINUSE') {
  const health = await probeHealth();
  out.push(
    health && health.ok
      ? `  port    : ${HOST}:${PORT} in use by a server that answers /health  [ok — already running]`
      : `  port    : ${HOST}:${PORT} in use (EADDRINUSE) by something else  [WARN] — stop it or set PORT=<n>`,
  );
} else {
  out.push(`  port    : cannot bind ${HOST}:${PORT} (${bind.code})  [WARN]`);
}

if (HOST === '127.0.0.1' || HOST === 'localhost') {
  out.push(
    '  bind    : HOST is loopback-only — OTHER DEVICES CANNOT CONNECT.',
    '            Use `pnpm host` (binds 0.0.0.0), or set HOST=0.0.0.0.',
  );
}

out.push('', '  interfaces:');
if (ipv4.length === 0) {
  out.push('   • (none) — no non-loopback IPv4; only localhost works. Use a tunnel.');
}
for (const ip of ipv4) {
  const [kind, note] = classify(ip);
  const flag = kind === 'lan' || kind === 'public' ? 'ok  ' : 'WARN';
  out.push(`   • [${flag}] ${ip}  (${kind}: ${note})`);
}

const sameLan = ipv4.find((ip) => classify(ip)[0] === 'lan');
const publicIp = ipv4.find((ip) => classify(ip)[0] === 'public');
out.push('');
if (publicIp) {
  out.push(`  share   : http://${publicIp}:${PORT}/   (friend opens this → Connect → Crimson/p2)`);
} else if (sameLan) {
  out.push(
    `  share   : http://${sameLan}:${PORT}/   (SAME-LAN devices only → Connect → Crimson/p2)`,
    `            A friend on another network can't use this — run a tunnel instead:`,
    `              cloudflared tunnel --url http://localhost:${PORT}   (share the wss:// URL)`,
  );
} else {
  out.push(
    '  share   : no reachable LAN/public address (loopback / VM-NAT / link-local only).',
    `            For a friend on another network, run a tunnel and share its wss:// URL:`,
    `              cloudflared tunnel --url http://localhost:${PORT}   (or: ngrok http ${PORT})`,
  );
}
out.push('');
process.stdout.write(out.join('\n') + '\n');
