import { put, get, list } from '@vercel/blob';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vault-passphrase, x-pin-hash');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const authHeader = req.headers.authorization || req.headers['x-blob-token'];
  const clientToken = (authHeader && typeof authHeader === 'string')
    ? (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim())
    : null;
  const token = process.env.BLOB_READ_WRITE_TOKEN || clientToken;
  if (!token) {
    return res.status(500).json({
      error: 'Vercel Blob storage is not connected. Either connect your Blob store to project in Vercel & redeploy, or paste the Blob Token in Settings.'
    });
  }

  const BLOB_FILENAME = 'rupay-perks-data.json';

  // GET: Fetch the latest database from Vercel Blob
  if (req.method === 'GET') {
    try {
      let text = null;
      let updatedAt = null;
      let size = 0;

      // 1. Try modern get() for private access
      try {
        const getRes = await get(BLOB_FILENAME, { access: 'private', useCache: false, token });
        if (getRes && getRes.stream) {
          text = await new Response(getRes.stream).text();
          updatedAt = getRes.blob?.uploadedAt || new Date().toISOString();
          size = getRes.blob?.size || text.length;
        }
      } catch (getErr) {
        // Fallback to list() + authenticated fetch
        const { blobs } = await list({ prefix: BLOB_FILENAME, token });
        const matched = blobs.find(b => b.pathname === BLOB_FILENAME) || blobs[0];

        if (!matched) {
          return res.status(404).json({
            error: 'No database found in Blob storage yet.',
            empty: true
          });
        }

        const blobHeaders = {};
        if (token) blobHeaders['Authorization'] = `Bearer ${token}`;
        const targetUrl = matched.downloadUrl || matched.url;
        const blobRes = await fetch(targetUrl + (targetUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), {
          headers: blobHeaders,
          cache: 'no-store'
        });
        if (!blobRes.ok) throw new Error(`Failed to fetch blob content: ${blobRes.status} ${blobRes.statusText}`);
        text = await blobRes.text();
        updatedAt = matched.uploadedAt;
        size = matched.size;
      }

      if (!text) {
        return res.status(404).json({
          error: 'No database found in Blob storage yet.',
          empty: true
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        parsed = text;
      }

      return res.status(200).json({
        data: parsed,
        updatedAt,
        size
      });
    } catch (err) {
      console.error('Blob GET error:', err);
      return res.status(500).json({ error: err.message || 'Failed to read from Blob storage' });
    }
  }

  // POST: Write database to Vercel Blob
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (!body) {
        return res.status(400).json({ error: 'Request body is required.' });
      }

      let content;
      if (typeof body === 'string') {
        content = body;
      } else {
        content = JSON.stringify(body, null, 2);
      }

      // Upload with access: 'private' and allowOverwrite: true
      let blob;
      try {
        blob = await put(BLOB_FILENAME, content, {
          access: 'private',
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: 'application/json',
          token
        });
      } catch (err) {
        // Fallback to access: 'public' ONLY if store is specifically configured as a public store
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('public store') || msg.includes('cannot use private access on a public store')) {
          blob = await put(BLOB_FILENAME, content, {
            access: 'public',
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: 'application/json',
            token
          });
        } else {
          throw err;
        }
      }

      return res.status(200).json({
        success: true,
        url: blob.url,
        updatedAt: blob.uploadedAt,
        size: content.length
      });
    } catch (err) {
      console.error('Blob POST error:', err);
      return res.status(500).json({ error: err.message || 'Failed to write to Blob storage' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
