export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`expected JSON from ${url}, got ${body ? body.slice(0, 500) : "empty response"}: ${error.message}`);
  }
}

export async function fetchJsonWithTimeout(url, options = {}, timeoutSec = 60) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    return await fetchJson(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`timeout after ${timeoutSec}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
