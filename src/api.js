// Tiny wrapper for the server API. The custom header is required by the server (blocks cross-site forms).
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'blockscape' },
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error((json && json.error) || 'Something went wrong. Please try again.');
    err.status = res.status;
    err.data = json;
    throw err;
  }
  return json;
}

// False on the plain GitHub Pages copy of the site (no server), true when the account server is there.
export async function accountsAvailable() {
  try {
    const res = await fetch('/api/me', { headers: { 'x-requested-with': 'blockscape' } });
    if (!res.ok) return false;
    const json = await res.json();
    return 'user' in json;
  } catch {
    return false;
  }
}
