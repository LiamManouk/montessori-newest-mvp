const ALLOWED_ORIGIN = "https://liammanouk.github.io";
const RATE_LIMIT = 20;
const JSONBIN_BIN_ID = "6a2c3719da38895dfeb60209";
const KITA_DIRECTORY_BIN_ID = "6a328c9ada38895dfecfe3c3";
const ADMIN_PASSWORD = "passt";

// Bot-Erkennung: echte App-Geräte haben immer "dev_"-Prefix
function detectBot(deviceId, userAgent) {
  const signals = [];
  if (!deviceId || deviceId === "unknown") signals.push("no_device_id");
  if (deviceId && !deviceId.startsWith("dev_")) signals.push("invalid_device_format");
  if (!userAgent || userAgent.includes("curl") || userAgent.includes("python") || userAgent.includes("bot")) signals.push("bot_ua");
  return { is_bot: signals.length >= 1, signals };
}

export default {
  async fetch(request, env) {

    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, anthropic-version, x-api-key, x-device-id, x-feedback, anthropic-beta, x-admin-password",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { "Content-Type": "application/json", ...corsHeaders }
    });

    try {
      const url = new URL(request.url);

      // ── FEEDBACK ──────────────────────────────────────────────
      if (url.pathname === "/feedback") {
        const body = await request.json();
        const existing = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
          headers: { "X-Master-Key": env.JSONBIN_API_KEY }
        });
        const existingData = await existing.json();
        const feedbacks = existingData.record?.feedback || [];
        feedbacks.push({
          datum: new Date().toISOString(),
          device_id: body.device_id || "unbekannt",
          frage: body.frage || "",
          antwort: body.antwort || "",
          bewertung: body.bewertung || "",
          kommentar: body.kommentar || ""
        });
        await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Master-Key": env.JSONBIN_API_KEY },
          body: JSON.stringify({ feedback: feedbacks })
        });
        return json({ ok: true });
      }

      // ── EMAIL SPEICHERN ───────────────────────────────────────
      if (url.pathname === "/save-email") {
        const body = await request.json();
        const email = (body.email || "").trim().toLowerCase();
        if (!email || !email.includes("@")) return json({ ok: false, error: "Ungültige E-Mail." }, 400);

        const existing = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
          headers: { "X-Master-Key": env.JSONBIN_API_KEY }
        });
        const existingData = await existing.json();
        const emails = existingData.record?.emails || [];

        if (!emails.includes(email)) {
          emails.push(email);
          const record = Object.assign({}, existingData.record, { emails });
          await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-Master-Key": env.JSONBIN_API_KEY },
            body: JSON.stringify(record)
          });
        }
        return json({ ok: true });
      }

      // ── STATS (Admin) ─────────────────────────────────────────
      if (url.pathname === "/stats") {
        const pw = request.headers.get("x-admin-password") || "";
        if (pw !== ADMIN_PASSWORD) return json({ ok: false, error: "Nicht autorisiert." }, 401);

        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

        const [
          totalDevices,
          todayNew,
          yesterdayNew,
          todayRequests,
          todayBots,
          todayKita,
          weekRequests
        ] = await Promise.all([
          env.RATE_STORE.get("stats:devices:total"),
          env.RATE_STORE.get(`stats:devices:new:${today}`),
          env.RATE_STORE.get(`stats:devices:new:${yesterday}`),
          env.RATE_STORE.get(`stats:requests:${today}`),
          env.RATE_STORE.get(`stats:bots:${today}`),
          env.RATE_STORE.get(`stats:kita_requests:${today}`),
          env.RATE_STORE.get(`stats:requests:${weekAgo}`)
        ]);

        // Letzte 7 Tage aufaddieren
        const days = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
          const [reqs, bots, newD] = await Promise.all([
            env.RATE_STORE.get(`stats:requests:${d}`),
            env.RATE_STORE.get(`stats:bots:${d}`),
            env.RATE_STORE.get(`stats:devices:new:${d}`)
          ]);
          days.push({ date: d, requests: parseInt(reqs || 0), bots: parseInt(bots || 0), new_devices: parseInt(newD || 0) });
        }

        return json({
          ok: true,
          total_devices: parseInt(totalDevices || 0),
          today_new_devices: parseInt(todayNew || 0),
          yesterday_new_devices: parseInt(yesterdayNew || 0),
          today_requests: parseInt(todayRequests || 0),
          today_bots: parseInt(todayBots || 0),
          today_kita_requests: parseInt(todayKita || 0),
          days
        });
      }

      // ── KITA-ADMIN ────────────────────────────────────────────
      if (url.pathname === "/kita-admin") {
        const body = await request.json();
        const pw = request.headers.get("x-admin-password") || "";
        if (pw !== ADMIN_PASSWORD) return json({ ok: false, error: "Nicht autorisiert." }, 401);

        const action = body.action;

        const loadDir = async () => {
          const r = await fetch(`https://api.jsonbin.io/v3/b/${KITA_DIRECTORY_BIN_ID}/latest`, {
            headers: { "X-Master-Key": env.JSONBIN_API_KEY }
          });
          const d = await r.json();
          return Array.isArray(d.record?.kitas) ? d.record.kitas : [];
        };

        const saveDir = async (kitas) => {
          await fetch(`https://api.jsonbin.io/v3/b/${KITA_DIRECTORY_BIN_ID}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-Master-Key": env.JSONBIN_API_KEY },
            body: JSON.stringify({ kitas })
          });
        };

        if (action === "create") {
          const { name, approach, philosophy, max_nutzer } = body;
          if (!name) return json({ ok: false, error: "Name fehlt." }, 400);
          const kitas = await loadDir();
          if (kitas.some(k => k.name.toLowerCase() === name.toLowerCase())) {
            return json({ ok: false, error: "Dieser Name ist schon vergeben." }, 400);
          }
          const record = { name, approach: approach || "", philosophy: philosophy || "", max_nutzer: max_nutzer || 50, registrierte_geraete: [] };
          const r = await fetch("https://api.jsonbin.io/v3/b", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Master-Key": env.JSONBIN_API_KEY, "X-Bin-Name": name, "X-Private": "false" },
            body: JSON.stringify(record)
          });
          const d = await r.json();
          if (!r.ok) return json({ ok: false, error: d.message || "Fehler beim Erstellen." }, 500);
          kitas.push({ name, binId: d.metadata.id });
          await saveDir(kitas);
          return json({ ok: true, binId: d.metadata.id, name });
        }

        if (action === "status") {
          const { name } = body;
          const kitas = await loadDir();
          const match = kitas.find(k => k.name.toLowerCase() === (name || "").toLowerCase());
          if (!match) return json({ ok: false, error: "Nicht gefunden." }, 404);
          const r = await fetch(`https://api.jsonbin.io/v3/b/${match.binId}/latest`, { headers: { "X-Master-Key": env.JSONBIN_API_KEY } });
          const d = await r.json();
          if (!d.record) return json({ ok: false, error: "Profil konnte nicht geladen werden." }, 500);
          return json({ ok: true, profile: d.record, binId: match.binId });
        }

        if (action === "list") {
          const kitas = await loadDir();
          return json({ ok: true, kitas });
        }

        if (action === "update_limit") {
          const { name, max_nutzer } = body;
          const kitas = await loadDir();
          const match = kitas.find(k => k.name.toLowerCase() === (name || "").toLowerCase());
          if (!match) return json({ ok: false, error: "Nicht gefunden." }, 404);
          const r = await fetch(`https://api.jsonbin.io/v3/b/${match.binId}/latest`, { headers: { "X-Master-Key": env.JSONBIN_API_KEY } });
          const d = await r.json();
          const updated = Object.assign({}, d.record, { max_nutzer });
          await fetch(`https://api.jsonbin.io/v3/b/${match.binId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-Master-Key": env.JSONBIN_API_KEY },
            body: JSON.stringify(updated)
          });
          return json({ ok: true });
        }

        if (action === "reset") {
          const { name } = body;
          const kitas = await loadDir();
          const match = kitas.find(k => k.name.toLowerCase() === (name || "").toLowerCase());
          if (!match) return json({ ok: false, error: "Nicht gefunden." }, 404);
          const r = await fetch(`https://api.jsonbin.io/v3/b/${match.binId}/latest`, { headers: { "X-Master-Key": env.JSONBIN_API_KEY } });
          const d = await r.json();
          const updated = Object.assign({}, d.record, { registrierte_geraete: [] });
          await fetch(`https://api.jsonbin.io/v3/b/${match.binId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-Master-Key": env.JSONBIN_API_KEY },
            body: JSON.stringify(updated)
          });
          return json({ ok: true });
        }

        return json({ ok: false, error: "Unbekannte Aktion." }, 400);
      }

      // ── KITA-JOIN ─────────────────────────────────────────────
      if (url.pathname === "/kita-join") {
        const body = await request.json();
        const kitaName = (body.name || "").trim();
        const deviceId = (body.device_id || "unknown").trim();

        if (!kitaName) return json({ ok: false, error: "Bitte den Namen der Einrichtung eingeben." }, 400);

        const dirRes = await fetch(`https://api.jsonbin.io/v3/b/${KITA_DIRECTORY_BIN_ID}/latest`, {
          headers: { "X-Master-Key": env.JSONBIN_API_KEY }
        });
        if (!dirRes.ok) return json({ ok: false, error: "Verzeichnis konnte nicht geladen werden." }, 500);

        const dirData = await dirRes.json();
        const kitas = Array.isArray(dirData.record?.kitas) ? dirData.record.kitas : [];
        const match = kitas.find(k => (k.name || "").trim().toLowerCase() === kitaName.toLowerCase());
        if (!match) return json({ ok: false, error: "Einrichtung nicht gefunden. Bitte den Namen genau wie von eurer Kita mitgeteilt eingeben." }, 404);

        const profRes = await fetch(`https://api.jsonbin.io/v3/b/${match.binId}/latest`, {
          headers: { "X-Master-Key": env.JSONBIN_API_KEY }
        });
        if (!profRes.ok) return json({ ok: false, error: "Profil dieser Einrichtung konnte nicht geladen werden." }, 404);

        const profile = (await profRes.json()).record || {};
        const maxNutzer = typeof profile.max_nutzer === "number" ? profile.max_nutzer : null;
        const geraete = Array.isArray(profile.registrierte_geraete) ? profile.registrierte_geraete : [];

        // KV-basierte Deduplication: verhindert Doppelzählung auch bei JSONBin-Caching
        const kvRegistered = await env.RATE_STORE.get(`kita-reg:${match.binId}:${deviceId}`);
        if (kvRegistered || geraete.includes(deviceId)) {
          await env.RATE_STORE.put(`kita:${deviceId}`, "1", { expirationTtl: 60 * 60 * 24 * 30 });
          await env.RATE_STORE.put(`kita-reg:${match.binId}:${deviceId}`, "1", { expirationTtl: 60 * 60 * 24 * 365 });
          return json({ ok: true, profile });
        }
        if (maxNutzer !== null && geraete.length >= maxNutzer) return json({ ok: false, error: "Das Kontingent dieser Kita ist erreicht." }, 403);

        // Set-Deduplication beim Schreiben
        const geraeteSet = new Set(geraete);
        geraeteSet.add(deviceId);
        const updatedProfile = Object.assign({}, profile, { registrierte_geraete: [...geraeteSet] });
        await fetch(`https://api.jsonbin.io/v3/b/${match.binId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Master-Key": env.JSONBIN_API_KEY },
          body: JSON.stringify(updatedProfile)
        });
        await env.RATE_STORE.put(`kita:${deviceId}`, "1", { expirationTtl: 60 * 60 * 24 * 30 });
        await env.RATE_STORE.put(`kita-reg:${match.binId}:${deviceId}`, "1", { expirationTtl: 60 * 60 * 24 * 365 });
        return json({ ok: true, profile: updatedProfile });
      }

      // ── ANTHROPIC PROXY ───────────────────────────────────────
      const deviceId = request.headers.get("x-device-id") || "unknown";
      const userAgent = request.headers.get("user-agent") || "";
      const today = new Date().toISOString().slice(0, 10);

      // Bot-Erkennung
      const { is_bot, signals } = detectBot(deviceId, userAgent);

      // Neues Gerät tracken
      const isKnown = await env.RATE_STORE.get(`device:known:${deviceId}`);
      if (!isKnown) {
        await env.RATE_STORE.put(`device:known:${deviceId}`, "1", { expirationTtl: 60 * 60 * 24 * 365 });
        // Gesamt-Counter hochzählen
        const total = parseInt(await env.RATE_STORE.get("stats:devices:total") || "0");
        await env.RATE_STORE.put("stats:devices:total", String(total + 1));
        // Heute neue Geräte
        const todayNew = parseInt(await env.RATE_STORE.get(`stats:devices:new:${today}`) || "0");
        await env.RATE_STORE.put(`stats:devices:new:${today}`, String(todayNew + 1), { expirationTtl: 60 * 60 * 24 * 30 });
      }

      // Tages-Request-Counter
      const todayReqs = parseInt(await env.RATE_STORE.get(`stats:requests:${today}`) || "0");
      await env.RATE_STORE.put(`stats:requests:${today}`, String(todayReqs + 1), { expirationTtl: 60 * 60 * 24 * 30 });

      // Bot-Counter
      if (is_bot) {
        const todayBots = parseInt(await env.RATE_STORE.get(`stats:bots:${today}`) || "0");
        await env.RATE_STORE.put(`stats:bots:${today}`, String(todayBots + 1), { expirationTtl: 60 * 60 * 24 * 30 });
      }

      // Rate Limit
      const rateLimitKey = `rate:${deviceId}:${today}`;
      const current = parseInt(await env.RATE_STORE.get(rateLimitKey) || "0");
      const isKitaMember = (await env.RATE_STORE.get(`kita:${deviceId}`)) === "1";
      const effectiveLimit = isKitaMember ? 50 : RATE_LIMIT;

      if (current >= effectiveLimit) return json({ error: "Tageslimit erreicht. Bitte morgen wieder versuchen." }, 429);
      await env.RATE_STORE.put(rateLimitKey, String(current + 1), { expirationTtl: 86400 });

      // Kita-Request-Counter
      if (isKitaMember) {
        const kitaReqs = parseInt(await env.RATE_STORE.get(`stats:kita_requests:${today}`) || "0");
        await env.RATE_STORE.put(`stats:kita_requests:${today}`, String(kitaReqs + 1), { expirationTtl: 60 * 60 * 24 * 30 });
      }

      const body = await request.json();
      const isStream = body.stream === true;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31"
        },
        body: JSON.stringify(body)
      });

      if (isStream) {
        return new Response(response.body, {
          status: response.status,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders }
        });
      }

      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};
