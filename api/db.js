import { put, get, list } from '@vercel/blob';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vault-passphrase, x-pin-hash, x-pin-salt, x-pin-len, x-pin-disable, x-updated-at');

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

  // Helper to read blob text and metadata
  async function readBlobContent() {
    // 1. Try modern get() for private access
    try {
      const getRes = await get(BLOB_FILENAME, { access: 'private', useCache: false, token });
      if (getRes && getRes.stream) {
        const text = await new Response(getRes.stream).text();
        return {
          text,
          updatedAt: getRes.blob?.uploadedAt || new Date().toISOString(),
          size: getRes.blob?.size || text.length
        };
      }
    } catch (_) {}

    // Fallback to list() + authenticated fetch
    const { blobs } = await list({ prefix: BLOB_FILENAME, token });
    const matched = blobs.find(b => b.pathname === BLOB_FILENAME) || blobs[0];
    if (!matched) return null;

    const blobHeaders = {};
    if (token) blobHeaders['Authorization'] = `Bearer ${token}`;
    const targetUrl = matched.downloadUrl || matched.url;
    const blobRes = await fetch(targetUrl + (targetUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), {
      headers: blobHeaders,
      cache: 'no-store'
    });
    if (!blobRes.ok) throw new Error(`Failed to fetch blob content: ${blobRes.status} ${blobRes.statusText}`);
    const text = await blobRes.text();
    return {
      text,
      updatedAt: matched.uploadedAt,
      size: matched.size
    };
  }

  // GET: Fetch the latest database from Vercel Blob
  if (req.method === 'GET') {
    try {
      const blobResult = await readBlobContent();
      if (!blobResult || !blobResult.text) {
        return res.status(404).json({
          error: 'No database found in Blob storage yet.',
          empty: true
        });
      }

      let parsed;
      try {
        parsed = JSON.parse(blobResult.text);
      } catch (_) {
        parsed = blobResult.text;
      }

      // Check if store is wrapped in a Master PIN security envelope
      const hasSecurity = parsed && typeof parsed === 'object' && parsed._security && parsed._security.pinHash;
      if (hasSecurity) {
        const clientPinHash = req.headers['x-pin-hash'];
        if (!clientPinHash || clientPinHash !== parsed._security.pinHash) {
          // Reject with requiresPin so the client can prompt the user for their PIN
          return res.status(200).json({
            requiresPin: true,
            pinSalt: parsed._security.pinSalt,
            pinLen: parsed._security.pinLen || 4
          });
        }
        // Verified PIN: return actual database
        const payloadData = parsed.data;
        const dataUpdatedAt = (payloadData && typeof payloadData === 'object' && payloadData.updatedAt)
          ? payloadData.updatedAt
          : (parsed.updatedAt || blobResult.updatedAt);
        return res.status(200).json({
          data: payloadData,
          updatedAt: dataUpdatedAt,
          blobUploadedAt: blobResult.updatedAt,
          size: blobResult.size,
          isSealed: true
        });
      }

      // Plain un-enveloped database (legacy format)
      const dataUpdatedAt = (parsed && typeof parsed === 'object' && parsed.updatedAt)
        ? parsed.updatedAt
        : blobResult.updatedAt;
      return res.status(200).json({
        data: parsed,
        updatedAt: dataUpdatedAt,
        blobUploadedAt: blobResult.updatedAt,
        size: blobResult.size,
        _legacyPlain: true
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

      let parsedBody = typeof body === 'string' ? JSON.parse(body) : body;

      // Extract PIN security headers if provided by client
      const pinHash = req.headers['x-pin-hash'];
      const pinSalt = req.headers['x-pin-salt'];
      const pinLen = parseInt(req.headers['x-pin-len'] || '4', 10);
      const isPinDisable = req.headers['x-pin-disable'] === 'true';

      // Verify authorization if existing blob is protected
      try {
        const existing = await readBlobContent();
        if (existing && existing.text) {
          let existingParsed = JSON.parse(existing.text);
          if (existingParsed && existingParsed._security && existingParsed._security.pinHash) {
            if (existingParsed._security.pinHash !== pinHash) {
              return res.status(401).json({ error: 'Unauthorized: Valid Master PIN is required to update database.' });
            }
          }
        }
      } catch (_) {}

      const effectiveUpdatedAt = req.headers['x-updated-at'] || parsedBody.updatedAt || parsedBody.data?.updatedAt || new Date().toISOString();

      let contentToSave;
      if (!isPinDisable && pinHash && pinSalt) {
        contentToSave = JSON.stringify({
          _security: {
            pinHash,
            pinSalt,
            pinLen
          },
          updatedAt: effectiveUpdatedAt,
          data: parsedBody.data || parsedBody
        }, null, 2);
      } else {
        const payloadToSave = parsedBody.data || parsedBody;
        if (payloadToSave && typeof payloadToSave === 'object') {
          payloadToSave.updatedAt = effectiveUpdatedAt;
        }
        contentToSave = JSON.stringify(payloadToSave, null, 2);
      }

      let blob = await put(BLOB_FILENAME, contentToSave, {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        token
      });

      return res.status(200).json({
        success: true,
        url: blob.url,
        updatedAt: effectiveUpdatedAt,
        blobUploadedAt: blob.uploadedAt,
        size: contentToSave.length
      });
    } catch (err) {
      console.error('Blob POST error:', err);
      return res.status(500).json({ error: err.message || 'Failed to write to Blob storage' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
