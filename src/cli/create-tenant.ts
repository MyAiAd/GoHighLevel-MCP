#!/usr/bin/env node
import crypto from "crypto";
import readline from "readline";
import { Pool } from "pg";

type Answers = {
  name: string;
  label: string;
  ghlApiKey?: string;
  ghlLocationId?: string;
  ghlBaseUrl?: string;
  ghlVersion?: string;
};

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function genApiKey() {
  // 24 bytes -> 48 hex chars (nice “Stripe-ish” length)
  return crypto.randomBytes(24).toString("hex");
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("❌ Missing DATABASE_URL env var");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });

  try {
    const name = await ask("Tenant name (company): ");
    if (!name) throw new Error("Tenant name is required.");

    const label = (await ask("API key label [primary]: ")) || "primary";

    const ghlApiKey = await ask("GHL API key (press Enter to skip for now): ");
    const ghlLocationId = await ask("GHL Location ID (press Enter to skip for now): ");

    // Optional overrides (rarely needed; press Enter to keep defaults)
    const ghlBaseUrl =
      (await ask("GHL Base URL [https://services.leadconnectorhq.com]: ")) ||
      "https://services.leadconnectorhq.com";
    const ghlVersion = (await ask("GHL Version [2021-07-28]: ")) || "2021-07-28";

    const rawKey = genApiKey();
    const keyHash = sha256Hex(rawKey);

    // One transaction so we don't end up half-created.
    await pool.query("begin");

    // 1) create tenant
    const tenantRes = await pool.query(
      `insert into tenants (name) values ($1) returning id`,
      [name]
    );
    const tenantId = tenantRes.rows[0].id as string;

    // 2) store hashed API key
    await pool.query(
      `insert into api_keys (tenant_id, key_hash, label) values ($1, $2, $3)`,
      [tenantId, keyHash, label]
    );

    // 3) store tenant secrets if provided (both required together)
    if (ghlApiKey || ghlLocationId) {
      if (!ghlApiKey || !ghlLocationId) {
        throw new Error("If you provide GHL credentials, you must provide BOTH API key and Location ID.");
      }

      await pool.query(
        `
        insert into tenant_secrets (tenant_id, ghl_api_key, ghl_location_id, ghl_base_url, ghl_version)
        values ($1, $2, $3, $4, $5)
        on conflict (tenant_id)
        do update set
          ghl_api_key = excluded.ghl_api_key,
          ghl_location_id = excluded.ghl_location_id,
          ghl_base_url = excluded.ghl_base_url,
          ghl_version = excluded.ghl_version,
          updated_at = now()
        `,
        [tenantId, ghlApiKey, ghlLocationId, ghlBaseUrl, ghlVersion]
      );
    }

    await pool.query("commit");

    // Output: RAW KEY ONLY ONCE
    console.log("\n✅ Tenant created!");
    console.log("--------------------------------------------------");
    console.log(`Tenant:     ${name}`);
    console.log(`Tenant ID:  ${tenantId}`);
    console.log(`Key label:  ${label}`);
    console.log("\n🔑 API Key (SAVE THIS NOW — it will not be shown again):");
    console.log(rawKey);
    console.log("\n📌 n8n Header:");
    console.log(`Authorization: Bearer ${rawKey}`);
    console.log("\n📍 Execute endpoint:");
    console.log("POST /api/execute  (use your deployed base URL)");
    console.log("--------------------------------------------------\n");

    if (!ghlApiKey || !ghlLocationId) {
      console.log("ℹ️  Note: You skipped tenant_secrets. This tenant will only work if your server has env GHL_API_KEY + GHL_LOCATION_ID set (single-tenant fallback).");
    }
  } catch (err: any) {
    try {
      await pool.query("rollback");
    } catch {}
    console.error("\n❌ create-tenant failed:", err?.message ?? err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
