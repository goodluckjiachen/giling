import { execFileSync } from "node:child_process";

const ACC = process.env.ACCOUNT_ID;
const ZONE = process.env.ZONE_ID;
const DOMAIN = process.env.DOMAIN;
const TUNNEL_ID = process.env.TUNNEL_ID;
const SCRIPT = "vnc-panel";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_EMAIL = process.env.CLOUDFLARE_EMAIL;
const BASE = "https://api.cloudflare.com/client/v4";

const headers = {
  Authorization: `Bearer ${CF_TOKEN}`,
  "X-Auth-Email": CF_EMAIL,
  "Content-Type": "application/json",
};

async function api(path, { method = "GET", body } = {}) {
  let lastErr;
  for (let i = 1; i <= 5; i++) {
    try {
      const res = await fetch(`${BASE}/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!res.ok || (json && json.success === false)) {
        throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify((json && json.errors) || text.slice(0, 200))}`);
      }
      return json ? json.result : null;
    } catch (e) {
      lastErr = e;
      console.log(`  attempt ${i} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

function run(file, args, opts = {}) {
  console.log(`\n$ ${file} ${args.join(" ")}`);
  execFileSync(file, args, { stdio: "inherit", ...opts });
}

function setSecret(name, value) {
  execFileSync("npx", ["--yes", "wrangler@latest", "secret", "put", name], {
    cwd: "panel",
    input: String(value),
    stdio: ["pipe", "inherit", "inherit"],
    env: process.env,
  });
  console.log(`worker secret set: ${name}`);
}

async function main() {
  if (!CF_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN missing");
  if (!CF_EMAIL) throw new Error("CLOUDFLARE_EMAIL missing");
  const vnc = `vnc.${DOMAIN}`;
  const panel = `panel.${DOMAIN}`;
  console.log(`domain=${DOMAIN} vnc=${vnc} panel=${panel}`);

  console.log("\n[1/6] locate tunnel");
  const tunnels = await api(`/accounts/${ACC}/cfd_tunnel`);
  const tunnel =
    (tunnels || []).find((t) => t.id === TUNNEL_ID) ||
    (tunnels || []).find((t) => t.name === "vnc");
  if (!tunnel) throw new Error("vnc tunnel not found");
  const tid = tunnel.id;
  console.log(`tunnel: ${tid} (${tunnel.name}, ${tunnel.status})`);

  console.log("\n[2/6] set tunnel ingress");
  await api(`/accounts/${ACC}/cfd_tunnel/${tid}/configurations`, {
    method: "PUT",
    body: {
      config: {
        ingress: [
          { hostname: vnc, service: "http://localhost:6080" },
          { service: "http_status:404" },
        ],
        "warp-routing": { enabled: false },
      },
    },
  });
  console.log(`ingress: ${vnc} -> http://localhost:6080`);

  console.log("\n[3/6] ensure vnc DNS");
  const cnameTarget = `${tid}.cfargotunnel.com`;
  const recs = await api(`/zones/${ZONE}/dns_records?per_page=100`);
  const existing = (recs || []).find((r) => r.name === vnc);
  if (existing && existing.type === "CNAME" && existing.content === cnameTarget && existing.proxied) {
    console.log(`vnc DNS ok: ${vnc} -> ${cnameTarget}`);
  } else if (existing) {
    await api(`/zones/${ZONE}/dns_records/${existing.id}`, {
      method: "PUT",
      body: { type: "CNAME", name: vnc, content: cnameTarget, proxied: true, ttl: 1 },
    });
    console.log(`vnc DNS updated`);
  } else {
    await api(`/zones/${ZONE}/dns_records`, {
      method: "POST",
      body: { type: "CNAME", name: vnc, content: cnameTarget, proxied: true, ttl: 1 },
    });
    console.log(`vnc DNS created`);
  }

  console.log("\n[4/6] deploy worker (wrangler)");
  run("npx", ["--yes", "wrangler@latest", "deploy"], { cwd: "panel", env: process.env });

  console.log("\n[5/6] set worker secrets");
  setSecret("PANEL_PASSWORD", process.env.PANEL_PASSWORD);
  setSecret("GH_TOKEN", process.env.GH_TOKEN);

  console.log("\n[6/6] worker custom domain for panel");
  try {
    await api(`/accounts/${ACC}/workers/domains`, {
      method: "POST",
      body: {
        environment: "production",
        hostname: panel,
        service: SCRIPT,
        zone_id: ZONE,
      },
    });
    console.log(`panel custom domain: ${panel}`);
  } catch (e) {
    console.log(`custom domain API failed (${e.message}); trying route + DNS`);
    const prec = (recs || []).find((r) => r.name === panel);
    if (!prec) {
      try {
        await api(`/zones/${ZONE}/dns_records`, {
          method: "POST",
          body: { type: "A", name: panel, content: "192.0.2.1", proxied: true, ttl: 1, comment: "worker route placeholder" },
        });
      } catch (e2) {
        console.log(`panel DNS create: ${e2.message}`);
      }
    }
    try {
      await api(`/zones/${ZONE}/workers/routes`, {
        method: "POST",
        body: { pattern: `${panel}/*`, script: SCRIPT },
      });
      console.log(`panel route created`);
    } catch (e2) {
      console.log(`panel route: ${e2.message} (may already exist)`);
    }
  }

  console.log("\n===== SETUP DONE =====");
  console.log(`VNC:   https://${vnc}/vnc.html`);
  console.log(`Panel: https://${panel}/`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
