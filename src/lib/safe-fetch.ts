import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// Outbound requests to addresses the household typed in (calendar links) or
// that came back from a book search (cover images). The address check runs
// inside the socket's DNS lookup, so the IP that was checked is the IP that is
// connected to: a hostname cannot pass the check and then re-resolve to a LAN
// address (DNS rebinding).

// Separate lists per family: Node's BlockList treats IPv4 and IPv4-mapped IPv6
// as the same address, so a ::ffff:0:0/96 rule in a shared list would block
// every IPv4 address.
const blockedV4 = new net.BlockList();
const blockedV6 = new net.BlockList();
const mappedV4 = new net.BlockList();
mappedV4.addSubnet("::ffff:0:0", 96, "ipv6");
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  // Unspecified (::), loopback (::1) and deprecated IPv4-compatible
  // (::a.b.c.d), which can embed a private IPv4. Does not overlap the
  // IPv4-mapped ::ffff:0:0/96 that is handled in its own list above.
  ["::", 96],
  ["64:ff9b::", 96], // NAT64 can embed a private IPv4
  ["64:ff9b:1::", 48], // local-use NAT64 (RFC 8215)
  ["100::", 64],
  ["2001::", 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 can embed a private IPv4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedV6.addSubnet(prefix, bits, "ipv6");
}

export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !blockedV4.check(ip, "ipv4");
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is never needed for a public feed.
  if (family === 6) return !mappedV4.check(ip, "ipv6") && !blockedV6.check(ip, "ipv6");
  return false;
}

export class SafeFetchError extends Error {}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** The socket's DNS lookup. Exported for tests; safeGet is the only caller. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      return callback(new SafeFetchError("That address points at a private network"), "", 0);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

export interface SafeResponse {
  status: number;
  contentType: string;
  location: string | null;
  body: Buffer;
}

export interface SafeGetOptions {
  maxBytes: number;
  timeoutMs: number;
  /** Plain http is allowed only where the caller opts in. */
  allowHttp?: boolean;
  accept?: string;
}

/** safeGet's shape, so callers can take a stand-in in tests. */
export type SafeGetter = (url: string, opts: SafeGetOptions) => Promise<SafeResponse>;

/**
 * GET a public URL with no redirect following, a byte cap and a timeout.
 * Throws SafeFetchError for private targets, oversized bodies and bad URLs.
 */
export function safeGet(rawUrl: string, opts: SafeGetOptions): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.reject(new SafeFetchError("Not a valid link"));
  }
  const isHttps = url.protocol === "https:";
  if (!isHttps && !(opts.allowHttp && url.protocol === "http:")) {
    return Promise.reject(new SafeFetchError(opts.allowHttp ? "Link must be http or https" : "Link must be https"));
  }
  if (url.username || url.password) {
    return Promise.reject(new SafeFetchError("Links with a username or password are not allowed"));
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) {
    return Promise.reject(new SafeFetchError("That address points at a private network"));
  }
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return Promise.reject(new SafeFetchError("Link must be a public address"));
  }

  const client = isHttps ? https : http;
  return new Promise<SafeResponse>((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup as unknown as net.LookupFunction,
        headers: { "User-Agent": "Sproutwall (+https://github.com/thebrianlee/sproutwall)", Accept: opts.accept ?? "*/*" },
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          reject(new SafeFetchError("Response is too large"));
          return;
        }
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            res.destroy();
            reject(new SafeFetchError("Response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            location: typeof res.headers.location === "string" ? res.headers.location : null,
            body: Buffer.concat(chunks),
          })
        );
        res.on("error", reject);
      }
    );
    const deadline = setTimeout(() => req.destroy(new SafeFetchError("Request timed out")), opts.timeoutMs);
    req.on("timeout", () => req.destroy(new SafeFetchError("Request timed out")));
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.on("close", () => clearTimeout(deadline));
    req.end();
  });
}
