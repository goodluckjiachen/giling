const SESSION_LABEL = "panel-session-v1";
const COOKIE_NAME = "panel_session";

function enc(t) {
  return new TextEncoder().encode(t);
}

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey(
    "raw",
    enc(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc(msg));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function expectedSession(env) {
  return hmacHex(env.PANEL_PASSWORD || "", SESSION_LABEL);
}

function parseCookies(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      out[k] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

async function isAuthed(request, env) {
  return parseCookies(request.headers.get("cookie") || "")[COOKIE_NAME] === (await expectedSession(env));
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

async function gh(env, path, method = "GET", body) {
  const res = await fetch(`https://api.github.com/repos/${env.OWNER}/${env.REPO}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "vnc-panel",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function findRunningRun(env) {
  const { workflow_runs } = await gh(env, "actions/runs");
  return workflow_runs.find((r) => r.name === "vnc-desktop" && r.status === "in_progress");
}

function loginHtml() {
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>noVNC 控制台 · 登录</title>
<style>
body{font-family:system-ui,sans-serif;max-width:360px;margin:80px auto;padding:0 16px;color:#222}
input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box;font-size:15px}
button{width:100%;padding:10px;font-size:15px;background:#2563eb;color:#fff;border:0;border-radius:6px;cursor:pointer}
#m{color:#c00;margin-top:8px;font-size:14px}
</style></head><body>
<h2>noVNC 控制台</h2>
<form id="f">
  <input id="pw" type="password" placeholder="面板密码" autofocus>
  <button type="submit">登录</button>
  <div id="m"></div>
</form>
<script>
document.getElementById('f').onsubmit=async(e)=>{
  e.preventDefault();
  const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
  if(r.ok){location.reload();}else{document.getElementById('m').textContent='密码错误';}
};
</script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function panelHtml(vncUrl) {
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>noVNC 控制台</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222;line-height:1.5}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0;align-items:center}
button,.btn{font-size:15px;padding:10px 22px;border:1px solid #bbb;border-radius:6px;background:#fff;color:#222;cursor:pointer;text-decoration:none;display:inline-block}
.primary{background:#2563eb;color:#fff;border-color:#2563eb}
.btn{background:#059669;color:#fff;border-color:#059669}
.box,.out{padding:10px 14px;border:1px solid #ddd;border-radius:6px;background:#f7f7f7}
pre.out{white-space:pre-wrap;min-height:1em}
</style></head><body>
<h2>noVNC 控制台</h2>
<div id="status" class="box">检查中…</div>
<div class="row">
 <button id="start" class="primary">启动</button>
 <button id="stop">停止</button>
 <a class="btn" href="${vncUrl}" target="_blank" rel="noopener">打开桌面</a>
</div>
<pre id="out" class="out"></pre>
<script>
async function act(path){
  document.getElementById('out').textContent='…';
  try{const r=await fetch(path,{method:'POST'});document.getElementById('out').textContent=JSON.stringify(await r.json(),null,2);}
  catch(e){document.getElementById('out').textContent=String(e);}
  refresh();
}
async function refresh(){
  try{const s=await(await fetch('/status')).json();
    document.getElementById('status').textContent=s.running
      ?'运行中 · run '+s.run_id+' · 启动于 '+new Date(s.started_at).toLocaleString()
      :'未运行';
  }catch(e){document.getElementById('status').textContent='状态获取失败';}
}
document.getElementById('start').onclick=()=>act('/start');
document.getElementById('stop').onclick=()=>act('/stop');
refresh();
</script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/login" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "bad json" }, 400);
      }
      if (!env.PANEL_PASSWORD || body.password !== env.PANEL_PASSWORD) {
        return json({ ok: false, error: "wrong password" }, 401);
      }
      return json({ ok: true }, 200, {
        "set-cookie": `${COOKIE_NAME}=${await expectedSession(env)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      });
    }

    if (request.method === "GET" && url.pathname !== "/status") {
      return (await isAuthed(request, env)) ? panelHtml(env.VNC_URL) : loginHtml();
    }

    if (!(await isAuthed(request, env))) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    try {
      if (url.pathname === "/status") {
        const run = await findRunningRun(env);
        return json({
          running: Boolean(run),
          run_id: run?.id,
          html_url: run?.html_url,
          started_at: run?.created_at,
          vnc: env.VNC_URL,
        });
      }
      if (url.pathname === "/start") {
        const running = await findRunningRun(env);
        if (running) return json({ ok: true, message: "already running", run_id: running.id });
        await gh(env, `actions/workflows/${env.WORKFLOW}/dispatches`, "POST", { ref: env.REF });
        return json({ ok: true, message: "dispatched", vnc: env.VNC_URL });
      }
      if (url.pathname === "/stop") {
        const run = await findRunningRun(env);
        if (!run) return json({ ok: true, message: "nothing running" });
        await gh(env, `actions/runs/${run.id}/cancel`, "POST");
        return json({ ok: true, message: "cancel requested", run_id: run.id });
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err) }, 502);
    }
  },
};
