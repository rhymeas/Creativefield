/* Apply CreativeField's node presentation inside this editor tab only. ComfyUI's
   normal setting is saved on the worker, so keep this one preference in session
   storage while leaving every other request and setting untouched. */
(() => {
  const workspace = /^\/comfy\/([0-9a-f-]{36})(?:\/|$)/i.exec(location.pathname)?.[1];
  if (!workspace || typeof window.fetch !== 'function') return;
  const key = `creativefield.node-renderer.${workspace}`;
  const setting = 'Comfy.VueNodes.Enabled';
  let storage;
  try { storage = window.sessionStorage; storage.getItem(key); } catch { return; }
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href); }
    catch { return fetchOriginal(input, init); }
    if (url.origin !== location.origin) return fetchOriginal(input, init);
    const prefix = /^\/comfy\/([0-9a-f-]{36})(?=\/)/i.exec(url.pathname);
    if (prefix && prefix[1].toLowerCase() !== workspace.toLowerCase()) return fetchOriginal(input, init);
    const path = prefix ? url.pathname.slice(prefix[0].length) : url.pathname;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let decodedPath;
    try { decodedPath = decodeURIComponent(path); } catch { return fetchOriginal(input, init); }
    if (decodedPath === `/api/settings/${setting}` && method === 'GET') {
      const response = await fetchOriginal(input, init);
      if (!response.ok) return response;
      try {
        const stored = storage.getItem(key);
        return new Response(JSON.stringify(stored === 'false' ? false : true), {status: response.status, headers: {'content-type': 'application/json'}});
      } catch { return response; }
    }
    if (path === '/api/settings' && method === 'GET') {
      const response = await fetchOriginal(input, init);
      if (!response.ok) return response;
      try {
        const values = await response.clone().json();
        if (!values || typeof values !== 'object' || Array.isArray(values)) return response;
        const stored = storage.getItem(key);
        values[setting] = stored === 'false' ? false : true;
        const headers = new Headers(response.headers);
        for (const name of ['content-length', 'content-encoding', 'etag']) headers.delete(name);
        return new Response(JSON.stringify(values), {status: response.status, statusText: response.statusText, headers});
      } catch { return response; }
    }
    if (decodedPath === `/api/settings/${setting}` && method === 'POST') {
      try {
        const value = init?.body !== undefined ? JSON.parse(String(init.body)) : await input.clone().json();
        if (typeof value !== 'boolean') return new Response('Invalid node renderer setting', {status: 400});
        storage.setItem(key, String(value));
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}});
      } catch { return new Response('Could not save node renderer setting for this tab', {status: 503}); }
    }
    if (path === '/api/settings' && method === 'POST') {
      let values;
      try { values = init?.body !== undefined ? JSON.parse(String(init.body)) : await input.clone().json(); }
      catch { return fetchOriginal(input, init); }
      if (!values || typeof values !== 'object' || Array.isArray(values) || !(setting in values)) return fetchOriginal(input, init);
      if (typeof values[setting] !== 'boolean') return new Response('Invalid node renderer setting', {status: 400});
      try { storage.setItem(key, String(values[setting])); }
      catch { return new Response('Could not save node renderer setting for this tab', {status: 503}); }
      delete values[setting];
      if (!Object.keys(values).length) return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}});
      const modified = {...init, method: 'POST', body: JSON.stringify(values)};
      return fetchOriginal(input instanceof Request ? new Request(input, modified) : input, input instanceof Request ? undefined : modified);
    }
    return fetchOriginal(input, init);
  };
})();
