// Revert the "YesChef LLM — Prod Overview" dashboard to the layout saved in
// dashboard-capacity-backup-2026-08-19.json (pre-regroup, 2026-08-19).
// Usage: node monitoring/dashboard-restore.mjs   (needs ADC with monitoring scope)
import { GoogleAuth } from "google-auth-library";
import fs from "node:fs";

const backup = JSON.parse(fs.readFileSync(new URL("./dashboard-capacity-backup-2026-08-19.json", import.meta.url), "utf8"));
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const token = (await (await auth.getClient()).getAccessToken()).token;
// The API requires the LIVE etag (optimistic lock) — the backup's is long stale, so fetch it first.
const live = await (await fetch(`https://monitoring.googleapis.com/v1/${backup.name}`, { headers: { Authorization: `Bearer ${token}` } })).json();
const body = { ...backup, etag: live.etag };
const r = await fetch(`https://monitoring.googleapis.com/v1/${backup.name}`, {
  method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const res = await r.json();
console.log(r.status, res.error?.message || `restored: ${res.displayName}, tiles=${res.mosaicLayout?.tiles?.length}`);
