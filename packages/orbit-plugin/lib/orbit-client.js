/**
 * OrbitClient — HTTP client for the Orbit API.
 * Extracted from the original openclaw-plugin for reuse.
 */

const DEFAULT_API_URL = "https://orbit-mu-roan.vercel.app/api/v1";

export class OrbitClient {
  constructor(apiKey, baseUrl) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || process.env.ORBIT_API_URL || DEFAULT_API_URL;
  }

  async get(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Orbit API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async post(path, body) {
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Orbit API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async patch(path, body) {
    const res = await fetch(this.baseUrl + path, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Orbit API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

export function asToolText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

export function toolError(msg) {
  return { content: [{ type: "text", text: "orbit: " + msg }], isError: true };
}
