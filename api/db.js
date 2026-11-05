import { put, list, del } from '@vercel/blob';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vault-passphrase, x-pin-hash');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'Vercel Blob storage is not connected. Missing BLOB_READ_WRITE_TOKEN in environment.'
    });
  }

  const BLOB_FILENAME = 'rupay-perks-data.json';

  // GET: Fetch the latest database from Vercel Blob
  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: BLOB_FILENAME, token });
      const matched = blobs.find(b => b.pathname === BLOB_FILENAME) || blobs[0];

      if (!matched) {
        return res.status(404).json({
          error: 'No database found in Blob storage yet.',
          empty: true
        });
      }

      const blobRes = await fetch(matched.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!blobRes.ok) {
        throw new Error(`Failed to fetch blob content: ${blobRes.status} ${blobRes.statusText}`);
      }

      const text = await blobRes.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        parsed = text;
      }

      return res.status(200).json({
        data: parsed,
        updatedAt: matched.uploadedAt,
        size: matched.size
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

      const blob = await put(BLOB_FILENAME, content, {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'application/json',
        token
      });

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
