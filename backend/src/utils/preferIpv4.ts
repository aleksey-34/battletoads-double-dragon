import dns from 'dns';

/**
 * WEEX (and some other dual-stack APIs) bind API keys to IPv4.
 * Node's default Happy Eyeballs / AAAA-first egress uses our VPS IPv6
 * (2a02:c206:2068:95::1), which is usually NOT on the key whitelist → -1056 Invalid IP.
 * Prefer A records so outbound matches the documented VPS IPv4 176.57.184.98.
 */
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Node < 16.13 — ignore
}
